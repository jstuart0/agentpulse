#!/usr/bin/env bun
import { readFile, writeFile, access } from "fs/promises";
import { constants } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
let remoteUrl = "", port = 4000, apiKey = "";
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--port" && args[i + 1]) port = Number(args[++i]);
	else if (args[i] === "--key" && args[i + 1]) apiKey = args[++i];
	else if (!args[i].startsWith("--")) remoteUrl = args[i].replace(/\/$/, "");
}
if (!remoteUrl) {
	console.error("Usage: relay.ts <url> [--port N] [--key K]");
	process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────

async function fileExists(p: string) {
	try { await access(p, constants.F_OK); return true; } catch { return false; }
}

async function computeChecksum(content: string): Promise<string> {
	const data = new TextEncoder().encode(content);
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

function authHeaders(): Record<string, string> {
	const h: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey) h.Authorization = `Bearer ${apiKey}`;
	return h;
}

// ── Upload CLAUDE.md to server on session start ─────────────────────

async function uploadClaudeMd(sessionId: string, cwd: string, agentType?: string) {
	// Codex uses AGENTS.md, Claude Code uses CLAUDE.md -- check the right one first
	const files = agentType === "codex_cli"
		? ["AGENTS.md", "CLAUDE.md"]
		: ["CLAUDE.md", "AGENTS.md"];
	for (const name of files) {
		const filePath = join(cwd, name);
		if (await fileExists(filePath)) {
			try {
				const content = await readFile(filePath, "utf-8");
				const checksum = await computeChecksum(content);
				await fetch(`${remoteUrl}/api/v1/sessions/${sessionId}/claude-md`, {
					method: "PUT",
					headers: authHeaders(),
					body: JSON.stringify({ content, path: filePath, checksum }),
					signal: AbortSignal.timeout(5000),
				});
				console.log(`[sync] Uploaded ${name} for ${sessionId} (${(content.length / 1024).toFixed(1)}KB)`);
			} catch {}
			return; // Use the first file found
		}
	}
}

// ── Sync changes from server back to disk ───────────────────────────

// Track checksums we've seen so we know when the server version changed
const localChecksums = new Map<string, string>();

async function syncClaudeMdToDisk() {
	try {
		const res = await fetch(`${remoteUrl}/api/v1/sessions?limit=20`, {
			headers: authHeaders(),
			signal: AbortSignal.timeout(5000),
		});
		const data = await res.json() as { sessions: Array<{ sessionId: string; cwd?: string; status?: string; claudeMdPath?: string; claudeMdChecksum?: string; claudeMdContent?: string }> };

		for (const session of data.sessions || []) {
			// Backfill: if session has a cwd but no CLAUDE.md uploaded yet, upload it now
			if (!session.claudeMdChecksum && session.cwd) {
				uploadClaudeMd(session.sessionId, session.cwd).catch(() => {});
				continue;
			}

			if (!session.claudeMdPath || !session.claudeMdChecksum) continue;

			const lastKnown = localChecksums.get(session.sessionId);
			if (lastKnown === session.claudeMdChecksum) continue; // No change

			// Checksum changed -- fetch full content and write to disk
			const mdRes = await fetch(`${remoteUrl}/api/v1/sessions/${session.sessionId}/claude-md`, {
				headers: authHeaders(),
				signal: AbortSignal.timeout(5000),
			});
			const mdData = await mdRes.json() as { content: string; path: string; checksum: string };

			if (!mdData.content || !mdData.path) continue;

			// Check if local file has been modified independently
			let localContent = "";
			try { localContent = await readFile(mdData.path, "utf-8"); } catch {}
			const localChecksum = localContent ? await computeChecksum(localContent) : "";

			if (localChecksum === mdData.checksum) {
				// Already in sync
				localChecksums.set(session.sessionId, mdData.checksum);
				continue;
			}

			if (lastKnown && localChecksum !== lastKnown) {
				// Local file was also modified -- server wins but log the conflict
				console.log(`[sync] Conflict on ${mdData.path} -- server version wins`);
			}

			// Write server version to disk
			await writeFile(mdData.path, mdData.content, "utf-8");
			localChecksums.set(session.sessionId, mdData.checksum);
			console.log(`[sync] Wrote ${mdData.path} from server (${(mdData.content.length / 1024).toFixed(1)}KB)`);
		}
	} catch {
		// Sync failures are silent
	}
}

// ── Forward to remote ───────────────────────────────────────────────

async function forwardToRemote(req: Request, url: URL): Promise<Response> {
	const headers = new Headers();
	headers.set("Content-Type", req.headers.get("Content-Type") || "application/json");
	if (apiKey) headers.set("Authorization", "Bearer " + apiKey);
	const at = req.headers.get("X-Agent-Type");
	if (at) headers.set("X-Agent-Type", at);
	const body = req.method !== "GET" ? await req.text() : undefined;

	const res = await fetch(remoteUrl + url.pathname + url.search, {
		method: req.method, headers, body,
		signal: AbortSignal.timeout(10000),
	});
	return new Response(await res.text(), {
		status: res.status,
		headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" },
	});
}

// ── Server ──────────────────────────────────────────────────────────

Bun.serve({
	port,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);

		if (url.pathname === "/api/v1/health") {
			return Response.json({ status: "ok", relay: true, remote: remoteUrl });
		}

		// Forward all API calls to remote
		if (url.pathname.startsWith("/api/")) {
			try {
				const response = await forwardToRemote(req, url);

				// After forwarding a hook event, check if it's a SessionStart
				// and upload the CLAUDE.md from that directory
				if (url.pathname === "/api/v1/hooks" && req.method === "POST") {
					try {
						const bodyText = await req.clone().text();
						const payload = JSON.parse(bodyText);
						const agentType = req.headers.get("X-Agent-Type") || undefined;
						if (payload.hook_event_name === "SessionStart" && payload.cwd) {
							uploadClaudeMd(payload.session_id, payload.cwd, agentType).catch(() => {});
						}
					} catch {}
				}

				return response;
			} catch {
				if (url.pathname.includes("/hooks"))
					return Response.json({ ok: true, relayed: false });
				return Response.json({ error: "Relay failed" }, { status: 502 });
			}
		}

		// Non-API routes -- relay is not a frontend server
		return Response.json({
			message: "AgentPulse Relay",
			dashboard: remoteUrl,
			hint: `Open ${remoteUrl} in your browser for the dashboard`,
		});
	},
});

// Sync CLAUDE.md changes from server to disk every 30 seconds
setInterval(syncClaudeMdToDisk, 30_000);

console.log("");
console.log(`  AgentPulse Relay`);
console.log(`  ────────────────`);
console.log(`  Local:     http://localhost:${port} (hook forwarding)`);
console.log(`  Remote:    ${remoteUrl} (dashboard)`);
console.log(`  Sync:      CLAUDE.md synced every 30s`);
console.log(`  Auth:      ${apiKey ? "API key" : "none"}`);
console.log("");
