/**
 * Manual benchmark for the ingest redaction step (AGEN-146). Never run in CI.
 *
 *   bun scripts/bench-ingest-redaction.ts
 *
 * Reports, per text shape: the cost of the redactor's rules run one after another over the
 * whole text (what `redact()` cost before the gates), `redact()` now, the sliced engine run
 * to the end, and the longest single slice. Then the cost of the real entry points (a
 * 256 Ki single line, a 5 MB Read response, a 2 MiB managed batch), and the delay an
 * in-process request sees while 1, 4 and 16 sessions redact large events back to back.
 */
import { readFileSync } from "node:fs";
import { DEFAULT_RULES, createRedactionJob, redact } from "../src/server/services/ai/redactor.js";
import type { NormalizedEvent } from "../src/server/services/event-normalizer.js";
import {
	__testing,
	getIngestRedactionCounters,
	prepareHookPayloadForStorage,
	redactEventsForStorage,
	redactTextForStorage,
} from "../src/server/services/ingest-redaction.js";
import type { HookEventPayload } from "../src/shared/types.js";

const root = new URL("../", import.meta.url).pathname;
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8");
const fit = (base: string, chars: number): string =>
	base.length >= chars
		? base.slice(0, chars)
		: base.repeat(Math.ceil(chars / base.length)).slice(0, chars);
const median = (run: () => void, times = 5): number => {
	const samples: number[] = [];
	for (let i = 0; i < times; i++) {
		const started = performance.now();
		run();
		samples.push(performance.now() - started);
	}
	samples.sort((a, b) => a - b);
	return samples[times >> 1] as number;
};

/** The loop `redact()` ran before the gates: every rule over the whole text. */
function redactUngated(input: string): string {
	let text = input;
	for (const rule of DEFAULT_RULES) {
		rule.pattern.lastIndex = 0;
		text = text.replace(rule.pattern, (m) =>
			typeof rule.replacement === "function" ? rule.replacement(m) : rule.replacement,
		);
	}
	return text;
}

const code = [
	"src/server/services/event-processor.ts",
	"src/server/routes/ingest.ts",
	"src/server/services/managed-session-state.ts",
	"src/server/services/ai/runner.ts",
]
	.map(read)
	.join("\n");
const random = new Uint8Array(1 << 20);
crypto.getRandomValues(random);
const shapes: Record<string, string> = {
	code,
	json: JSON.stringify({
		file: { filePath: "/a/b/c.ts", content: code.slice(0, 50_000) },
		items: Array.from({ length: 400 }, (_, i) => ({
			id: i,
			name: `item-${i}`,
			token_count: i * 3,
			ok: true,
		})),
	}),
	logs: Array.from(
		{ length: 20_000 },
		(_, i) =>
			`2026-01-01T00:00:00Z INFO [worker-${i % 8}] request id=${i} path=/api/v1/sessions/${i} status=200 dur=${i % 97}ms`,
	).join("\n"),
	"single-line": code.replace(/\n/g, " "),
	base64: Buffer.from(random).toString("base64"),
	hex: Buffer.from(random).toString("hex"),
};

console.log("## Per shape (ms)\n");
console.log("shape        size    old loop   redact()   sliced    max slice");
for (const [name, base] of Object.entries(shapes)) {
	for (const size of [65_536, 262_144]) {
		const text = fit(base, size);
		redactUngated(text);
		redact(text);
		const old = median(() => redactUngated(text));
		const gated = median(() => redact(text));
		let maxSlice = 0;
		const sliced = median(() => {
			const job = createRedactionJob(text);
			while (!job.done) {
				const started = performance.now();
				job.step(4, 16_384);
				maxSlice = Math.max(maxSlice, performance.now() - started);
			}
		});
		console.log(
			`${name.padEnd(12)} ${String(size >> 10).padStart(3)}Ki ${old.toFixed(1).padStart(10)} ${gated.toFixed(1).padStart(10)} ${sliced.toFixed(1).padStart(9)} ${maxSlice.toFixed(1).padStart(10)}`,
		);
	}
}

const hook = (extra: Record<string, unknown>): HookEventPayload =>
	({
		session_id: "bench",
		hook_event_name: "PostToolUse",
		tool_name: "Read",
		...extra,
	}) as unknown as HookEventPayload;

console.log("\n## Entry points (ms, one call)\n");
const timed = async (label: string, run: () => Promise<unknown>): Promise<void> => {
	__testing.reset();
	await run();
	const started = performance.now();
	await run();
	const total = performance.now() - started;
	console.log(
		`${label.padEnd(40)} ${total.toFixed(1).padStart(8)} ms   max slice ${getIngestRedactionCounters().maxSliceMs.toFixed(1)} ms`,
	);
};
await timed("hook event, 8 KiB prompt", () =>
	prepareHookPayloadForStorage(
		hook({ hook_event_name: "UserPromptSubmit", prompt: fit(code, 8192) }),
		{ keyId: "k" },
	),
);
await timed("hook event, 256 Ki single line", () =>
	prepareHookPayloadForStorage(
		hook({
			hook_event_name: "UserPromptSubmit",
			prompt: fit(shapes["single-line"] as string, 262_144),
		}),
		{ keyId: "k" },
	),
);
await timed("hook event, 5 MB Read response", () =>
	prepareHookPayloadForStorage(hook({ tool_response: fit(code, 5_000_000) }), { keyId: "k" }),
);
await timed("text, 1 MiB over the cap", () => redactTextForStorage(fit(code, 1_100_000), "bench"));
const managed: NormalizedEvent[] = Array.from({ length: 500 }, (_, i) => ({
	eventType: "ManagedAgentMessage",
	category: "assistant_message",
	source: "managed_control",
	content: fit(code, 4000 + i),
	isNoise: false,
	providerEventType: null,
	toolName: null,
	toolInput: null,
	toolResponse: null,
	rawPayload: { kind: "message" },
}));
await timed("text, one 1 MiB sk-ant token (F3)", () =>
	redactTextForStorage(`before sk-ant-${"A".repeat(1 << 20)} after`, "bench"),
);
await timed("managed batch, 500 events (~2 MiB)", () => redactEventsForStorage("s:bench", managed));

console.log(
	"\n## In-process request delay while N sessions redact 256 Ki events back to back (ms)\n",
);
const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
async function ping(durationMs: number): Promise<string> {
	const samples: number[] = [];
	const end = performance.now() + durationMs;
	while (performance.now() < end) {
		const started = performance.now();
		await (await fetch(`http://localhost:${server.port}/`)).text();
		samples.push(performance.now() - started);
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	samples.sort((a, b) => a - b);
	const at = (q: number) => (samples[Math.floor(samples.length * q)] ?? 0).toFixed(1);
	return `n=${samples.length} p50=${at(0.5)} p95=${at(0.95)} p99=${at(0.99)} max=${(samples[samples.length - 1] ?? 0).toFixed(1)}`;
}
console.log(`idle                       ${await ping(1500)}`);
const event = fit(code, 262_144);
for (const sessions of [1, 4, 16]) {
	for (const mode of ["old (whole text, yield between)", "new (sliced scheduler)"]) {
		let stop = false;
		const workers = Array.from({ length: sessions }, (_, i) =>
			(async () => {
				while (!stop) {
					if (mode.startsWith("old")) {
						redactUngated(event);
						await new Promise((resolve) => setImmediate(resolve));
					} else {
						await prepareHookPayloadForStorage(
							hook({ hook_event_name: "UserPromptSubmit", prompt: event }),
							{ keyId: `k${i}` },
						);
					}
				}
			})(),
		);
		console.log(`${String(sessions).padStart(2)} sessions, ${mode.padEnd(32)} ${await ping(2500)}`);
		stop = true;
		await Promise.all(workers);
	}
}
server.stop(true);
