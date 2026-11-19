import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { fetchCapped } from "./capped-fetch.js";

/** A plain loopback server: the only kind of http:// the fetch may reach. */
let server: ReturnType<typeof Bun.serve>;
let other: ReturnType<typeof Bun.serve>;
let otherHits = 0;
const requests: Request[] = [];
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(() => {
	other = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			otherHits++;
			return new Response("other");
		},
	});
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			requests.push(req);
			const path = new URL(req.url).pathname;
			if (path === "/ok") return new Response("hello");
			if (path === "/cap") return new Response("a".repeat(1024));
			if (path === "/over") return new Response("a".repeat(1025));
			if (path === "/redirect")
				return new Response(null, {
					status: 302,
					headers: { location: `http://127.0.0.1:${other.port}/x` },
				});
			if (path === "/500") return new Response("nope", { status: 500 });
			if (path === "/404") return new Response("nope", { status: 404 });
			if (path === "/drip") {
				return new Response(
					new ReadableStream({
						async start(controller) {
							for (let i = 0; i < 50; i++) {
								controller.enqueue(new TextEncoder().encode("x"));
								await Bun.sleep(50);
							}
							controller.close();
						},
					}),
				);
			}
			if (path === "/chunked-at" || path === "/chunked-over") {
				const total = path === "/chunked-at" ? 1024 : 1025;
				return new Response(
					new ReadableStream({
						async start(controller) {
							for (let sent = 0; sent < total; sent += 256) {
								controller.enqueue(new Uint8Array(Math.min(256, total - sent)).fill(97));
								await Bun.sleep(1);
							}
							controller.close();
						},
					}),
				);
			}
			if (path === "/gzip-bomb") {
				const body = Bun.gzipSync(new Uint8Array(200_000).fill(97));
				return new Response(body, { headers: { "content-encoding": "gzip" } });
			}
			if (path === "/stall") {
				return new Response(new ReadableStream({ start() {} }));
			}
			return new Response("missing", { status: 404 });
		},
	});
});

afterAll(() => {
	server.stop(true);
	other.stop(true);
});

const opts = { deadlineMs: 2000, maxBytes: 1024 };

describe("fetchCapped", () => {
	test("returns the body of a 200", async () => {
		const r = await fetchCapped(`${base()}/ok`, opts);
		expect(r).toEqual({ ok: true, status: 200, body: "hello" });
	});

	test("a body of exactly maxBytes passes and one byte more is too_large", async () => {
		const at = await fetchCapped(`${base()}/cap`, opts);
		expect(at.ok).toBe(true);
		const over = await fetchCapped(`${base()}/over`, opts);
		expect(over).toEqual({ ok: false, code: "too_large" });
	});

	test("a 3xx is a refusal and the other origin is never contacted", async () => {
		const r = await fetchCapped(`${base()}/redirect`, opts);
		expect(r).toEqual({ ok: false, code: "redirect", status: 302 });
		expect(otherHits).toBe(0);
	});

	test("a non-2xx status is a refusal that names the status", async () => {
		expect(await fetchCapped(`${base()}/500`, opts)).toEqual({
			ok: false,
			code: "status",
			status: 500,
		});
		expect(await fetchCapped(`${base()}/404`, opts)).toEqual({
			ok: false,
			code: "status",
			status: 404,
		});
	});

	test("a slow drip hits the one deadline, body included", async () => {
		const started = Date.now();
		const r = await fetchCapped(`${base()}/drip`, { deadlineMs: 300, maxBytes: 1024 });
		expect(r).toEqual({ ok: false, code: "timeout" });
		expect(Date.now() - started).toBeLessThan(1500);
	});

	test("a stalled body times out too", async () => {
		const r = await fetchCapped(`${base()}/stall`, { deadlineMs: 250, maxBytes: 1024 });
		expect(r).toEqual({ ok: false, code: "timeout" });
	});

	test("sends no cookie, no query string and no header the runtime doesn't add itself", async () => {
		requests.length = 0;
		await fetchCapped(`${base()}/ok`, opts);
		const req = requests.at(-1) as Request;
		expect(req.headers.get("cookie")).toBeNull();
		expect(req.headers.get("authorization")).toBeNull();
		expect(new URL(req.url).search).toBe("");
		expect(req.method).toBe("GET");
		const names = [...req.headers.keys()].sort();
		for (const name of names) {
			expect(["accept", "accept-encoding", "connection", "host", "user-agent"]).toContain(name);
		}
	});

	test("httpsOrLoopbackOnly allows loopback http and refuses every other http host", async () => {
		expect((await fetchCapped(`${base()}/ok`, opts)).ok).toBe(true);
		for (const url of [
			"http://192.0.2.1/x",
			"http://localhost.evil.com/x",
			"http://127.0.0.1.nip.io/x",
			"http://example.com/x",
		]) {
			expect(await fetchCapped(url, opts), url).toEqual({ ok: false, code: "insecure" });
		}
	});

	test("refuses a URL with credentials, a non-http scheme and junk", async () => {
		expect(await fetchCapped("https://user:pw@example.com/x", opts)).toEqual({
			ok: false,
			code: "bad_url",
		});
		expect(await fetchCapped("file:///etc/passwd", opts)).toEqual({ ok: false, code: "bad_url" });
		expect(await fetchCapped("not a url", opts)).toEqual({ ok: false, code: "bad_url" });
	});

	test("an unreachable loopback port is a quiet network refusal, never a throw", async () => {
		const r = await fetchCapped("http://127.0.0.1:1/x", opts);
		expect(r).toEqual({ ok: false, code: "network" });
	});

	test("bad options are refused before any request", async () => {
		expect(await fetchCapped(`${base()}/ok`, { deadlineMs: 0, maxBytes: 1024 })).toEqual({
			ok: false,
			code: "bad_options",
		});
		expect(await fetchCapped(`${base()}/ok`, { deadlineMs: 1000, maxBytes: -1 })).toEqual({
			ok: false,
			code: "bad_options",
		});
	});

	test("a chunked body with no Content-Length: exactly maxBytes passes, one more is too_large", async () => {
		const at = await fetchCapped(`${base()}/chunked-at`, opts);
		expect(at.ok && at.body.length).toBe(1024);
		expect(await fetchCapped(`${base()}/chunked-over`, opts)).toEqual({
			ok: false,
			code: "too_large",
		});
	});

	test("a gzip response that expands past the cap is too_large, though its wire size is tiny", async () => {
		expect(await fetchCapped(`${base()}/gzip-bomb`, opts)).toEqual({
			ok: false,
			code: "too_large",
		});
	});

	test("a server that accepts the connection and never answers hits the deadline", async () => {
		const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {} } });
		try {
			const started = Date.now();
			const r = await fetchCapped(`http://127.0.0.1:${silent.port}/x`, {
				deadlineMs: 300,
				maxBytes: 1024,
			});
			expect(r).toEqual({ ok: false, code: "timeout" });
			expect(Date.now() - started).toBeLessThan(1500);
		} finally {
			silent.stop(true);
		}
	});

	test("http://[::1]:port is loopback and allowed", async () => {
		let v6: ReturnType<typeof Bun.serve>;
		try {
			v6 = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("six") });
		} catch {
			return; // no IPv6 loopback on this machine
		}
		try {
			expect(await fetchCapped(`http://[::1]:${v6.port}/x`, opts)).toEqual({
				ok: true,
				status: 200,
				body: "six",
			});
		} finally {
			v6.stop(true);
		}
	});
});
