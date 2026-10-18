import { afterEach, describe, expect, test } from "bun:test";
import type { RelayEnvelope } from "./hpke-seal.js";
import {
	BREAKER_FAILURE_THRESHOLD,
	BREAKER_OPEN_MS,
	RELAY_TIMEOUT_MS,
	RelayClient,
	RelayUrlError,
	canonicalizeRelayUrl,
	loadRelayUrl,
} from "./relay-client.js";
import type { PushLogger } from "./types.js";

const SEND_TOKEN = "stoken-SECRET-0123456789.abcdefghijklmnopqrstuvwxyz";
const envelope: RelayEnvelope = {
	v: 1,
	e: "B".repeat(87),
	c: "CIPHERTEXT-SECRET-".padEnd(60, "x"),
	d: "relayDevice0123456789",
	p: "push-1",
};

interface Seen {
	method: string;
	path: string;
	headers: Headers;
	body: unknown;
}

type Handler = (req: Request, seen: Seen) => Response | Promise<Response>;

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop(true);
});

function startMockRelay(handler: Handler) {
	const seen: Seen[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const entry: Seen = {
				method: req.method,
				path: new URL(req.url).pathname,
				headers: req.headers,
				body: req.method === "POST" ? await req.json().catch(() => null) : null,
			};
			seen.push(entry);
			return handler(req, entry);
		},
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}`, seen, server };
}

function makeClock(start = 1_000_000) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

function captureLogger() {
	const lines: string[] = [];
	const logger: PushLogger = {
		info: (m, f) => void lines.push(`${m} ${JSON.stringify(f ?? {})}`),
		warn: (m, f) => void lines.push(`${m} ${JSON.stringify(f ?? {})}`),
	};
	return { lines, logger };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

function makeClient(
	url: string,
	extra: Partial<ConstructorParameters<typeof RelayClient>[0]> = {},
) {
	const clock = makeClock();
	const log = captureLogger();
	const client = new RelayClient({ relayUrl: url, clock, logger: log.logger, ...extra });
	return { client, clock, ...log };
}

describe("the request", () => {
	test("posts exactly {kind, envelope, priority} to /v1/push with the send token as a Bearer", async () => {
		const relay = startMockRelay(() =>
			json(202, { pushId: "11111111-2222-3333-4444-555555555555" }),
		);
		const { client } = makeClient(relay.url);
		const result = await client.postAlert(SEND_TOKEN, { envelope, priority: "needs-you" });
		expect(result).toEqual({ kind: "accepted", pushId: "11111111-2222-3333-4444-555555555555" });
		expect(relay.seen).toHaveLength(1);
		const [req] = relay.seen;
		expect(req?.method).toBe("POST");
		expect(req?.path).toBe("/v1/push");
		expect(req?.headers.get("authorization")).toBe(`Bearer ${SEND_TOKEN}`);
		expect(req?.headers.get("content-type")).toContain("application/json");
		expect(req?.body).toEqual({ kind: "alert", envelope, priority: "needs-you" });
	});

	test("adds collapseId only when given", async () => {
		const relay = startMockRelay(() => json(202, { pushId: "p" }));
		const { client } = makeClient(relay.url);
		await client.postAlert(SEND_TOKEN, { envelope, priority: "quiet", collapseId: "abc123" });
		expect(relay.seen[0]?.body).toEqual({
			kind: "alert",
			envelope,
			priority: "quiet",
			collapseId: "abc123",
		});
	});

	test("a Live Activity update carries exactly its own members", async () => {
		const relay = startMockRelay(() => json(202, { pushId: "p" }));
		const { client } = makeClient(relay.url);
		const contentState = {
			status: "waiting",
			statusSince: 1_760_000_000,
			toolCount: 3,
			trace: new Array(24).fill(0),
		};
		await client.postLiveActivity(SEND_TOKEN, {
			slot: "slot-1",
			generation: 2,
			event: "update",
			contentState,
			staleDate: 1_760_000_900,
		});
		expect(relay.seen[0]?.body).toEqual({
			kind: "liveactivity",
			slot: "slot-1",
			generation: 2,
			event: "update",
			contentState,
			staleDate: 1_760_000_900,
		});
	});

	test("refuses to send an envelope with any member beyond v, e, c, d, p", () => {
		const { client } = makeClient("http://127.0.0.1:1");
		const extra = { ...envelope, aps: {} } as unknown as RelayEnvelope;
		expect(() => client.postAlert(SEND_TOKEN, { envelope: extra, priority: "normal" })).toThrow(
			/exactly the members/,
		);
		const { c: _c, ...missing } = envelope;
		expect(() =>
			client.postAlert(SEND_TOKEN, {
				envelope: missing as unknown as RelayEnvelope,
				priority: "normal",
			}),
		).toThrow();
	});

	test("an accepted push without a body still counts as accepted", async () => {
		const relay = startMockRelay(() => new Response(null, { status: 202 }));
		const { client } = makeClient(relay.url);
		expect(await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).toEqual({
			kind: "accepted",
			pushId: null,
		});
	});
});

describe("what each answer means", () => {
	const send = async (handler: Handler) => {
		const relay = startMockRelay(handler);
		const { client, lines } = makeClient(relay.url);
		return {
			result: await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" }),
			lines,
			relay,
		};
	};

	test("410 gone:device and gone:activity are told apart", async () => {
		expect((await send(() => json(410, { gone: "device" }))).result).toEqual({
			kind: "gone",
			gone: "device",
		});
		expect((await send(() => json(410, { gone: "activity" }))).result).toEqual({
			kind: "gone",
			gone: "activity",
		});
	});

	test("a 410 that names nothing it knows is a rejection, not a revocation", async () => {
		for (const body of [{}, { gone: "everything" }, { gone: 1 }]) {
			const { result } = await send(() => json(410, body));
			expect(result.kind).toBe("rejected");
		}
	});

	test("429 names the budget and carries Retry-After in whole seconds", async () => {
		const alert = await send(() => json(429, { budget: "alert" }, { "retry-after": "7" }));
		expect(alert.result).toEqual({ kind: "budget", budget: "alert", retryAfterSec: 7 });
		const activity = await send(() => json(429, { budget: "activity" }, { "retry-after": "2" }));
		expect(activity.result).toEqual({ kind: "budget", budget: "activity", retryAfterSec: 2 });
	});

	test("Retry-After that is not whole seconds is ignored, and a huge one is capped", async () => {
		expect((await send(() => json(429, { budget: "alert" }))).result).toMatchObject({
			retryAfterSec: null,
		});
		expect(
			(
				await send(() =>
					json(429, { budget: "alert" }, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
				)
			).result,
		).toMatchObject({ retryAfterSec: null });
		expect(
			(await send(() => json(429, { budget: "alert" }, { "retry-after": "-5" }))).result,
		).toMatchObject({ retryAfterSec: null });
		expect(
			(await send(() => json(429, { budget: "alert" }, { "retry-after": "999999" }))).result,
		).toMatchObject({ retryAfterSec: 3600 });
	});

	test("a 429 with no budget falls back to the kind of request that was sent", async () => {
		expect((await send(() => json(429, {}))).result).toMatchObject({
			kind: "budget",
			budget: "alert",
		});
		const relay = startMockRelay(() => json(429, {}));
		const { client } = makeClient(relay.url);
		const result = await client.postLiveActivity(SEND_TOKEN, {
			slot: "s",
			generation: 1,
			event: "update",
			contentState: {},
		});
		expect(result).toMatchObject({ kind: "budget", budget: "activity" });
	});

	test("401 means the send token is no good", async () => {
		expect((await send(() => json(401, { error: "unauthorized" }))).result).toEqual({
			kind: "unauthorized",
			confirmed: true,
		});
	});

	test("a 401 that is not the relay's own answer is unconfirmed: a proxy or SSO page can't pass for it", async () => {
		for (const reply of [
			() =>
				new Response("<html>sign in</html>", {
					status: 401,
					headers: { "content-type": "text/html" },
				}),
			() => json(401, { error: "login_required" }),
			() => json(401, {}),
		]) {
			expect((await send(reply)).result).toEqual({ kind: "unauthorized", confirmed: false });
		}
	});

	test("other 4xx are rejections that carry only a short error code", async () => {
		for (const [status, error] of [
			[400, "invalid_envelope"],
			[403, "device_mismatch"],
			[404, "unknown_slot"],
			[409, "stale_generation"],
			[413, "payload_too_large"],
		] as const) {
			expect((await send(() => json(status, { error }))).result).toEqual({
				kind: "rejected",
				status,
				error,
			});
		}
		const odd = await send(() => json(400, { error: "Some Long Sentence With <html> in it" }));
		expect(odd.result).toEqual({ kind: "rejected", status: 400, error: null });
	});

	test("503 and other 5xx are unavailable, with Retry-After passed along", async () => {
		const out = await send(() => json(503, { error: "apns_unavailable" }, { "retry-after": "30" }));
		expect(out.result).toEqual({
			kind: "unavailable",
			reason: "server_error",
			status: 503,
			retryAfterSec: 30,
		});
		expect((await send(() => new Response("boom", { status: 502 }))).result).toMatchObject({
			kind: "unavailable",
			status: 502,
		});
	});

	test("a body that is not JSON does not break classification", async () => {
		expect(
			(await send(() => new Response("<html>nope</html>", { status: 429 }))).result,
		).toMatchObject({ kind: "budget" });
		expect((await send(() => new Response("not json", { status: 202 }))).result).toEqual({
			kind: "accepted",
			pushId: null,
		});
	});

	test("an oversized response body is ignored, not buffered", async () => {
		const huge = JSON.stringify({ pushId: "x".repeat(100_000) });
		const { result } = await send(() => new Response(huge, { status: 202 }));
		expect(result).toEqual({ kind: "accepted", pushId: null });
	});
});

describe("redirects, timeouts and the network", () => {
	test("a redirect, even to loopback, is not followed and counts as a failure", async () => {
		const target = startMockRelay(() => json(202, { pushId: "should-not-happen" }));
		const redirecting = startMockRelay(
			() => new Response(null, { status: 302, headers: { location: `${target.url}/v1/push` } }),
		);
		const { client } = makeClient(redirecting.url);
		const result = await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" });
		expect(result).toEqual({
			kind: "unavailable",
			reason: "redirect",
			status: 302,
			retryAfterSec: null,
		});
		expect(redirecting.seen).toHaveLength(1);
		expect(target.seen).toHaveLength(0); // the send token and envelope never reached the redirect target
	});

	test("every kind of redirect status is refused", async () => {
		for (const status of [301, 302, 303, 307, 308]) {
			const target = startMockRelay(() => json(202, {}));
			const relay = startMockRelay(
				() => new Response(null, { status, headers: { location: target.url } }),
			);
			const { client } = makeClient(relay.url);
			expect(await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).toMatchObject({
				kind: "unavailable",
				reason: "redirect",
			});
			expect(target.seen).toHaveLength(0);
		}
	});

	test("a relay that does not answer within the timeout is a timeout failure", async () => {
		const relay = startMockRelay(async () => {
			await new Promise((r) => setTimeout(r, 400));
			return json(202, { pushId: "late" });
		});
		const { client } = makeClient(relay.url, { timeoutMs: 80 });
		const started = Date.now();
		expect(await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).toEqual({
			kind: "unavailable",
			reason: "timeout",
			status: null,
			retryAfterSec: null,
		});
		expect(Date.now() - started).toBeLessThan(350);
	});

	test("a relay that sends its headers and then stalls the body is a timeout failure, not a hang", async () => {
		const relay = startMockRelay(
			() =>
				new Response(new ReadableStream({ start() {} }), {
					status: 202,
					headers: { "content-type": "application/json" },
				}),
		);
		const { client } = makeClient(relay.url, { timeoutMs: 150 });
		const started = Date.now();
		const result = await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" });
		expect(Date.now() - started).toBeLessThan(600);
		expect(result).toMatchObject({ kind: "unavailable", reason: "timeout" });
	});

	test("a non-202 body that trickles in forever is cut at the deadline and is a failure; a 202 still stands", async () => {
		const trickle = (status: number) => () =>
			new Response(
				new ReadableStream({
					async pull(controller) {
						await new Promise((r) => setTimeout(r, 40));
						controller.enqueue(new TextEncoder().encode(" "));
					},
				}),
				{ status, headers: { "content-type": "application/json" } },
			);
		for (const [status, expected] of [
			[410, { kind: "unavailable", reason: "timeout" }],
			[429, { kind: "unavailable", reason: "timeout" }],
			[202, { kind: "accepted", pushId: null }],
		] as const) {
			const relay = startMockRelay(trickle(status));
			const { client } = makeClient(relay.url, { timeoutMs: 200 });
			const started = Date.now();
			const result = await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" });
			expect(Date.now() - started, `status ${status}`).toBeLessThan(700);
			expect(result, `status ${status}`).toMatchObject(expected);
		}
	});

	test("the default timeout is 5 seconds", () => {
		expect(RELAY_TIMEOUT_MS).toBe(5000);
	});

	test("a refused connection is a network failure", async () => {
		const relay = startMockRelay(() => json(202, {}));
		const dead = relay.url;
		relay.server.stop(true);
		const { client } = makeClient(dead);
		expect(await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).toMatchObject({
			kind: "unavailable",
			reason: "network",
		});
	});
});

describe("circuit breaker (5 consecutive failures, 60 s)", () => {
	test("opens after five failures and then sends nothing", async () => {
		const relay = startMockRelay(() => json(503, {}));
		const { client } = makeClient(relay.url);
		for (let i = 0; i < BREAKER_FAILURE_THRESHOLD; i++) {
			expect((await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).kind).toBe(
				"unavailable",
			);
		}
		expect(relay.seen).toHaveLength(5);
		expect(client.circuitOpen).toBe(true);
		const refused = await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" });
		expect(refused).toEqual({ kind: "circuit_open", retryAfterSec: 60 });
		expect(relay.seen).toHaveLength(5); // nothing went out
	});

	test("four failures leave it closed", async () => {
		const relay = startMockRelay(() => json(503, {}));
		const { client } = makeClient(relay.url);
		for (let i = 0; i < 4; i++)
			await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" });
		expect(client.circuitOpen).toBe(false);
		expect((await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).kind).toBe(
			"unavailable",
		);
		expect(relay.seen).toHaveLength(5);
	});

	test("stays open for 60 s, admits one probe, and a successful probe closes it", async () => {
		let healthy = false;
		const relay = startMockRelay(() => (healthy ? json(202, { pushId: "ok" }) : json(503, {})));
		const { client, clock } = makeClient(relay.url);
		for (let i = 0; i < 5; i++)
			await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" });

		clock.advance(BREAKER_OPEN_MS - 1);
		expect((await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).kind).toBe(
			"circuit_open",
		);
		expect(relay.seen).toHaveLength(5);

		healthy = true;
		clock.advance(1);
		expect((await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).kind).toBe(
			"accepted",
		);
		expect(client.circuitOpen).toBe(false);
		expect((await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).kind).toBe(
			"accepted",
		);
		expect(relay.seen).toHaveLength(7);
	});

	test("a failed probe reopens it for another full 60 s", async () => {
		const relay = startMockRelay(() => json(503, {}));
		const { client, clock } = makeClient(relay.url);
		for (let i = 0; i < 5; i++)
			await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" });
		clock.advance(BREAKER_OPEN_MS);
		expect((await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).kind).toBe(
			"unavailable",
		); // the probe
		expect(relay.seen).toHaveLength(6);
		clock.advance(BREAKER_OPEN_MS - 1);
		expect((await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).kind).toBe(
			"circuit_open",
		);
		clock.advance(1);
		expect((await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).kind).toBe(
			"unavailable",
		);
		expect(relay.seen).toHaveLength(7);
	});

	test("only one probe is in flight at a time", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let calls = 0;
		const relay = startMockRelay(async () => {
			calls++;
			if (calls > 5) await gate;
			return calls > 5 ? json(202, { pushId: "ok" }) : json(503, {});
		});
		const { client, clock } = makeClient(relay.url);
		for (let i = 0; i < 5; i++)
			await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" });
		clock.advance(BREAKER_OPEN_MS);
		const probe = client.postAlert(SEND_TOKEN, { envelope, priority: "normal" });
		await new Promise((r) => setTimeout(r, 30));
		expect((await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).kind).toBe(
			"circuit_open",
		);
		release();
		expect((await probe).kind).toBe("accepted");
	});

	test("answers that are not failures reset the streak: 4xx, 410, 429 and 401 all prove the relay is up", async () => {
		const statuses = [
			503, 503, 503, 503, 400, 503, 503, 503, 503, 410, 503, 503, 503, 503, 429, 503, 503, 503, 503,
			401, 503,
		];
		let i = 0;
		const relay = startMockRelay(() => {
			const status = statuses[i++] ?? 503;
			return status === 410
				? json(410, { gone: "device" })
				: status === 429
					? json(429, { budget: "alert" })
					: json(status, {});
		});
		const { client } = makeClient(relay.url);
		for (let n = 0; n < statuses.length; n++)
			await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" });
		expect(relay.seen).toHaveLength(statuses.length); // never opened
		expect(client.circuitOpen).toBe(false);
	});

	test("timeouts, network errors and redirects count toward it like 5xx do", async () => {
		const mixed = startMockRelay(
			() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/" } }),
		);
		const { client } = makeClient(mixed.url, { failureThreshold: 3 });
		for (let n = 0; n < 3; n++)
			await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" });
		expect(client.circuitOpen).toBe(true);
	});

	test("the Live Activity path shares the same breaker as the alert path", async () => {
		const relay = startMockRelay(() => json(503, {}));
		const { client } = makeClient(relay.url);
		for (let i = 0; i < 5; i++)
			await client.postLiveActivity(SEND_TOKEN, {
				slot: "s",
				generation: 1,
				event: "update",
				contentState: {},
			});
		expect((await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" })).kind).toBe(
			"circuit_open",
		);
	});
});

describe("logging", () => {
	test("failures and budgets log reasons and counts, never the token, the envelope or a response body", async () => {
		const bodies = [
			json(503, { error: "apns_unavailable", detail: "BODY-SECRET" }),
			json(429, { budget: "alert", detail: "BODY-SECRET" }, { "retry-after": "3" }),
			new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/" } }),
		];
		let i = 0;
		const relay = startMockRelay(() => bodies[i++ % bodies.length] as Response);
		const { client, lines } = makeClient(relay.url, { failureThreshold: 2 });
		for (let n = 0; n < 6; n++)
			await client.postAlert(SEND_TOKEN, { envelope, priority: "normal" });
		const dead = startMockRelay(() => json(202, {}));
		dead.server.stop(true);
		await makeClient(dead.url, {
			logger: {
				info: (m) => lines.push(m),
				warn: (m, f) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
			},
		}).client.postAlert(SEND_TOKEN, { envelope, priority: "normal" });
		const log = lines.join("\n");
		expect(log.length).toBeGreaterThan(0);
		for (const secret of [
			SEND_TOKEN,
			"stoken-SECRET",
			envelope.c,
			"CIPHERTEXT-SECRET",
			envelope.e,
			envelope.d,
			"BODY-SECRET",
			"Bearer",
		]) {
			expect(log.includes(secret), `log leaked ${secret.slice(0, 12)}`).toBe(false);
		}
		expect(log).toContain("relay circuit open");
	});
});

describe("the configured URL", () => {
	const ok = (raw: string, allowLoopback = false) => canonicalizeRelayUrl(raw, { allowLoopback });
	const refused =
		(raw: string, allowLoopback = false) =>
		() =>
			canonicalizeRelayUrl(raw, { allowLoopback });

	test("canonicalizes an https URL to origin and path with no trailing slash", () => {
		expect(ok("https://relay.example.com")).toBe("https://relay.example.com");
		expect(ok("https://relay.example.com/")).toBe("https://relay.example.com");
		expect(ok("  https://Relay.Example.com:8443/push///  ")).toBe(
			"https://relay.example.com:8443/push",
		);
		expect(ok("https://relay.example.com:443")).toBe("https://relay.example.com");
	});

	test("refuses userinfo, query, fragment, other schemes and junk", () => {
		for (const raw of [
			`https://${"user"}:${"pw"}@relay.example.com`,
			"https://user@relay.example.com",
			"https://relay.example.com?token=1",
			"https://relay.example.com#frag",
			"ftp://relay.example.com",
			"ws://relay.example.com",
			"relay.example.com",
			"",
			"https://",
		]) {
			expect(refused(raw), raw).toThrow(RelayUrlError);
		}
	});

	test("refuses plain http except to loopback", () => {
		expect(refused("http://relay.example.com")).toThrow(/https/);
		expect(refused("http://192.0.2.10:8797")).toThrow(/https/);
		expect(ok("http://127.0.0.1:8797", true)).toBe("http://127.0.0.1:8797");
		expect(ok("http://localhost:8797/", true)).toBe("http://localhost:8797");
	});

	test("loopback is allowed outside production and refused in it, for http and https alike", () => {
		for (const raw of [
			"http://127.0.0.1:8797",
			"http://localhost:8797",
			"http://[::1]:8797",
			"https://localhost",
			"https://127.0.0.2",
		]) {
			expect(ok(raw, true), raw).toBeTruthy();
			expect(refused(raw, false), raw).toThrow(/loopback/);
		}
	});

	test("loadRelayUrl: unset or blank means push is off; invalid means an error; NODE_ENV decides loopback", () => {
		expect(loadRelayUrl({})).toBeNull();
		expect(loadRelayUrl({ AGENTPULSE_PUSH_RELAY_URL: "   " })).toBeNull();
		expect(loadRelayUrl({ AGENTPULSE_PUSH_RELAY_URL: "https://relay.example.com/" })).toBe(
			"https://relay.example.com",
		);
		expect(() => loadRelayUrl({ AGENTPULSE_PUSH_RELAY_URL: "nonsense" })).toThrow(RelayUrlError);
		expect(loadRelayUrl({ AGENTPULSE_PUSH_RELAY_URL: "http://127.0.0.1:8797" })).toBe(
			"http://127.0.0.1:8797",
		);
		expect(
			loadRelayUrl({ AGENTPULSE_PUSH_RELAY_URL: "http://127.0.0.1:8797", NODE_ENV: "development" }),
		).toBe("http://127.0.0.1:8797");
		expect(() =>
			loadRelayUrl({ AGENTPULSE_PUSH_RELAY_URL: "http://127.0.0.1:8797", NODE_ENV: "production" }),
		).toThrow(/loopback/);
	});
});
