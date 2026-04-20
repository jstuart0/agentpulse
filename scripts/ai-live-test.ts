#!/usr/bin/env bun
/**
 * End-to-end AI watcher live test.
 *
 * Spins up a real AgentPulse server in a tmp directory, creates providers
 * from AGENTPULSE_LIVE_TEST_PROVIDERS (JSON), runs the watcher against
 * each one with a realistic synthetic session, and reports what came back.
 *
 * Usage:
 *   AGENTPULSE_LIVE_TEST_PROVIDERS='[
 *     {"name":"ollama-qwen","kind":"openai_compatible","model":"qwen2.5:7b","baseUrl":"http://192.168.10.50:11434/v1","apiKey":"ollama"},
 *     {"name":"openrouter-sonnet","kind":"openrouter","model":"anthropic/claude-3.5-sonnet","baseUrl":"https://openrouter.ai/api/v1","apiKey":"sk-or-..."}
 *   ]' bun scripts/ai-live-test.ts
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";

interface ProviderSpec {
	name: string;
	kind: "anthropic" | "openai" | "google" | "openrouter" | "openai_compatible";
	model: string;
	baseUrl?: string;
	apiKey: string;
}

const providersEnv = process.env.AGENTPULSE_LIVE_TEST_PROVIDERS;
if (!providersEnv) {
	console.error(
		"Set AGENTPULSE_LIVE_TEST_PROVIDERS to a JSON array. See file header for format.",
	);
	process.exit(2);
}

let providers: ProviderSpec[];
try {
	providers = JSON.parse(providersEnv);
	if (!Array.isArray(providers)) throw new Error("not an array");
} catch (err) {
	console.error("Could not parse AGENTPULSE_LIVE_TEST_PROVIDERS:", err);
	process.exit(2);
}

const dataDir = mkdtempSync(join(tmpdir(), "ap-live-test-"));
const port = 13040 + Math.floor(Math.random() * 100);
const secretsKey = Array.from({ length: 64 }, () => Math.random().toString(16).slice(-1)).join("");

console.log(`[live-test] data dir: ${dataDir}`);
console.log(`[live-test] listening on ${port}`);
console.log(`[live-test] testing ${providers.length} provider(s)`);

const server = spawn(
	"bun",
	["src/server/index.ts"],
	{
		env: {
			...process.env,
			AGENTPULSE_AI_ENABLED: "true",
			AGENTPULSE_SECRETS_KEY: secretsKey,
			DATA_DIR: dataDir,
			DISABLE_AUTH: "true",
			PORT: String(port),
		},
		stdio: ["ignore", "pipe", "pipe"],
	},
);
server.stdout?.on("data", () => {});
server.stderr?.on("data", (d) => {
	const s = String(d);
	if (s.includes("error") || s.includes("Error")) console.error(`[server] ${s.trim()}`);
});

const BASE = `http://localhost:${port}/api/v1`;

async function ready(): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
			if (res.ok) return;
		} catch {}
		await sleep(200);
	}
	throw new Error("server never became ready");
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
		...init,
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
	}
	return res.json() as Promise<T>;
}

async function seedSession(sessionId: string, cwd: string, displayName: string): Promise<void> {
	// We use the ingest endpoint to get a realistic session + event trail.
	const postHook = (payload: Record<string, unknown>) =>
		fetch(`${BASE}/hooks`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Agent-Type": "claude_code" },
			body: JSON.stringify(payload),
		});

	await postHook({
		session_id: sessionId,
		hook_event_name: "SessionStart",
		cwd,
		model: "claude-sonnet-4-6",
	});
	await postHook({
		session_id: sessionId,
		hook_event_name: "UserPromptSubmit",
		cwd,
		prompt: "Add a smoke test for the new ingest endpoint.",
	});
	await postHook({
		session_id: sessionId,
		hook_event_name: "PreToolUse",
		cwd,
		tool_name: "Bash",
		tool_input: { command: "bun test tests/ingest" },
	});
	await postHook({
		session_id: sessionId,
		hook_event_name: "PostToolUse",
		cwd,
		tool_name: "Bash",
		tool_input: { command: "bun test tests/ingest" },
		tool_response: "3 pass, 0 fail",
	});
	await postHook({
		session_id: sessionId,
		hook_event_name: "Stop",
		cwd,
		last_assistant_message:
			"Tests pass (3/3). The ingest endpoint now validates payload shape and rejects missing session_id. Ready to commit and run the broader suite if you want.",
	});
}

async function run() {
	await ready();
	// Enable runtime
	await req("/ai/status", { method: "PUT", body: JSON.stringify({ enabled: true }) });

	const results: Array<{ provider: string; outcome: string; detail: string }> = [];

	for (const p of providers) {
		const label = `${p.name} (${p.kind} / ${p.model})`;
		console.log(`\n=== ${label} ===`);
		try {
			// Create provider
			const { provider } = await req<{ provider: { id: string } }>("/ai/providers", {
				method: "POST",
				body: JSON.stringify(p),
			});

			// Seed a fresh session
			const sessionId = `live-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
			await seedSession(sessionId, "/tmp/fake-repo", `live-${p.name}`);

			// Enable the watcher for this session with this provider
			await req(`/ai/sessions/${sessionId}/watcher`, {
				method: "PUT",
				body: JSON.stringify({
					enabled: true,
					providerId: provider.id,
					policy: "ask_always",
					maxContinuations: 5,
				}),
			});

			// Wait for the debounced runner. Larger models on Mac Studio take
			// 30-60s for cold completions, so budget generously.
			console.log("  (waiting for watcher to wake)");
			let proposal: Record<string, unknown> | null = null;
			const deadline = Date.now() + 180_000;
			while (Date.now() < deadline) {
				const { proposals } = await req<{ proposals: Array<Record<string, unknown>> }>(
					`/ai/sessions/${sessionId}/watcher`,
				);
				const latest = proposals[0];
				if (latest && latest.state !== "pending") {
					proposal = latest;
					break;
				}
				await sleep(1500);
			}

			if (!proposal) {
				results.push({ provider: label, outcome: "TIMEOUT", detail: "No proposal in 45s" });
				console.log("  ⚠ timeout");
				continue;
			}

			const state = proposal.state;
			const decision = proposal.decision;
			const raw = (proposal.rawResponse as Record<string, unknown> | null) ?? null;
			const decisionObj = raw?.decision as Record<string, unknown> | undefined;
			const content =
				(proposal.nextPrompt as string | null) ||
				(proposal.reportSummary as string | null) ||
				(decisionObj?.proposal as string | null) ||
				(decisionObj?.nextPrompt as string | null) ||
				(proposal.errorMessage as string | null) ||
				"(empty)";
			const cost = proposal.costCents as number;
			const tokens = `${proposal.tokensIn}/${proposal.tokensOut}`;
			const detail = `state=${state} decision=${decision} tokens=${tokens} cost=¢${cost}`;
			console.log(`  ${detail}`);
			console.log(
				`  content: ${content.length > 200 ? `${content.slice(0, 200)}…` : content}`,
			);
			results.push({ provider: label, outcome: String(state), detail: content.slice(0, 400) });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.log(`  ✗ ${msg}`);
			results.push({ provider: label, outcome: "ERROR", detail: msg });
		}
	}

	console.log("\n=== Summary ===");
	for (const r of results) {
		console.log(`${r.outcome.padEnd(20)} ${r.provider}`);
		console.log(`    ${r.detail.slice(0, 200)}`);
	}
}

try {
	await run();
} catch (err) {
	console.error(err);
	process.exitCode = 1;
} finally {
	server.kill();
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {}
}
