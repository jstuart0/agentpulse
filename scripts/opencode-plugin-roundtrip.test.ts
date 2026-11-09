/**
 * AGEN-141 plan step 17l: the plugins against the real path. Each Phase 0
 * capture is replayed, in order, through one plugin instance; what it POSTs
 * must contain the hand-written envelopes (in order; the fixtures are the
 * contract) and pass the wire parser, then go over HTTP to the real ingest
 * routes, and through the real relay with one excluded and one allowed cwd.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import "../src/server/services/ai/__test_db.js";
import { parseOpenCodeEnvelope } from "../src/shared/opencode-wire.ts";
import {
	FIXTURES,
	type Line,
	loadPluginModule,
	readCapture,
	readEnvelopes,
	replayCapture,
	resetRecord,
	scratchDir,
	settle,
	startCollector,
} from "./lib/opencode-plugin-kit.ts";

const { config } = await import("../src/server/config.js");
const { getDb, initializeDatabase } = await import("../src/server/db/client.js");
const { events, sessions } = await import("../src/server/db/schema/index.js");
const { ingest, getInFlightCount } = await import("../src/server/routes/ingest.js");
const { _resetBucketsForTest } = await import("../src/server/middleware/hook-rate-limit.js");
const { _resetCountersForTest } = await import("../src/server/routes/ingest-counters.js");
const { _resetEventDedupForTest } = await import("../src/server/services/event-dedup.js");

const app = new Hono().route("/api/v1", ingest);
const originalDisableAuth = config.disableAuth;
beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});
afterAll(() => {
	config.disableAuth = originalDisableAuth;
});
beforeEach(async () => {
	_resetBucketsForTest();
	_resetCountersForTest();
	_resetEventDedupForTest();
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});

const manifest = JSON.parse(readFileSync(join(FIXTURES, "manifest.json"), "utf8"))
	.fixtures as Array<{
	line: Line;
	name: string;
	status: string;
	file: string;
}>;
const HAS_ENVELOPES = new Set<string>();
for (const m of manifest) {
	try {
		readEnvelopes(m.line, m.name);
		HAS_ENVELOPES.add(`${m.line}/${m.name}`);
	} catch {}
}
const captured = manifest.filter(
	(m) =>
		m.status === "captured" &&
		HAS_ENVELOPES.has(`${m.line}/${m.name}`) &&
		readCapturedDirs(m.line, m.name),
);

function readCapturedDirs(line: Line, name: string): boolean {
	try {
		const cap = readCapture(line, name);
		return new Set(cap.records.filter((r) => r.kind === "load").map((r) => r.instance)).size === 1;
	} catch {
		return false;
	}
}

const norm = (x: unknown): string =>
	JSON.stringify(x, (_k, v) =>
		v && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v).sort())
			: v,
	);

async function quiesce() {
	for (let i = 0; i < 400 && getInFlightCount() > 0; i++)
		await new Promise((r) => setTimeout(r, 5));
	expect(getInFlightCount()).toBe(0);
}

async function toApp(body: unknown, headers: Record<string, string>) {
	const res = await app.request("/api/v1/hooks", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(200);
	await quiesce();
}

describe("17l replay of every capture through the plugin", () => {
	test("the population: the captured, single-instance fixtures of both lines", () => {
		expect(captured.filter((c) => c.line === "v1").length).toBeGreaterThanOrEqual(8);
		expect(captured.filter((c) => c.line === "v2").length).toBeGreaterThanOrEqual(8);
		expect(captured.some((c) => c.name === "child-session")).toBe(true);
	});

	for (const m of captured) {
		test(`${m.line}/${m.name}: the POST bodies contain the envelope fixtures, parse, and ingest to the canonical event types`, async () => {
			resetRecord(m.line);
			const c = startCollector();
			const plugin = await loadPluginModule(m.line, c.url, {
				env: { HOME: scratchDir("home"), PATH: "/usr/bin:/bin" },
			});
			const cap = readCapture(m.line, m.name);
			const dir = cap.records.find((r) => r.directory)?.directory as string;
			const { cleanup } = await replayCapture(m.line, cap, plugin, dir);
			await settle(m.line);
			(cleanup as (() => void) | undefined)?.();
			c.stop();
			const bodies = c.received.map((r) => r.body);
			for (const b of bodies) expect(parseOpenCodeEnvelope(b), norm(b)).not.toBeNull();

			const want = readEnvelopes(m.line, m.name);
			const canon = JSON.parse(
				readFileSync(join(FIXTURES, "canonical", m.line, `${m.name}.json`), "utf8"),
			).outputs as Array<{ semantic: { event: string } }>;
			let at = 0;
			want.forEach((w, i) => {
				if (canon[i]?.semantic.event === "drop") return;
				while (at < bodies.length && norm(bodies[at]) !== norm(w)) at++;
				expect(at, `envelope ${i} (${w.hook_event_name}) was not posted in order`).toBeLessThan(
					bodies.length,
				);
				at++;
			});

			for (const r of c.received)
				await toApp(r.body, {
					"X-Agent-Type": "opencode",
					"X-AgentPulse-Delivery-Id": r.headers["x-agentpulse-delivery-id"] as string,
				});
			const rows = await getDb().select().from(events);
			const root = want[0] as { session_id: string; parent_session_id?: string };
			const sessionIds = new Set(rows.map((r) => r.sessionId));
			expect(sessionIds.has(root.parent_session_id ?? root.session_id)).toBe(true);
			for (const s of await getDb().select().from(sessions)) expect(s.agentType).toBe("opencode");
			// A child's rows sit on its parent: the stored sessions are exactly the roots.
			const roots = new Set(
				bodies.map((b) => (b.parent_session_id as string | undefined) ?? (b.session_id as string)),
			);
			expect(sessionIds).toEqual(roots);
			const stored = rows.sort((a, b) => a.id - b.id).map((r) => r.eventType);
			let k = 0;
			for (const o of canon) {
				if (o.semantic.event === "drop") continue;
				while (k < stored.length && stored[k] !== o.semantic.event) k++;
				expect(k, `canonical ${o.semantic.event} missing from the stored rows`).toBeLessThan(
					stored.length,
				);
				k++;
			}
		});
	}
});

describe("17l through the real relay, one excluded and one allowed cwd", () => {
	let root: string;
	const stops: Array<() => unknown> = [];
	afterEach(async () => {
		while (stops.length) await stops.pop()?.();
	});

	for (const line of ["v1", "v2"] as const) {
		test(`${line}: the excluded directory's session stores 0 rows, the allowed one's stores them`, async () => {
			root = realpathSync(mkdtempSync(join(tmpdir(), "ap-oc-relay-")));
			const relayHome = join(root, "home");
			const state = join(root, "state");
			const secret = join(root, "work", "secret");
			const open = join(root, "work", "open");
			for (const d of [relayHome, state, secret, open, join(relayHome, ".agentpulse")])
				mkdirSync(d, { recursive: true });
			chmodSync(join(relayHome, ".agentpulse"), 0o700);
			writeFileSync(join(relayHome, ".agentpulse", "exclude"), `${secret}\n`, { mode: 0o600 });

			const R = await import("./relay.ts?module");
			const forwarded: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
			const fetchSpy = (async (input: unknown, init?: RequestInit) => {
				const headers: Record<string, string> = {};
				new Headers(init?.headers as HeadersInit).forEach((v, k) => {
					headers[k] = v;
				});
				forwarded.push({ url: String(input), body: String(init?.body ?? ""), headers });
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as unknown as typeof fetch;
			const relay = await R.startRelay(
				{
					remoteUrl: "http://upstream.invalid",
					apiKey: "ap_TESTKEY_roundtrip_0123456789",
					port: 0,
					codexNamePolicy: "codex",
					stateDir: state,
					configPath: null,
				},
				{
					timers: false,
					env: { HOME: relayHome },
					scriptPath: join(import.meta.dir, "relay.ts"),
					log: () => {},
					fetch: fetchSpy,
					accountHome: () => undefined,
				} as never,
			);
			stops.push(() => relay.stop());
			const url = `http://127.0.0.1:${relay.port}`;

			const run = async (name: string, dir: string, sidSuffix: string) => {
				resetRecord(line);
				const text = readFileSync(join(FIXTURES, "captures", line, `${name}.json`), "utf8");
				const cap = JSON.parse(
					text
						.split(`/scratch/proj/${line}-${name}`)
						.join(dir)
						.split(/ses_[A-Za-z0-9]{20,}/.exec(text)?.[0] ?? "ses_none")
						.join(`ses_${sidSuffix}`),
				);
				const plugin = await loadPluginModule(line, url, {
					env: { HOME: scratchDir("pluginhome"), PATH: "/usr/bin:/bin" },
				});
				const { cleanup } = await replayCapture(line, cap, plugin, dir);
				await settle(line);
				await new Promise((r) => setTimeout(r, 300));
				(cleanup as (() => void) | undefined)?.();
			};
			const pending = () => {
				const dir = join(state, "hook-queue", "pending");
				return existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith(".json")).length : 0;
			};
			await run("shell-tool", secret, "SECRETSESSION0000000001");
			await R.processHookQueue(relay.ctx);
			expect(pending()).toBe(0);
			expect(forwarded.length).toBe(0);
			await run("shell-tool", open, "OPENSESSION000000000001");
			expect(pending()).toBeGreaterThanOrEqual(5);
			await R.processHookQueue(relay.ctx);
			expect(forwarded.length).toBeGreaterThanOrEqual(5);
			for (const f of forwarded) {
				await toApp(JSON.parse(f.body), { "X-Agent-Type": "opencode" });
			}
			const ids = new Set((await getDb().select().from(events)).map((r) => r.sessionId));
			expect([...ids]).toEqual(["ses_OPENSESSION000000000001"]);
			const stored = await getDb()
				.select()
				.from(sessions)
				.where(eq(sessions.sessionId, "ses_OPENSESSION000000000001"));
			expect(stored[0]?.agentType).toBe("opencode");
		});
	}
});
