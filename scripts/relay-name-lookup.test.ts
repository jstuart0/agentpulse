/**
 * The status line's name lookup through the relay: GET /api/v1/sessions/<id>?fields=displayName.
 * The relay gates it like the session detail (an excluded session is refused
 * locally and nothing is asked of the server), forwards the query so the server
 * can answer the small projection, and remembers a small successful answer for a
 * few seconds so a render doesn't cost a server round trip. The memory is never
 * a way around the exclude rules, never holds a miss or an error, never holds a
 * whole session detail, and forgets a session when its name is pushed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RelayModule = typeof import("./relay.ts");
let loaded: RelayModule | undefined;
async function mod(): Promise<RelayModule> {
	loaded ??= await import("./relay.ts?module");
	return loaded;
}
const RELAY_PATH = join(import.meta.dir, "relay.ts");

type Recorded = { method: string; path: string; search: string };
let tmp: string;
const stops: Array<() => unknown> = [];
let clock: number;
/** What the upstream answers for GET /api/v1/sessions/<id>*, by id. */
let answers: Record<string, () => Response>;
let requests: Recorded[];

const light = (id: string, name: string) => () =>
	Response.json({ session: { sessionId: id, displayName: name } });

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), "ap-relay-name-"));
	clock = Date.parse("2026-10-03T12:00:00.000Z");
	answers = {};
	requests = [];
});
afterEach(async () => {
	while (stops.length) await stops.pop()?.();
	await rm(tmp, { recursive: true, force: true });
});

async function start() {
	const upstream = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			requests.push({ method: req.method, path: url.pathname, search: url.search });
			const id = url.pathname.split("/")[4] ?? "";
			if (req.method === "PUT") return Response.json({ ok: true });
			return (
				answers[id] ?? (() => Response.json({ error: "Session not found" }, { status: 404 }))
			)();
		},
	});
	stops.push(() => upstream.stop(true));
	const stateDir = join(tmp, "state");
	await mkdir(stateDir, { recursive: true });
	const R = await mod();
	const relay = await R.startRelay(
		{
			remoteUrl: `http://127.0.0.1:${upstream.port}`,
			apiKey: "ap_test_key_0123456789abcdef",
			port: 0,
			codexNamePolicy: "codex",
			stateDir,
			configPath: null,
		},
		{
			timers: false,
			env: { HOME: join(tmp, "home") },
			scriptPath: RELAY_PATH,
			log: () => {},
			accountHome: () => undefined,
			now: () => clock,
		},
	);
	stops.push(() => relay.stop());
	return { relay, base: `http://127.0.0.1:${relay.port}` };
}
const LIGHT = "?fields=displayName";
const upstreamReads = () => requests.filter((r) => r.method === "GET").length;

describe("forwarding", () => {
	test("the query string reaches the server, so it can answer the small projection (the relay gates on the path only)", async () => {
		answers.s1 = light("s1", "brave-falcon");
		const { base } = await start();
		const res = await fetch(`${base}/api/v1/sessions/s1${LIGHT}`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ session: { sessionId: "s1", displayName: "brave-falcon" } });
		// If the relay dropped the query, the server would answer the whole detail.
		expect(requests).toEqual([{ method: "GET", path: "/api/v1/sessions/s1", search: LIGHT }]);
	});

	test("an unknown session is the server's 404, passed through (not cached, not 'excluded')", async () => {
		const { base } = await start();
		const res = await fetch(`${base}/api/v1/sessions/ghost${LIGHT}`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Session not found" });
	});
});

describe("an excluded session", () => {
	test("is refused locally with 404 { error: 'excluded' }, with the query on the URL too, and nothing is asked of the server", async () => {
		answers.ex = light("ex", "secret-name");
		const { relay, base } = await start();
		relay.ctx.state.exclude.excludedIds.set("ex", true);
		const res = await fetch(`${base}/api/v1/sessions/ex${LIGHT}`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "excluded" });
		// If the gate only matched the bare path, the server would have been asked here.
		expect(requests).toEqual([]);
	});

	test("one that was remembered as found is never served from memory once excluded, and its entry is dropped", async () => {
		answers.ex = light("ex", "secret-name");
		const { relay, base } = await start();
		expect((await fetch(`${base}/api/v1/sessions/ex${LIGHT}`)).status).toBe(200);
		expect(relay.ctx.state.nameCache.has("ex")).toBe(true);
		relay.ctx.state.exclude.excludedIds.set("ex", true);
		const res = await fetch(`${base}/api/v1/sessions/ex${LIGHT}`);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "excluded" });
		expect(relay.ctx.state.nameCache.has("ex")).toBe(false);
		expect(upstreamReads()).toBe(1);
	});
});

describe("the short memory of a successful answer", () => {
	test("a second lookup inside the window costs no server round trip, and says the same thing", async () => {
		answers.s1 = light("s1", "brave-falcon");
		const { base } = await start();
		const first = await (await fetch(`${base}/api/v1/sessions/s1${LIGHT}`)).text();
		clock += 1_000;
		const second = await (await fetch(`${base}/api/v1/sessions/s1${LIGHT}`)).text();
		expect(second).toBe(first);
		expect(upstreamReads()).toBe(1);
	});

	test("after the window the server is asked again, so a rename shows within seconds", async () => {
		answers.s1 = light("s1", "brave-falcon");
		const { base } = await start();
		await fetch(`${base}/api/v1/sessions/s1${LIGHT}`);
		answers.s1 = light("s1", "renamed-on-dashboard");
		clock += 4_000;
		expect(
			(
				(await (await fetch(`${base}/api/v1/sessions/s1${LIGHT}`)).json()) as {
					session: { displayName: string };
				}
			).session.displayName,
		).toBe("brave-falcon");
		clock += 2_000;
		expect(
			(
				(await (await fetch(`${base}/api/v1/sessions/s1${LIGHT}`)).json()) as {
					session: { displayName: string };
				}
			).session.displayName,
		).toBe("renamed-on-dashboard");
		expect(upstreamReads()).toBe(2);
	});

	test("pushing a name for the session forgets it at once, so the next lookup sees the push", async () => {
		answers.s1 = light("s1", "old-name");
		const { base } = await start();
		await fetch(`${base}/api/v1/sessions/s1${LIGHT}`);
		answers.s1 = light("s1", "native-name");
		await fetch(`${base}/api/v1/sessions/s1/native-name`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: '{"name":"native-name"}',
		});
		const after = (await (await fetch(`${base}/api/v1/sessions/s1${LIGHT}`)).json()) as {
			session: { displayName: string };
		};
		expect(after.session.displayName).toBe("native-name");
	});

	test("sessions are remembered separately", async () => {
		answers.a = light("a", "name-a");
		answers.b = light("b", "name-b");
		const { base } = await start();
		const read = async (id: string) =>
			(
				(await (await fetch(`${base}/api/v1/sessions/${id}${LIGHT}`)).json()) as {
					session: { displayName: string };
				}
			).session.displayName;
		expect([await read("a"), await read("b"), await read("a"), await read("b")]).toEqual([
			"name-a",
			"name-b",
			"name-a",
			"name-b",
		]);
		expect(upstreamReads()).toBe(2);
	});

	test("a miss and a server error are never remembered: the next lookup asks again", async () => {
		const { base } = await start();
		await fetch(`${base}/api/v1/sessions/ghost${LIGHT}`);
		await fetch(`${base}/api/v1/sessions/ghost${LIGHT}`);
		answers.boom = () => Response.json({ error: "down" }, { status: 500 });
		await fetch(`${base}/api/v1/sessions/boom${LIGHT}`);
		await fetch(`${base}/api/v1/sessions/boom${LIGHT}`);
		expect(upstreamReads()).toBe(4);
		// and a session that appears later is found at once
		answers.ghost = light("ghost", "appeared");
		const found = (await (await fetch(`${base}/api/v1/sessions/ghost${LIGHT}`)).json()) as {
			session: { displayName: string };
		};
		expect(found.session.displayName).toBe("appeared");
	});

	test("the full detail (no fields) is never remembered, and neither is any answer too big to be the small projection", async () => {
		answers.full = () =>
			Response.json({
				session: { sessionId: "full", displayName: "x" },
				events: [{ blob: "z".repeat(50_000) }],
			});
		const { relay, base } = await start();
		await fetch(`${base}/api/v1/sessions/full`);
		await fetch(`${base}/api/v1/sessions/full`);
		expect(upstreamReads()).toBe(2);
		// a server that predates the projection answers the whole detail to the light request
		await fetch(`${base}/api/v1/sessions/full${LIGHT}`);
		await fetch(`${base}/api/v1/sessions/full${LIGHT}`);
		expect(upstreamReads()).toBe(4);
		expect(relay.ctx.state.nameCache.size).toBe(0);
	});

	test("it is bounded: past the cap the oldest entries go", async () => {
		const { relay, base } = await start();
		const cap = (await mod()).NAME_CACHE_MAX_ENTRIES;
		for (let i = 0; i < cap + 20; i++) {
			answers[`s${i}`] = light(`s${i}`, `n${i}`);
			await fetch(`${base}/api/v1/sessions/s${i}${LIGHT}`);
			clock += 1;
		}
		expect(relay.ctx.state.nameCache.size).toBe(cap);
		expect(relay.ctx.state.nameCache.has("s0")).toBe(false);
		expect(relay.ctx.state.nameCache.has(`s${cap + 19}`)).toBe(true);
	});
});

describe("the proxy's allowlist is unchanged", () => {
	test("the same paths are allowed, whatever query they carry", async () => {
		const R = await mod();
		expect(R.isForwardAllowed("GET", "/api/v1/sessions/abc")).toBe(true);
		expect(R.isForwardAllowed("GET", "/api/v1/sessions")).toBe(false);
		expect(R.isForwardAllowed("GET", "/api/v1/sessions/abc/claude-md")).toBe(false);
	});
});
