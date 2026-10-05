#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * AGEN-69: try the session Summary tab by hand.
 *
 *   bun run build                                   # the server serves the built UI
 *   bun scripts/session-summary-dev-seed.ts         # then open the printed address
 *
 * One command starts the stub model provider and a throwaway AgentPulse server on a scratch
 * database (loopback only, auth off, telemetry off), points a provider at the stub, and seeds
 * sessions:
 *
 *   demo-ready      a summary already made
 *   demo-stale      a summary already made, then the session moved on
 *   demo-fresh      plenty of activity, no summary yet (click "Summarize this session")
 *   demo-too-little just started: the Summary tab says there is nothing to summarize yet
 *
 * The Labs flag is left OFF so you can try "Turn on" on a session's AI tab. `--flag-on` turns it
 * on up front. `--hold-ms <n>` keeps the stub's next answer for n milliseconds so the generating
 * state stays on screen (default 15000; 0 answers at once).
 *
 * `AGENTPULSE_URL` seeds an already-running server instead of starting one. A non-loopback URL is
 * refused unless `--allow-remote`: the stub provider only listens on this machine, and sessions
 * would be written to a server that isn't a throwaway.
 */
import { type Subprocess, spawn } from "bun";
import { startLlmStubServer } from "../src/server/test-utils/llm-stub-server.js";

const REPO_ROOT = join(import.meta.dir, "..");
const DEFAULT_PORT = 3199;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const STUB_KEY = "stub-provider-key-not-a-secret";
const READY_TIMEOUT_MS = 30_000;
const GENERATION_TIMEOUT_MS = 60_000;
const DEFAULT_HOLD_MS = 15_000;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string): string | null => {
	const at = args.indexOf(name);
	return at >= 0 && args[at + 1] ? args[at + 1] : null;
};

function refuseNonLoopback(raw: string): URL {
	const url = new URL(raw);
	if (!LOOPBACK_HOSTS.has(url.hostname) && !flag("--allow-remote")) {
		console.error(
			`Refusing ${url.origin}: it isn't a loopback address. This script seeds sessions and points a provider at a stub that only listens on this machine. Pass --allow-remote if you mean it.`,
		);
		process.exit(2);
	}
	return url;
}

// ── what the model "says" ────────────────────────────────────────────────────

/** The ids of the events a summary can cite, as the server numbered them for one seeded session. */
interface CitableEvents {
	prompt: number;
	created: number;
	edited: number;
	tested: number;
}

/**
 * What the stub model answers. Evidence ids are event ids, which differ per session, so the answer
 * is built for the session it will be read against; with none it cites nothing and every claim
 * reads "Agent's claim only".
 */
function modelAnswer(cite: CitableEvents | null): string {
	const ids = (...keys: Array<keyof CitableEvents>) =>
		cite ? keys.map((key) => `E${cite[key]}`) : [];
	return JSON.stringify({
		overview:
			"Added retry with exponential backoff to the uploader, with tests, and left the docs for later.",
		outcome: {
			status: "mostly_completed",
			explanation: "The retry works and its tests pass; the README section is still unwritten.",
		},
		accomplishments: [
			{
				text: "Added retry with exponential backoff in src/retry.ts",
				evidence: ids("prompt", "created"),
			},
			{ text: "Wired the uploader to use it", evidence: ids("edited") },
			{ text: "Chose a cap of five attempts", evidence: [] },
		],
		changes: [
			{ kind: "created", text: "src/retry.ts", evidence: ids("created") },
			{ kind: "modified", text: "src/uploader.ts", evidence: ids("edited") },
			{ kind: "modified", text: "src/uploader.test.ts", evidence: [] },
		],
		decisions: [
			{
				text: "Cap retries at five attempts",
				why: "Beyond that the upload is more likely a real outage than a blip.",
				evidence: [],
			},
		],
		validation: [
			{
				what: "bun test src/uploader.test.ts",
				result: "passed",
				detail: "12 pass",
				evidence: ids("tested"),
			},
			{ what: "typecheck", result: "passed", detail: "", evidence: [] },
		],
		problems: [{ text: "The backoff has no jitter, so many clients retry in step.", evidence: [] }],
		unfinished: [{ text: "Document the retry settings in the README.", evidence: [] }],
		nextActions: [
			{ text: "Add jitter to the backoff in src/retry.ts.", evidence: [] },
			{ text: "Write the README section.", evidence: [] },
		],
		handoff:
			"Retry lives in src/retry.ts and is called from src/uploader.ts.\nTests: bun test src/uploader.test.ts.\nNext: jitter, then the README.",
	});
}

const stubAnswer = (cite: CitableEvents | null) => ({
	text: modelAnswer(cite),
	stop: "stop",
	usage: { input: 9000, output: 900 },
});

// ── seeding ─────────────────────────────────────────────────────────────────

let base = "";

async function api(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${base}${path}`, {
		...init,
		headers: { "Content-Type": "application/json", ...init.headers },
	});
}

async function mustOk(res: Response, what: string): Promise<unknown> {
	if (!res.ok) throw new Error(`${what}: ${res.status} ${await res.text()}`);
	return res.json();
}

let toolSeq = 0;
async function hook(sessionId: string, body: Record<string, unknown>): Promise<void> {
	const res = await api("/api/v1/hooks", {
		method: "POST",
		body: JSON.stringify({ session_id: sessionId, cwd: "/work/uploader", ...body }),
	});
	if (!res.ok) throw new Error(`hook ${String(body.hook_event_name)}: ${res.status}`);
}

async function tool(
	sessionId: string,
	name: string,
	input: Record<string, unknown>,
	response: unknown,
): Promise<void> {
	const tool_use_id = `toolu_${sessionId}_${++toolSeq}`;
	await hook(sessionId, {
		hook_event_name: "PreToolUse",
		tool_name: name,
		tool_input: input,
		tool_use_id,
	});
	await hook(sessionId, {
		hook_event_name: "PostToolUse",
		tool_name: name,
		tool_input: input,
		tool_response: response,
		tool_use_id,
	});
}

async function seedWorkSession(sessionId: string, name: string): Promise<void> {
	await hook(sessionId, {
		hook_event_name: "SessionStart",
		source: "startup",
		model: "demo-model",
	});
	await hook(sessionId, {
		hook_event_name: "UserPromptSubmit",
		prompt: "Add retry with exponential backoff to the uploader and test it.",
	});
	await tool(
		sessionId,
		"Write",
		{ file_path: "/work/uploader/src/retry.ts", content: "export {};" },
		{
			filePath: "/work/uploader/src/retry.ts",
			type: "create",
		},
	);
	await tool(
		sessionId,
		"Edit",
		{
			file_path: "/work/uploader/src/uploader.ts",
			old_string: "send(",
			new_string: "retry(send, ",
		},
		{ filePath: "/work/uploader/src/uploader.ts" },
	);
	await tool(
		sessionId,
		"Bash",
		{ command: "bun test src/uploader.test.ts" },
		{
			stdout: "bun test v1.3\n 12 pass\n 0 fail\nRan 12 tests across 1 file.",
			stderr: "",
			interrupted: false,
		},
	);
	await hook(sessionId, {
		hook_event_name: "Stop",
		last_assistant_message: "Retry is in and the tests pass. The README still needs a section.",
	});
	await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}/rename`, {
		method: "PUT",
		body: JSON.stringify({ name, source: "user" }),
	});
}

/** Which of a seeded session's events a summary can cite, read back from the server. */
async function citableEvents(sessionId: string): Promise<CitableEvents> {
	const { events } = (await mustOk(
		await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}`),
		`read ${sessionId}`,
	)) as { events: Array<{ id: number; eventType: string; toolName: string | null }> };
	const idOf = (eventType: string, toolName: string | null = null) => {
		const found = events
			.filter((e) => e.eventType === eventType && e.toolName === toolName)
			.sort((a, b) => a.id - b.id)[0];
		if (!found) throw new Error(`${sessionId} has no ${eventType} ${toolName ?? ""} event`);
		return found.id;
	};
	return {
		prompt: idOf("UserPromptSubmit"),
		created: idOf("PostToolUse", "Write"),
		edited: idOf("PostToolUse", "Edit"),
		tested: idOf("PostToolUse", "Bash"),
	};
}

async function seedTooLittle(sessionId: string): Promise<void> {
	await hook(sessionId, {
		hook_event_name: "SessionStart",
		source: "startup",
		model: "demo-model",
	});
	await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}/rename`, {
		method: "PUT",
		body: JSON.stringify({ name: "demo-too-little", source: "user" }),
	});
}

async function generateAndWait(sessionId: string): Promise<void> {
	const path = `/api/v1/ai/sessions/${encodeURIComponent(sessionId)}/summary`;
	await mustOk(await api(path, { method: "POST" }), `generate ${sessionId}`);
	const deadline = Date.now() + GENERATION_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const view = (await mustOk(await api(path), `read ${sessionId}`)) as {
			attempt: { status: string; errorCode: string | null };
			stored: unknown;
		};
		if (view.attempt.status !== "generating") {
			if (!view.stored) throw new Error(`no summary for ${sessionId}: ${view.attempt.errorCode}`);
			return;
		}
		await Bun.sleep(300);
	}
	throw new Error(`summary for ${sessionId} didn't finish`);
}

// ── processes ───────────────────────────────────────────────────────────────

async function waitForHealth(): Promise<void> {
	const deadline = Date.now() + READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${base}/api/v1/health`)).ok) return;
		} catch {
			// not up yet
		}
		await Bun.sleep(250);
	}
	throw new Error("the server didn't become ready");
}

const cleanups: Array<() => void | Promise<void>> = [];
let stopping = false;
async function stopAll(code: number): Promise<never> {
	if (stopping) process.exit(code);
	stopping = true;
	for (const fn of cleanups.reverse()) {
		try {
			await fn();
		} catch {
			// best effort
		}
	}
	process.exit(code);
}
process.on("SIGINT", () => void stopAll(0));
process.on("SIGTERM", () => void stopAll(0));

async function main(): Promise<void> {
	const stub = startLlmStubServer();
	cleanups.push(() => {
		stub.reset();
		return stub.stop();
	});
	const existing = process.env.AGENTPULSE_URL;
	if (existing) {
		base = refuseNonLoopback(existing).origin;
	} else {
		const port = Number(option("--port") ?? DEFAULT_PORT);
		const scratch = mkdtempSync(join(tmpdir(), "agentpulse-summary-seed-"));
		mkdirSync(join(scratch, "data"));
		if (!flag("--keep")) cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
		base = `http://127.0.0.1:${port}`;
		const server: Subprocess = spawn(["bun", "src/server/index.ts"], {
			cwd: REPO_ROOT,
			stdout: "ignore",
			stderr: "inherit",
			env: {
				...process.env,
				NODE_ENV: "production",
				HOST: "127.0.0.1",
				PORT: String(port),
				DISABLE_AUTH: "true",
				AGENTPULSE_AI_ENABLED: "true",
				AGENTPULSE_SECRETS_KEY: randomBytes(32).toString("hex"),
				AGENTPULSE_TELEMETRY: "off",
				DO_NOT_TRACK: "1",
				SQLITE_PATH: join(scratch, "dev.db"),
				DATA_DIR: join(scratch, "data"),
			},
		});
		cleanups.push(() => server.kill());
		console.log(`scratch database: ${scratch}`);
	}
	await waitForHealth();

	await mustOk(
		await api("/api/v1/ai/status", { method: "PUT", body: JSON.stringify({ enabled: true }) }),
		"enable AI",
	);
	await mustOk(
		await api("/api/v1/ai/providers", {
			method: "POST",
			body: JSON.stringify({
				name: "Stub provider",
				kind: "openai",
				model: "gpt-5-mini",
				baseUrl: stub.baseUrl("openai"),
				apiKey: STUB_KEY,
				isDefault: true,
			}),
		}),
		"add the stub provider",
	);
	await mustOk(
		await api("/api/v1/labs/flags/sessionSummary", {
			method: "PUT",
			body: JSON.stringify({ enabled: true }),
		}),
		"turn the flag on for seeding",
	);

	await seedWorkSession("demo-ready", "demo-ready");
	await seedWorkSession("demo-stale", "demo-stale");
	await seedWorkSession("demo-fresh", "demo-fresh");
	await seedTooLittle("demo-too-little");
	for (const id of ["demo-ready", "demo-stale"]) {
		stub.script("openai", stubAnswer(await citableEvents(id)));
		await generateAndWait(id);
	}
	await hook("demo-stale", {
		hook_event_name: "UserPromptSubmit",
		prompt: "Now write the README section.",
	});
	await tool(
		"demo-stale",
		"Edit",
		{ file_path: "/work/uploader/README.md", old_string: "a", new_string: "b" },
		{},
	);

	if (!flag("--flag-on")) {
		await mustOk(
			await api("/api/v1/labs/flags/sessionSummary", {
				method: "PUT",
				body: JSON.stringify({ enabled: false }),
			}),
			"turn the flag back off",
		);
	}

	const holdMs = Number(option("--hold-ms") ?? DEFAULT_HOLD_MS);
	const next = stub.createGate();
	stub.script("openai", {
		...stubAnswer(await citableEvents("demo-fresh")),
		...(holdMs > 0 ? { gate: next } : {}),
	});
	// Later answers (Update on another session) can't cite that session's events, so they cite none.
	stub.script("openai", ...Array.from({ length: 30 }, () => stubAnswer(null)));
	if (holdMs > 0) void next.arrived.then(() => setTimeout(() => next.release(), holdMs));

	console.log(`\nReady: ${base}`);
	console.log("Sessions: demo-ready, demo-stale, demo-fresh, demo-too-little");
	console.log(
		flag("--flag-on")
			? "The Summary tab is on."
			: "The Summary flag is OFF: open a session, then its AI tab, and press Turn on.",
	);
	console.log("Ctrl-C stops the server and the stub and removes the scratch database.");
	await new Promise(() => {});
}

main().catch(async (error) => {
	console.error(error instanceof Error ? error.message : error);
	await stopAll(1);
});
