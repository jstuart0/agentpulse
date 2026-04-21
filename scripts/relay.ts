#!/usr/bin/env bun
import {
	access,
	constants,
	mkdir,
	readFile,
	readdir,
	rename,
	unlink,
	writeFile,
} from "fs/promises";
import { join } from "path";

const args = process.argv.slice(2);
let remoteUrl = "", port = 4000, apiKey = "";
const RELAY_FETCH_TIMEOUT_MS = 8_000;
const RELAY_IDLE_TIMEOUT_S = 30;
const HOOK_RETRY_BASE_MS = 2_000;
const HOOK_RETRY_MAX_MS = 60_000;
const HOOK_RETRY_POLL_MS = 5_000;

for (let i = 0; i < args.length; i++) {
	if (args[i] === "--port" && args[i + 1]) port = Number(args[++i]);
	else if (args[i] === "--key" && args[i + 1]) apiKey = args[++i];
	else if (!args[i].startsWith("--")) remoteUrl = args[i].replace(/\/$/, "");
}
if (!remoteUrl) {
	console.error("Usage: relay.ts <url> [--port N] [--key K]");
	process.exit(1);
}

const relayDir = import.meta.dir;
const hookQueueDir = join(relayDir, "hook-queue");
const hookPendingDir = join(hookQueueDir, "pending");
const hookProcessingDir = join(hookQueueDir, "processing");

type HookQueueItem = {
	id: string;
	pathname: string;
	search: string;
	method: string;
	contentType: string;
	agentType: string | null;
	body: string;
	createdAt: string;
	attempts: number;
	nextAttemptAt: string;
	lastError: string | null;
};

const relayState = {
	lastHookEnqueuedAt: null as string | null,
	lastHookForwardedAt: null as string | null,
	lastHookFailureAt: null as string | null,
	lastHookError: null as string | null,
	consecutiveHookFailures: 0,
};

let queueRunning = false;
let queueScheduled = false;
let queueTimer: ReturnType<typeof setTimeout> | null = null;

async function fileExists(path: string) {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function ensureQueueDirs() {
	await mkdir(hookPendingDir, { recursive: true });
	await mkdir(hookProcessingDir, { recursive: true });
}

async function computeChecksum(content: string): Promise<string> {
	const data = new TextEncoder().encode(content);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 16);
}

function authHeaders(): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	return headers;
}

async function uploadClaudeMd(sessionId: string, cwd: string, agentType?: string) {
	const files =
		agentType === "codex_cli" ? ["AGENTS.md", "CLAUDE.md"] : ["CLAUDE.md", "AGENTS.md"];
	for (const name of files) {
		const filePath = join(cwd, name);
		if (!(await fileExists(filePath))) continue;
		try {
			const content = await readFile(filePath, "utf-8");
			const checksum = await computeChecksum(content);
			await fetch(`${remoteUrl}/api/v1/sessions/${sessionId}/claude-md`, {
				method: "PUT",
				headers: authHeaders(),
				body: JSON.stringify({ content, path: filePath, checksum }),
				signal: AbortSignal.timeout(5_000),
			});
			console.log(
				`[sync] Uploaded ${name} for ${sessionId} (${(content.length / 1024).toFixed(1)}KB)`,
			);
		} catch {}
		return;
	}
}

const localChecksums = new Map<string, string>();

async function syncClaudeMdToDisk() {
	try {
		const res = await fetch(`${remoteUrl}/api/v1/sessions?limit=20`, {
			headers: authHeaders(),
			signal: AbortSignal.timeout(5_000),
		});
		const data = (await res.json()) as {
			sessions: Array<{
				sessionId: string;
				cwd?: string;
				claudeMdPath?: string;
				claudeMdChecksum?: string;
			}>;
		};

		for (const session of data.sessions || []) {
			if (!session.claudeMdChecksum && session.cwd) {
				uploadClaudeMd(session.sessionId, session.cwd).catch(() => {});
				continue;
			}

			if (!session.claudeMdPath || !session.claudeMdChecksum) continue;

			const lastKnown = localChecksums.get(session.sessionId);
			if (lastKnown === session.claudeMdChecksum) continue;

			const mdRes = await fetch(`${remoteUrl}/api/v1/sessions/${session.sessionId}/claude-md`, {
				headers: authHeaders(),
				signal: AbortSignal.timeout(5_000),
			});
			const mdData = (await mdRes.json()) as { content: string; path: string; checksum: string };
			if (!mdData.content || !mdData.path) continue;

			let localContent = "";
			try {
				localContent = await readFile(mdData.path, "utf-8");
			} catch {}
			const localChecksum = localContent ? await computeChecksum(localContent) : "";

			if (localChecksum === mdData.checksum) {
				localChecksums.set(session.sessionId, mdData.checksum);
				continue;
			}

			if (lastKnown && localChecksum !== lastKnown) {
				console.log(`[sync] Conflict on ${mdData.path} -- server version wins`);
			}

			await writeFile(mdData.path, mdData.content, "utf-8");
			localChecksums.set(session.sessionId, mdData.checksum);
			console.log(
				`[sync] Wrote ${mdData.path} from server (${(mdData.content.length / 1024).toFixed(1)}KB)`,
			);
		}
	} catch {}
}

async function forwardApiRequest(input: {
	pathname: string;
	search: string;
	method: string;
	contentType: string;
	agentType?: string | null;
	body?: string;
}) {
	const headers = new Headers();
	headers.set("Content-Type", input.contentType || "application/json");
	if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
	if (input.agentType) headers.set("X-Agent-Type", input.agentType);

	const response = await fetch(`${remoteUrl}${input.pathname}${input.search}`, {
		method: input.method,
		headers,
		body: input.method !== "GET" ? input.body : undefined,
		signal: AbortSignal.timeout(RELAY_FETCH_TIMEOUT_MS),
	});

	return new Response(await response.text(), {
		status: response.status,
		headers: {
			"Content-Type": response.headers.get("Content-Type") || "application/json",
		},
	});
}

function nextBackoffMs(attempts: number) {
	return Math.min(HOOK_RETRY_MAX_MS, HOOK_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

function scheduleQueue(delayMs = 0) {
	if (queueTimer) clearTimeout(queueTimer);
	queueScheduled = true;
	queueTimer = setTimeout(() => {
		queueTimer = null;
		void processHookQueue();
	}, delayMs);
}

async function enqueueHook(req: Request, url: URL) {
	await ensureQueueDirs();
	const body = await req.text();
	const item: HookQueueItem = {
		id: crypto.randomUUID(),
		pathname: url.pathname,
		search: url.search,
		method: req.method,
		contentType: req.headers.get("Content-Type") || "application/json",
		agentType: req.headers.get("X-Agent-Type"),
		body,
		createdAt: new Date().toISOString(),
		attempts: 0,
		nextAttemptAt: new Date().toISOString(),
		lastError: null,
	};

	const fileName = `${Date.now()}-${item.id}.json`;
	await writeFile(join(hookPendingDir, fileName), JSON.stringify(item), "utf-8");
	relayState.lastHookEnqueuedAt = item.createdAt;
	scheduleQueue();

	try {
		const payload = JSON.parse(body) as { hook_event_name?: string; session_id?: string; cwd?: string };
		if (url.pathname === "/api/v1/hooks" && payload.hook_event_name === "SessionStart" && payload.cwd) {
			uploadClaudeMd(payload.session_id || "", payload.cwd, item.agentType || undefined).catch(() => {});
		}
	} catch {}

	return { queued: true, queueId: item.id };
}

async function leaseNextHook(): Promise<{ fileName: string; item: HookQueueItem } | null> {
	await ensureQueueDirs();
	const fileNames = (await readdir(hookPendingDir)).filter((name) => name.endsWith(".json")).sort();
	const now = Date.now();

	for (const fileName of fileNames) {
		const pendingPath = join(hookPendingDir, fileName);
		try {
			const raw = await readFile(pendingPath, "utf-8");
			const item = JSON.parse(raw) as HookQueueItem;
			if (Date.parse(item.nextAttemptAt) > now) continue;
			const processingPath = join(hookProcessingDir, fileName);
			await rename(pendingPath, processingPath);
			return { fileName, item };
		} catch (error) {
			console.error("[relay] Failed to lease queued hook:", error);
			try {
				await unlink(pendingPath);
			} catch {}
		}
	}

	return null;
}

async function releaseHookFailure(fileName: string, item: HookQueueItem, error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	const updated: HookQueueItem = {
		...item,
		attempts: item.attempts + 1,
		lastError: message,
		nextAttemptAt: new Date(Date.now() + nextBackoffMs(item.attempts + 1)).toISOString(),
	};

	try {
		await writeFile(join(hookPendingDir, fileName), JSON.stringify(updated), "utf-8");
	} finally {
		try {
			await unlink(join(hookProcessingDir, fileName));
		} catch {}
	}

	relayState.lastHookFailureAt = new Date().toISOString();
	relayState.lastHookError = message;
	relayState.consecutiveHookFailures += 1;
	console.error(`[relay] Hook forward failed (${updated.attempts} attempts): ${message}`);
	scheduleQueue(nextBackoffMs(updated.attempts));
}

async function completeHookSuccess(fileName: string) {
	try {
		await unlink(join(hookProcessingDir, fileName));
	} catch {}
	relayState.lastHookForwardedAt = new Date().toISOString();
	relayState.lastHookError = null;
	relayState.consecutiveHookFailures = 0;
}

async function processHookQueue() {
	if (queueRunning) return;
	queueRunning = true;
	queueScheduled = false;

	try {
		while (true) {
			const leased = await leaseNextHook();
			if (!leased) break;

			try {
				await forwardApiRequest({
					pathname: leased.item.pathname,
					search: leased.item.search,
					method: leased.item.method,
					contentType: leased.item.contentType,
					agentType: leased.item.agentType,
					body: leased.item.body,
				});
				await completeHookSuccess(leased.fileName);
			} catch (error) {
				await releaseHookFailure(leased.fileName, leased.item, error);
			}
		}
	} finally {
		queueRunning = false;
	}
}

async function getQueueDiagnostics() {
	await ensureQueueDirs();
	const pending = (await readdir(hookPendingDir)).filter((name) => name.endsWith(".json"));
	const processing = (await readdir(hookProcessingDir)).filter((name) => name.endsWith(".json"));
	let oldestPendingAt: string | null = null;

	for (const fileName of pending) {
		try {
			const item = JSON.parse(await readFile(join(hookPendingDir, fileName), "utf-8")) as HookQueueItem;
			if (!oldestPendingAt || item.createdAt < oldestPendingAt) oldestPendingAt = item.createdAt;
		} catch {}
	}

	return {
		pending: pending.length,
		processing: processing.length,
		oldestPendingAt,
		lastHookEnqueuedAt: relayState.lastHookEnqueuedAt,
		lastHookForwardedAt: relayState.lastHookForwardedAt,
		lastHookFailureAt: relayState.lastHookFailureAt,
		lastHookError: relayState.lastHookError,
		consecutiveHookFailures: relayState.consecutiveHookFailures,
	};
}

Bun.serve({
	port,
	hostname: "127.0.0.1",
	idleTimeout: RELAY_IDLE_TIMEOUT_S,
	async fetch(req) {
		const url = new URL(req.url);

		if (url.pathname === "/api/v1/health") {
			return Response.json({ status: "ok", relay: true, remote: remoteUrl });
		}

		if (url.pathname === "/api/v1/relay/diagnostics") {
			return Response.json({
				status: "ok",
				relay: true,
				remote: remoteUrl,
				queue: await getQueueDiagnostics(),
			});
		}

		if (url.pathname.startsWith("/api/v1/hooks")) {
			const queued = await enqueueHook(req, url);
			return Response.json({ ok: true, relayed: false, ...queued });
		}

		if (url.pathname.startsWith("/api/")) {
			try {
				return await forwardApiRequest({
					pathname: url.pathname,
					search: url.search,
					method: req.method,
					contentType: req.headers.get("Content-Type") || "application/json",
					agentType: req.headers.get("X-Agent-Type"),
					body: req.method !== "GET" ? await req.text() : undefined,
				});
			} catch {
				return Response.json({ error: "Relay failed" }, { status: 502 });
			}
		}

		return Response.json({
			message: "AgentPulse Relay",
			dashboard: remoteUrl,
			hint: `Open ${remoteUrl} in your browser for the dashboard`,
		});
	},
});

setInterval(syncClaudeMdToDisk, 30_000);
setInterval(() => {
	void processHookQueue();
}, HOOK_RETRY_POLL_MS);

void ensureQueueDirs().then(() => {
	scheduleQueue(250);
});

console.log("");
console.log("  AgentPulse Relay");
console.log("  ────────────────");
console.log(`  Local:     http://localhost:${port} (hook forwarding)`);
console.log(`  Remote:    ${remoteUrl} (dashboard)`);
console.log("  Queue:     disk-backed hook queue with background retry");
console.log("  Sync:      CLAUDE.md synced every 30s");
console.log(`  Auth:      ${apiKey ? "API key" : "none"}`);
console.log("");
