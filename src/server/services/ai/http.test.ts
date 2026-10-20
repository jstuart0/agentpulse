import { afterEach, describe, expect, test } from "bun:test";
import { MAX_LLM_CALL_TIMEOUT_SECONDS } from "../../config.js";
import { createOllamaEmbeddingAdapter } from "./embeddings/ollama.js";
import {
	MAX_ERROR_BODY_BYTES,
	MAX_SUCCESS_BODY_BYTES,
	llmFetch,
	readJsonCapped,
	readStreamCapped,
	readTextCapped,
} from "./http.js";
import { createAnthropicAdapter } from "./llm/anthropic.js";
import { createCohereAdapter } from "./llm/cohere.js";
import { createOpenAICompatibleAdapter } from "./llm/openai-compatible.js";
import { LlmError, classifyHttpError } from "./llm/types.js";

const servers: Array<{ stop(force?: boolean): unknown }> = [];

function serve(fetchHandler: (req: Request) => Response | Promise<Response>): string {
	// Each test gets its own server, and every response closes its connection:
	// a pooled keep-alive socket to a stopped server whose port was reused would
	// otherwise fail a later test's request.
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 60,
		async fetch(req) {
			const res = await fetchHandler(req);
			res.headers.set("Connection", "close");
			return res;
		},
	});
	servers.push(server);
	return `http://127.0.0.1:${server.port}`;
}

afterEach(async () => {
	for (const s of servers.splice(0)) await s.stop(true);
});

/** Holds a request open until the client hangs up. */
const hang = (req: Request) =>
	new Promise<Response>((resolve) => {
		req.signal.addEventListener("abort", () => resolve(new Response("gone")));
	});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = new TextEncoder();

/** Sends `first`, then never another byte; records when the client hangs up. */
function stallingBody(first: string, state: { cancelled: boolean }): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(enc.encode(first));
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return new Response(stream, { headers: { "Content-Type": "application/json" } });
}

/**
 * `total` bytes in `chunk`-sized pieces, no Content-Length. The stream closes
 * after the last byte only when `close` is set; otherwise it stalls, so the
 * server is idle and notices the client hanging up.
 */
function chunkedBody(
	total: number,
	chunk: number,
	state: { cancelled: boolean },
	close = false,
): Response {
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			for (let sent = 0; sent < total; sent += chunk) {
				c.enqueue(new Uint8Array(Math.min(chunk, total - sent)).fill(97));
			}
			if (close) c.close();
		},
		cancel() {
			state.cancelled = true;
		},
	});
	return new Response(stream);
}

async function waitFor(pred: () => boolean, ms = 1500): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (pred()) return true;
		await sleep(20);
	}
	return pred();
}

async function rejection(p: Promise<unknown>): Promise<LlmError> {
	try {
		await p;
	} catch (err) {
		expect(err).toBeInstanceOf(LlmError);
		return err as LlmError;
	}
	throw new Error("expected a rejection");
}

async function timed<T>(p: Promise<T>): Promise<{ ms: number; err: LlmError }> {
	const t0 = Date.now();
	const err = await rejection(p);
	return { ms: Date.now() - t0, err };
}

const baseRequest = { systemPrompt: "s", transcriptPrompt: "t", model: "m", timeoutMs: 200 };

type Case = { name: string; run: (url: string) => Promise<unknown>; stall: string };

const CASES: Case[] = [
	{
		name: "openai_compatible complete",
		stall: '{"choices":[{"mess',
		run: (url) =>
			createOpenAICompatibleAdapter({ apiKey: "k", baseUrl: url }).complete(baseRequest),
	},
	{
		name: "openai_compatible stream",
		stall:
			'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n',
		run: async (url) => {
			const adapter = createOpenAICompatibleAdapter({ apiKey: "k", baseUrl: url });
			for await (const _ of adapter.completeStream!(baseRequest)) {
				// drain
			}
		},
	},
	{
		name: "anthropic",
		stall: '{"content":[{"ty',
		run: (url) => createAnthropicAdapter({ apiKey: "k", baseUrl: url }).complete(baseRequest),
	},
	{
		name: "cohere",
		stall: '{"text":"a',
		run: (url) => createCohereAdapter({ apiKey: "k", baseUrl: url }).complete(baseRequest),
	},
];

test("the adapter kinds exercised are the full set, anthropic included", () => {
	// ollama embeddings keeps its own fixed 60 s, so it is covered by the status tests below.
	expect(CASES.map((c) => c.name).sort()).toEqual(
		["anthropic", "cohere", "openai_compatible complete", "openai_compatible stream"].sort(),
	);
});

describe("deadline fires at the caller's value, at every stage", () => {
	for (const c of CASES) {
		test(`${c.name}: headers never arrive`, async () => {
			const url = serve(hang);
			const { ms, err } = await timed(c.run(url));
			expect(ms).toBeLessThan(5000);
			expect(err.subType).toBe("transient_timeout");
			expect(err.deadline).toBe(true);
			expect(err.status).toBeUndefined();
		});

		test(`${c.name}: body stalls after headers`, async () => {
			const state = { cancelled: false };
			const url = serve(() => stallingBody(c.stall, state));
			const { ms, err } = await timed(c.run(url));
			expect(ms).toBeLessThan(5000);
			expect(err.subType).toBe("transient_timeout");
			expect(err.deadline).toBe(true);
			expect(await waitFor(() => state.cancelled)).toBe(true);
		});
	}

	test("llmFetch: a stalled body rejects through readJsonCapped and readStreamCapped", async () => {
		const state = { cancelled: false };
		const url = serve(() => stallingBody('{"a":', state));
		for (const read of [
			(r: Response) => readJsonCapped(r),
			async (r: Response) => {
				for await (const _ of readStreamCapped(r)) {
					// drain
				}
			},
		]) {
			const res = await llmFetch(url, {}, { timeoutMs: 200 });
			const { ms, err } = await timed(read(res));
			expect(ms).toBeLessThan(5000);
			expect(err.deadline).toBe(true);
		}
	});
});

describe("HTTP statuses are not deadlines", () => {
	for (const status of [500, 502, 504, 524]) {
		test(`immediate ${status}`, async () => {
			const url = serve(() => new Response("upstream said no", { status }));
			for (const c of CASES) {
				const err = await rejection(c.run(url));
				expect(err.status).toBe(status);
				expect(err.deadline).toBe(false);
				expect(err.subType).toBe("transient_timeout");
			}
		});
	}

	test("a 503 whose error body drips past the deadline is a provider error, not a deadline", async () => {
		const url = serve(() => {
			const stream = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(enc.encode("busy"));
				},
			});
			return new Response(stream, { status: 503 });
		});
		const t0 = Date.now();
		const err = await rejection(
			createOpenAICompatibleAdapter({ apiKey: "k", baseUrl: url }).complete(baseRequest),
		);
		// The error body was waited on until the 200 ms deadline cut it.
		expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
		expect(err.status).toBe(503);
		expect(err.deadline).toBe(false);
	});

	test("an error body of 64 KiB is read as at most 4 KiB", async () => {
		const state = { cancelled: false };
		const url = serve(() => {
			const r = chunkedBody(64 * 1024, 1024, state, true);
			return new Response(r.body, { status: 500 });
		});
		const res = await llmFetch(url, {}, { timeoutMs: 2000 });
		const out = await classifyHttpError(res);
		expect(out.body.length).toBeLessThanOrEqual(MAX_ERROR_BODY_BYTES);
		expect(out.status).toBe(500);
	});
});

describe("byte caps", () => {
	test("exactly 8 MiB passes and 8 MiB + 1 rejects", async () => {
		const state = { cancelled: false };
		const url = serve((req) => {
			const extra = new URL(req.url).pathname === "/over" ? 1 : 0;
			return chunkedBody(MAX_SUCCESS_BODY_BYTES + extra, 64 * 1024, state, true);
		});
		const ok = await llmFetch(`${url}/ok`, {}, { timeoutMs: 20_000 });
		expect((await readTextCapped(ok)).length).toBe(MAX_SUCCESS_BODY_BYTES);
		const over = await llmFetch(`${url}/over`, {}, { timeoutMs: 20_000 });
		const err = await rejection(readTextCapped(over));
		expect(err.subType).toBe("unknown");
		expect(err.deadline).toBe(false);
	});

	test("a chunked body with no Content-Length over the cap rejects and the server sees the cancel", async () => {
		const state = { cancelled: false };
		const url = serve(() => chunkedBody(MAX_SUCCESS_BODY_BYTES + 1024 * 1024, 256 * 1024, state));
		const res = await llmFetch(url, {}, { timeoutMs: 20_000 });
		expect(res.headers.get("content-length")).toBeNull();
		await rejection(readTextCapped(res));
		expect(await waitFor(() => state.cancelled)).toBe(true);
	});

	test("9,000 chunks of 1 KiB reject cumulatively", async () => {
		const state = { cancelled: false };
		const url = serve(() => chunkedBody(9000 * 1024, 1024, state));
		const res = await llmFetch(url, {}, { timeoutMs: 20_000 });
		await rejection(readTextCapped(res, 8 * 1024 * 1024));
		expect(await waitFor(() => state.cancelled)).toBe(true);
	});

	test("a 9 MiB stream with no frame delimiter rejects through the adapter", async () => {
		const state = { cancelled: false };
		const url = serve(() => chunkedBody(9 * 1024 * 1024, 64 * 1024, state));
		const adapter = createOpenAICompatibleAdapter({ apiKey: "k", baseUrl: url });
		const err = await rejection(
			(async () => {
				// biome-ignore lint/style/noNonNullAssertion: openai-compatible implements streaming
				for await (const _ of adapter.completeStream!({ ...baseRequest, timeoutMs: 20_000 })) {
					// drain
				}
			})(),
		);
		expect(err.subType).toBe("unknown");
		expect(await waitFor(() => state.cancelled)).toBe(true);
	});

	test("a legitimate 2.6 MB embeddings-sized JSON passes", async () => {
		const vectors = Array.from({ length: 32 }, () =>
			Array.from({ length: 4096 }, () => 0.1234567890123456),
		);
		const payload = JSON.stringify({ embeddings: vectors });
		expect(payload.length).toBeGreaterThan(2_000_000);
		const url = serve(
			() => new Response(payload, { headers: { "Content-Type": "application/json" } }),
		);
		const res = await llmFetch(url, {}, { timeoutMs: 10_000 });
		const json = (await readJsonCapped(res)) as { embeddings: number[][] };
		expect(json.embeddings.length).toBe(32);
	});
});

describe("caller abort", () => {
	test("an external abort closes the request and is not a deadline", async () => {
		let serverSawAbort = false;
		let arrived = false;
		const url = serve((req) => {
			arrived = true;
			req.signal.addEventListener("abort", () => {
				serverSawAbort = true;
			});
			return hang(req);
		});
		const ctl = new AbortController();
		const p = rejection(llmFetch(url, {}, { timeoutMs: 5000, signal: ctl.signal }));
		expect(await waitFor(() => arrived)).toBe(true);
		ctl.abort();
		const err = await p;
		expect(err.deadline).toBe(false);
		expect(err.subType).toBe("unknown");
		expect(await waitFor(() => serverSawAbort)).toBe(true);
	});

	test("a caller abort after the deadline has fired does not change the verdict", async () => {
		const url = serve(hang);
		const ctl = new AbortController();
		const err = await rejection(llmFetch(url, {}, { timeoutMs: 100, signal: ctl.signal }));
		ctl.abort();
		expect(err.deadline).toBe(true);
		expect(err.subType).toBe("transient_timeout");
	});

	test("an abort that fires mid-body is not a deadline", async () => {
		const url = serve(() => stallingBody("{", { cancelled: false }));
		const ctl = new AbortController();
		const res = await llmFetch(url, {}, { timeoutMs: 5000, signal: ctl.signal });
		const p = rejection(readTextCapped(res));
		ctl.abort();
		expect((await p).deadline).toBe(false);
	});
});

describe("provider text", () => {
	const SENTINEL = "SENTINEL-PROVIDER-TEXT";

	test("a non-JSON 200 raises SyntaxError from readJsonCapped (kept so the summary stays internal_error)", async () => {
		const url = serve(() => new Response("<html>not json"));
		const res = await llmFetch(url, {}, { timeoutMs: 5000 });
		await expect(readJsonCapped(res)).rejects.toBeInstanceOf(SyntaxError);
	});

	test("provider error text reaches an adapter message only inside the existing 300-character slice", async () => {
		// Adapters have always put up to 300 characters of the provider's error body in the
		// LlmError message (Ask shows that text in a failed message's errorMessage). The summary
		// never stores or shows the message; session-summary-service.test.ts pins that. What this
		// pins is the bound: text past 300 characters, and past the 4 KiB read, never appears.
		const body = `${SENTINEL}-EARLY ${"x".repeat(400)} ${SENTINEL}-LATE`;
		const url = serve(() => new Response(body, { status: 500 }));
		for (const c of CASES) {
			const err = await rejection(c.run(url));
			expect(err.message).not.toContain(`${SENTINEL}-LATE`);
			expect(err.message.length).toBeLessThan(400);
		}
		const ollama = await createOllamaEmbeddingAdapter({ baseUrl: url, model: "m", dim: 2 });
		const ollamaErr = await ollama.embed("x").catch((e: Error) => e);
		expect((ollamaErr as Error).message).not.toContain(`${SENTINEL}-LATE`);
	});

	test("a transport failure message names the error, never its text", async () => {
		const err = await rejection(llmFetch("http://127.0.0.1:1/", {}, { timeoutMs: 5000 }));
		expect(err.message).toMatch(/failed \(\w+\)$/);
		expect(err.cause).toBeDefined();
	});
});

describe("timeoutMs bounds", () => {
	for (const bad of [
		Number.POSITIVE_INFINITY,
		Number.NaN,
		0,
		-1,
		MAX_LLM_CALL_TIMEOUT_SECONDS * 1000 + 1,
	]) {
		test(`${bad} is rejected before any fetch`, async () => {
			let hits = 0;
			const url = serve(() => {
				hits++;
				return new Response("{}");
			});
			const err = await rejection(llmFetch(url, {}, { timeoutMs: bad }));
			expect(err.subType).toBe("unknown");
			expect(hits).toBe(0);
		});
	}

	test("the largest allowed value is accepted", async () => {
		const url = serve(() => new Response("{}"));
		const res = await llmFetch(url, {}, { timeoutMs: MAX_LLM_CALL_TIMEOUT_SECONDS * 1000 });
		expect(res.status).toBe(200);
		await res.text();
	});

	test("a missing timeout is rejected", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: simulating a JS caller that omits the option
		const err = await rejection(llmFetch("http://127.0.0.1:1", {}, {} as any));
		expect(err.subType).toBe("unknown");
	});
});

describe("ollama embeddings status handling", () => {
	test("a 404 on /api/embed falls back to the legacy /api/embeddings", async () => {
		const paths: string[] = [];
		const url = serve((req) => {
			const path = new URL(req.url).pathname;
			paths.push(path);
			if (path === "/api/embed") return new Response("not found", { status: 404 });
			return Response.json({ embedding: [1, 2] });
		});
		const adapter = await createOllamaEmbeddingAdapter({ baseUrl: url, model: "m", dim: 2 });
		const v = await adapter.embed("x");
		expect(Array.from(v)).toEqual([1, 2]);
		expect(paths).toEqual(["/api/embed", "/api/embeddings"]);
	});

	test("a 500 on /api/embed still throws its existing error and does not fall back", async () => {
		const paths: string[] = [];
		const url = serve((req) => {
			paths.push(new URL(req.url).pathname);
			return new Response("boom", { status: 500 });
		});
		const adapter = await createOllamaEmbeddingAdapter({ baseUrl: url, model: "m", dim: 2 });
		await expect(adapter.embed("x")).rejects.toThrow("Ollama embed failed: 500 boom");
		expect(paths).toEqual(["/api/embed"]);
	});
});
