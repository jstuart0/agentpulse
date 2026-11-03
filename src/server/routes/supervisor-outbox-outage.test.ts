/**
 * The supervisor's offline outbox against the real server routes over real HTTP. The server is stopped,
 * the real gate, outbox and bridge-spool drain keep what they are given, the server comes back on the same
 * port, and what lands in the database is checked: order, occurrence times, the delivery receipt that makes a
 * lost acknowledgement harmless, and what the live listeners (the watcher, Live Activity) are not told.
 *
 * Outages are staged, never waited for: `stop(true)`, then a probe that is awaited to fail. The only waits
 * are the rebind retry (a just-closed port can take a moment to free) and the 5 s client timeout the
 * lost-acknowledgement scenarios exist to exercise.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELIVERY_ID_HEADER, REPLAY_HEADER } from "../../shared/hook-headers.js";
import { parseStoredTimestamp } from "../../shared/timestamp.js";
import type {
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	Session,
	SessionEvent,
} from "../../shared/types.js";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { events, managedDeliveryReceipts, managedSessions, sessions } = await import(
	"../db/schema/index.js"
);
const { eq, asc } = await import("drizzle-orm");
const { Hono } = await import("hono");
const { supervisorsAgentRouter } = await import("./supervisors.js");
const { createSupervisorEnrollmentToken } = await import("../auth/supervisor-auth.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { getEventsDeduplicatedCounts } = await import("../services/event-dedup.js");
const { sessionBus } = await import("../services/notifier.js");
const { WatcherRunner } = await import("../services/ai/runner.js");
const { LiveActivityPublisher } = await import("../services/push/live-activity-publisher.js");
const { createReportGate } = await import("../../supervisor/services/report-gate.js");
const { createReportOutbox, foldStateReports, outboxDirName } = await import(
	"../../supervisor/services/report-outbox.js"
);
const { createBridgeSpoolDrain } = await import("../../supervisor/services/bridge-spool.js");
const { parseErrorBodyField, sanitizeForLog } = await import(
	"../../supervisor/services/log-sanitize.js"
);
const {
	SupervisorNetworkError,
	SupervisorRequestError,
	createCredentialTripwire,
	parseRetryAfterMs,
} = await import("../../supervisor/services/report-resilience.js");

const app = new Hono().route("/api/v1", supervisorsAgentRouter);
const originalDisableAuth = config.disableAuth;
const REQUEST_TIMEOUT_MS = 5_000;
const HOUR = 3_600_000;
const NONCE = "0123456789abcdef0123456789abcdef";

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
});
afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
});

// ── the server, on a port that can be taken away and given back ──────────────────────────────

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}
const deferred = (): Deferred => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

interface Seen {
	path: string;
	deliveryId: string | null;
	replay: boolean;
	body: string;
}

async function startServer(port: number, handler: (req: Request) => Promise<Response>) {
	let lastError: unknown;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			return Bun.serve({ port, hostname: "127.0.0.1", fetch: handler });
		} catch (error) {
			lastError = error;
			if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
			await Bun.sleep(50);
		}
	}
	throw new Error(`couldn't rebind port ${port}: ${String(lastError)}`);
}

async function registerSupervisor(): Promise<{ id: string; credential: string }> {
	const { token } = await createSupervisorEnrollmentToken(
		`outage-${crypto.randomUUID()}`,
		null,
		null,
	);
	const id = crypto.randomUUID();
	const res = await app.request("/api/v1/supervisors/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			hostName: "outage-host",
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			enrollmentToken: token,
			id,
		}),
	});
	return {
		id,
		credential: ((await res.json()) as { supervisorCredential: string }).supervisorCredential,
	};
}

// ── one world: a server, a supervisor home, and the supervisor's own parts ───────────────────

async function world() {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "ap-outage-")));
	const work = join(home, "work", "project");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
	const supervisor = await registerSupervisor();
	const seen: Seen[] = [];
	let skewMs = 0;
	const now = () => Date.now() + skewMs;
	let afterServe: ((seen: Seen) => void) | null = null;
	let hang: { match: (req: Request) => boolean; stored: Deferred; release: Deferred } | null = null;
	const releases: Deferred[] = [];

	const handler = async (req: Request) => {
		const body = await req.clone().text();
		seen.push({
			path: new URL(req.url).pathname,
			deliveryId: req.headers.get(DELIVERY_ID_HEADER),
			replay: req.headers.get(REPLAY_HEADER) === "1",
			body,
		});
		const res = await app.fetch(req);
		await res.clone().text();
		afterServe?.(seen[seen.length - 1] as Seen);
		if (hang?.match(req)) {
			const armed = hang;
			hang = null;
			armed.stored.resolve();
			await armed.release.promise;
		}
		return res;
	};
	let server = await startServer(0, handler);
	const port = server.port as number;
	const baseUrl = `http://127.0.0.1:${port}`;

	/** The supervisor's transport: index.ts's request(), headers, wrapping and timeout included. */
	async function request(path: string, options?: RequestInit): Promise<unknown> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-AgentPulse-Supervisor-Token": supervisor.credential,
		};
		const callerHeaders = new Headers(options?.headers);
		for (const name of [DELIVERY_ID_HEADER, REPLAY_HEADER]) {
			const value = callerHeaders.get(name);
			if (value) headers[name] = value;
		}
		let res: Response;
		try {
			res = await fetch(`${baseUrl}/api/v1${path}`, {
				...options,
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (cause) {
			throw new SupervisorNetworkError(cause);
		}
		if (!res.ok) {
			const bodyError = await parseErrorBodyField(res);
			throw new SupervisorRequestError(
				res.status,
				sanitizeForLog(res.statusText),
				bodyError,
				parseRetryAfterMs(res.headers.get("retry-after"), Date.now()),
			);
		}
		try {
			return await res.json();
		} catch (cause) {
			throw new SupervisorNetworkError(cause);
		}
	}

	function parts() {
		const outbox = createReportOutbox({ home, supervisorId: supervisor.id, now, log: () => {} });
		const tripwire = createCredentialTripwire({ now, canConfirm: false });
		const gate = createReportGate({
			request,
			supervisorId: supervisor.id,
			home,
			now,
			log: () => {},
			outbox,
			credentialTripwire: tripwire,
			onCredentialRejected: () => {},
			random: () => 0,
			schedule: (fn) => fn(),
		});
		const drain = createBridgeSpoolDrain({
			gate,
			home,
			now,
			log: () => {},
			credentialTripwire: tripwire,
			onCredentialRejected: () => {},
		});
		return { outbox, gate, drain };
	}

	let side = parts();
	await side.outbox.ready();

	const w = {
		home,
		work,
		supervisor,
		seen,
		get outbox() {
			return side.outbox;
		},
		get gate() {
			return side.gate;
		},
		get drain() {
			return side.drain;
		},
		request,
		now,
		/** Runs after the real route has answered each request (a rule can appear exactly then). */
		onServed: (fn: ((seen: Seen) => void) | null) => {
			afterServe = fn;
		},
		skew: (ms: number) => {
			skewMs += ms;
		},
		/** Tears the supervisor's parts down and builds new ones on the same home, as a restart does. */
		async restart() {
			side = parts();
			await side.outbox.ready();
		},
		/** Takes the port away, then proves it: a probe that is awaited to fail. */
		async outage() {
			await server.stop(true);
			await expect(
				request(`/supervisors/${supervisor.id}/heartbeat`, { method: "POST" }),
			).rejects.toBeInstanceOf(SupervisorNetworkError);
			side.gate.noteServerUnreachable();
		},
		/** Gives the same port back and tells the gate the server answers again. Returns when it was back. */
		async rebind() {
			server = await startServer(port, handler);
			const at = Date.now();
			side.gate.noteServerReachable();
			return at;
		},
		/** The next events POST is answered by the real route, then never completes: the client times out. */
		armLostAck() {
			const armed = {
				match: (req: Request) => req.url.includes("/events"),
				stored: deferred(),
				release: deferred(),
			};
			hang = armed;
			releases.push(armed.release);
			return armed.stored.promise;
		},
		async post(path: string, body: unknown, headers?: Record<string, string>) {
			return request(path, { method: "POST", body: JSON.stringify(body), headers });
		},
		/** Owned by this supervisor, as a launch it claimed. */
		async own(sessionId: string) {
			await seedOwnedLaunch(sessionId, supervisor.id);
		},
		async cleanup() {
			for (const r of releases) r.resolve();
			await server.stop(true);
			rmSync(home, { recursive: true, force: true });
		},
	};
	return w;
}
type World = Awaited<ReturnType<typeof world>>;

// ── database reads and builders ──────────────────────────────────────────────────────────────

const rowsOf = async (sessionId: string) =>
	getDb().select().from(events).where(eq(events.sessionId, sessionId)).orderBy(asc(events.id));
const sessionRow = async (id: string) =>
	(await getDb().select().from(sessions).where(eq(sessions.sessionId, id)))[0];
const managedRow = async (id: string) =>
	(await getDb().select().from(managedSessions).where(eq(managedSessions.sessionId, id)))[0];
const receiptsOf = async (id: string) =>
	(
		await getDb()
			.select()
			.from(managedDeliveryReceipts)
			.where(eq(managedDeliveryReceipts.sessionId, id))
	).length;
const settle = async () => {
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const uid = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

const wholeSecond = (offsetMs: number) =>
	new Date(Math.floor((Date.now() + offsetMs) / 1000) * 1000).toISOString();
const batch = (
	content: string,
	occurredAt?: string,
	extra: Partial<ManagedSessionEventInput> = {},
) =>
	[
		{
			eventType: "ManagedProbe",
			category: "system_event",
			content,
			...(occurredAt ? { occurredAt } : {}),
			...extra,
		},
	] as ManagedSessionEventInput[];
const stateOf = (sessionId: string, extra: Partial<ManagedSessionStateInput> = {}) =>
	({
		sessionId,
		agentType: "claude_code",
		status: "active",
		managedState: "headless",
		...extra,
	}) as ManagedSessionStateInput;

/** Writes one bridge's spool the way the terminal bridge does: bridge.json with the launch nonce and numbered envelopes. */
function writeBridgeSpool(
	home: string,
	id: string,
	files: Array<{ kind: "state" | "events"; body: unknown; at?: string }>,
) {
	const dir = join(home, ".agentpulse", "interactive", id);
	const reports = join(dir, "reports");
	mkdirSync(reports, { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse", "interactive"), 0o700);
	chmodSync(dir, 0o700);
	chmodSync(reports, 0o700);
	const config = join(dir, "bridge.json");
	writeFileSync(config, JSON.stringify({ session_id: id, cwd: "/anywhere", launchNonce: NONCE }), {
		mode: 0o600,
	});
	chmodSync(config, 0o600);
	files.forEach((file, i) => {
		const path = join(reports, `${String(i + 1).padStart(16, "0")}.json`);
		writeFileSync(
			path,
			JSON.stringify({
				v: 1,
				nonce: NONCE,
				kind: file.kind,
				occurredAt: file.at ?? new Date(Date.now() - 60_000).toISOString(),
				...(file.kind === "events" ? { deliveryId: `bridge-${id}-${i + 1}-abcdefgh` } : {}),
				body: file.body,
			}),
			{ mode: 0o600 },
		);
		chmodSync(path, 0o600);
	});
	return reports;
}
const bridgeMeta = (dir: string, extra: Record<string, unknown> = {}) => ({
	launchMode: "interactive_terminal",
	interactiveBridge: { socketPath: join(dir, "control.sock"), bridgePid: 4242, childPid: 4243 },
	...extra,
});
const spoolFiles = (reports: string) =>
	existsSync(reports) ? readdirSync(reports).filter((n) => /^\d{16}\.json$/.test(n)) : [];
const outboxFiles = (home: string) => {
	const root = join(home, ".agentpulse", "supervisor-outbox");
	return existsSync(root) ? readdirSync(root).filter((n) => n.startsWith("s-")) : [];
};

// ── the transport copy must not drift from the supervisor's ─────────────────────────────────

describe("the test's request() mirrors the supervisor's transport", () => {
	/** What both must do, as fragments that survive formatting; the copy is checked against the real one. */
	const SHAPE: Array<[string, RegExp]> = [
		["the content type", /"Content-Type": "application\/json"/],
		["the credential header", /"X-AgentPulse-Supervisor-Token"/],
		["only the delivery id and the replay marker pass", /DELIVERY_ID_HEADER,\s*REPLAY_HEADER\]/],
		["a timeout on the fetch", /signal: AbortSignal\.timeout\(/],
		[
			"no answer is a network error",
			/catch \(cause\) \{[^}]*throw new SupervisorNetworkError\(cause\)/,
		],
		["an HTTP error carries the body's error and Retry-After", /new SupervisorRequestError\(/],
		["the server's Retry-After is parsed", /parseRetryAfterMs\(res\.headers\.get\("retry-after"\)/],
		[
			"a 2xx that isn't JSON is a network error",
			/try \{\s*return await res\.json\(\);\s*\} catch \(cause\) \{[^}]*throw new SupervisorNetworkError\(cause\)/,
		],
	];
	const real = readFileSync(join(import.meta.dir, "../../supervisor/index.ts"), "utf-8");
	const copy = readFileSync(import.meta.path, "utf-8");
	const requestOf = (text: string, marker: string) => text.slice(text.indexOf(marker));

	for (const [label, pattern] of SHAPE) {
		test(label, () => {
			// the real one names its caller-header list in a constant above the function, so the whole file is read
			expect(pattern.test(real), "index.ts").toBe(true);
			expect(pattern.test(requestOf(copy, "async function request(")), "this file's copy").toBe(
				true,
			);
		});
	}
});

// ── scenario 1 ───────────────────────────────────────────────────────────────────────────────

describe("1. an outage, including the bridge path", () => {
	test("everything queued comes back in order with its own times, and the live listeners hear almost nothing", async () => {
		const w = await world();
		const main = uid("main");
		const bridge = uid("bridge");
		const runner = new WatcherRunner();
		const onBoundary = spyOn(
			runner as unknown as { onBoundary: (...a: unknown[]) => Promise<void> },
			"onBoundary",
		).mockImplementation(async () => {});
		runner.attachListeners();

		// a Live Activity publisher on the real bus, with fakes only for what is outside it
		const sent: Array<{ event: string; trace: number[] }> = [];
		const timers: Array<{ fn: () => void; cancelled: boolean }> = [];
		const device = {
			device: {
				id: "phone",
				userId: "alice",
				platform: "ios",
				relayDeviceId: "relay-phone",
				ownerlessKeyId: null,
				sendTokenCiphertext: "stored",
				kid: "kid",
				publicKey: "AAAA",
				clientServerRef: "ref",
				prefs: {},
			},
			role: "member",
		};
		const publisher = new LiveActivityPublisher({
			service: {
				sendActivityUpdate: async (
					d: { id: string },
					update: { event: string; contentState: { trace: number[] } },
				) => {
					sent.push({ event: update.event, trace: update.contentState.trace });
					return { deviceId: d.id, slot: "slot-1", status: "sent" };
				},
			} as never,
			store: { liveRows: async () => [], endRow: async () => {} },
			readSession: async () => ({
				ownerUserId: "alice",
				status: "working",
				toolCount: 0,
				archived: false,
			}),
			eligibleDevices: async () => [device as never],
			eligibleDevice: async () => device as never,
			readOwners: async (ids: string[]) => new Map(ids.map((i) => [i, "alice"])),
			mode: async () => "team",
			bus: sessionBus,
			intervalMs: 3_600_000,
			schedule: (fn) => {
				const timer = { fn, cancelled: false };
				timers.push(timer);
				return () => {
					timer.cancelled = true;
				};
			},
			logger: { info: () => {}, warn: () => {} },
		});
		publisher.start();

		const lateUpdates: Session[] = [];
		const lateEvents: SessionEvent[] = [];
		const liveEvents: SessionEvent[] = [];
		const onUpdated = (s: Session, meta?: { late?: true }) => {
			if (meta?.late) lateUpdates.push(s);
		};
		const onEvent = (p: { event: SessionEvent; late?: true }) => {
			(p.late ? lateEvents : liveEvents).push(p.event);
		};
		sessionBus.on("session_updated", onUpdated);
		sessionBus.on("session_event", onEvent);
		try {
			await w.own(main);
			await w.own(bridge);
			w.gate.noteCwd(main, w.work);
			w.gate.noteLaunch(uid("launch"), bridge, w.work, { interactive: true });

			// live: the session exists, and a live turn end wakes the watcher (the positive control)
			await w.gate.reportState(stateOf(main, { cwd: w.work, agentType: "claude_code" }));
			expect(await w.gate.reportEvents(main, batch("live-1", wholeSecond(-600_000)))).toBe("sent");
			expect(
				await w.gate.reportEvents(
					main,
					batch("live-stop", wholeSecond(-590_000), { eventType: "Stop" }),
				),
			).toBe("sent");
			await settle();
			expect(onBoundary, "a live turn end does wake the watcher").toHaveBeenCalled();
			expect(liveEvents.length).toBeGreaterThanOrEqual(2);
			onBoundary.mockClear();
			const liveRows = (await rowsOf(main)).length;
			expect(liveRows).toBe(2);
			// a phone follows the session from here on; following sends the first state
			await publisher.follow({
				deviceId: "phone",
				sessionId: main,
				slot: "slot-1",
				generation: 1,
				startedAtMs: Date.now(),
			});
			const baseline = sent.length;

			await w.outage();
			const stamps = [wholeSecond(-300_000), wholeSecond(-240_000), wholeSecond(-180_000)];
			expect(await w.gate.reportEvents(main, batch("q1", stamps[0]))).toBe("queued");
			expect(
				(await w.gate.reportState(stateOf(main, { desiredThreadTitle: "the title" }))).outcome,
			).toBe("queued");
			expect(await w.gate.reportEvents(main, batch("q2", stamps[1], { eventType: "Stop" }))).toBe(
				"queued",
			);
			expect(await w.gate.reportEvents(main, batch("q3", stamps[2]))).toBe("queued");
			expect(
				(
					await w.gate.reportState(
						stateOf(main, { status: "completed", managedState: "completed" }),
					)
				).outcome,
			).toBe("queued");
			const bridgeStamps = [wholeSecond(-200_000), wholeSecond(-100_000)];
			const reports = writeBridgeSpool(w.home, bridge, [
				{
					kind: "state",
					body: {
						sessionId: bridge,
						status: "active",
						managedState: "interactive_terminal",
						providerSessionId: bridge,
						correlationSource: "launch_correlation_id",
						metadata: bridgeMeta(join(w.home, ".agentpulse", "interactive", bridge)),
					},
				},
				{
					kind: "events",
					body: {
						events: [
							{
								eventType: "InteractivePromptObserved",
								category: "prompt",
								content: "typed-1",
								rawPayload: { source: "host_terminal" },
							},
						],
					},
					at: bridgeStamps[0],
				},
				{
					kind: "events",
					body: {
						events: [
							{
								eventType: "InteractivePromptObserved",
								category: "prompt",
								content: "typed-2",
								rawPayload: { source: "host_terminal" },
							},
						],
					},
					at: bridgeStamps[1],
				},
			]);

			// on disk, and the database has not moved
			expect(outboxFiles(w.home)).toHaveLength(1);
			expect(spoolFiles(reports)).toHaveLength(3);
			expect((await rowsOf(main)).length).toBe(liveRows);
			expect(await rowsOf(bridge)).toHaveLength(0);
			expect((await sessionRow(main))?.status).toBe("active");
			lateUpdates.length = 0;
			lateEvents.length = 0;

			const rebindAt = await w.rebind();
			const rebindSecond = Math.floor(rebindAt / 1000) * 1000;
			await w.gate.flush();
			await w.drain.drain();

			// every queued row, in id order, each with the time it was stamped when it was queued
			const rows = await rowsOf(main);
			expect(rows.map((r) => r.content)).toEqual(["live-1", "live-stop", "q1", "q2", "q3"]);
			expect(rows.slice(2).map((r) => r.occurredAt)).toEqual(stamps);
			for (const row of rows.slice(2)) {
				expect(parseStoredTimestamp(row.createdAt) as number).toBeGreaterThanOrEqual(rebindSecond);
			}
			const after = await sessionRow(main);
			expect(after?.status).toBe("completed");
			expect(parseStoredTimestamp(String(after?.lastActivityAt)) as number).toBeGreaterThanOrEqual(
				rebindSecond,
			);
			// the title report went out in its place, before the terminal one that (as on the server) resets it
			const stateBodies = w.seen.filter(
				(x) => x.path.endsWith("/managed-session-state") && x.replay,
			);
			const mainStates = stateBodies
				.map((x) => JSON.parse(x.body) as Record<string, unknown>)
				.filter((b) => b.sessionId === main);
			expect(mainStates.map((b) => [b.desiredThreadTitle ?? null, b.status ?? null])).toEqual([
				["the title", "active"],
				[null, "completed"],
			]);
			expect((await rowsOf(bridge)).map((r) => r.content)).toEqual(["typed-1", "typed-2"]);
			expect(
				(await rowsOf(bridge)).map((r) => r.occurredAt),
				"the bridge's own times, not the time it was sent",
			).toEqual(bridgeStamps);
			expect(outboxFiles(w.home)).toEqual([]);
			expect(spoolFiles(reports)).toEqual([]);
			expect(w.outbox.summary().pending).toBe(0);

			// the replay was marked late on the bus, and nothing reacted to it as if it were happening now
			expect(lateEvents.length).toBeGreaterThanOrEqual(5);
			expect(lateUpdates.length, "several late updates happened").toBeGreaterThanOrEqual(4);
			await settle();
			expect(onBoundary, "no wake for a replayed turn end").not.toHaveBeenCalled();
			// Live Activity: every late update coalesced into one pending refresh, and no event reached the trace
			expect(sent.length, "nothing was published while the replay ran").toBe(baseline);
			expect(
				timers.filter((t) => !t.cancelled),
				"one refresh for the whole replay",
			).toHaveLength(1);
			for (const timer of timers.filter((t) => !t.cancelled)) timer.fn();
			await settle();
			expect(sent.length, "exactly one publish").toBe(baseline + 1);
			expect(sent[baseline]?.event, "the replayed terminal state ends the activity").toBe("end");
			expect(
				sent.every((s) => s.trace.every((n) => n === 0)),
				"late events never fill the trace",
			).toBe(true);
		} finally {
			sessionBus.off("session_updated", onUpdated);
			sessionBus.off("session_event", onEvent);
			publisher.stop();
			runner.detachListeners();
			await w.cleanup();
		}
	}, 60_000);
});

// ── scenarios 2 and 3 ────────────────────────────────────────────────────────────────────────

async function filler(w: World, sessionId: string, n = 60) {
	await w.post(`/supervisors/${w.supervisor.id}/managed-sessions/${sessionId}/events`, {
		events: Array.from({ length: n }, (_, i) => ({
			eventType: "ManagedProbe",
			category: "system_event",
			content: `filler-${sessionId}-${i}`,
		})),
	});
}

describe("2. a lost acknowledgement", () => {
	test("the replay is the same bytes, the receipt recognises it, and no row is added", async () => {
		const w = await world();
		try {
			const id = uid("lost-ack");
			await w.own(id);
			await w.gate.reportState(stateOf(id));
			const stored = w.armLostAck();
			const outcome = await w.gate.reportEvents(id, batch("a", wholeSecond(-60_000)));
			await stored;
			expect(outcome, "the client gave up waiting").toBe("queued");
			expect(await rowsOf(id)).toHaveLength(1);
			await filler(w, id);
			const before = (await rowsOf(id)).length;
			const retries = getEventsDeduplicatedCounts().deliveryRetry;

			w.gate.noteServerReachable();
			await w.gate.flush();

			expect(getEventsDeduplicatedCounts().deliveryRetry - retries).toBe(1);
			expect((await rowsOf(id)).length).toBe(before);
			const sends = w.seen.filter((s) => s.path.endsWith(`/${id}/events`) && s.deliveryId);
			expect(sends).toHaveLength(2);
			expect(sends[1]?.body).toBe(sends[0]?.body);
			expect(sends[1]?.deliveryId).toBe(sends[0]?.deliveryId);
			expect(sends[1]?.replay).toBe(true);
			expect(w.outbox.summary().pending).toBe(0);
		} finally {
			await w.cleanup();
		}
	}, 60_000);
});

describe("3. every row dropped by the window on the first attempt", () => {
	test("the receipt still exists, so a replay after the window moved on adds nothing", async () => {
		const w = await world();
		try {
			const id = uid("window");
			await w.own(id);
			await w.gate.reportState(stateOf(id));
			// the same events, sent live just before and without a delivery id
			const same = batch("same-content", wholeSecond(-60_000));
			await w.post(`/supervisors/${w.supervisor.id}/managed-sessions/${id}/events`, {
				events: same,
			});
			expect(await rowsOf(id)).toHaveLength(1);

			const stored = w.armLostAck();
			expect(await w.gate.reportEvents(id, same)).toBe("queued");
			await stored;
			expect(await rowsOf(id), "the window dropped them all").toHaveLength(1);
			expect(await receiptsOf(id), "and the receipt was written anyway").toBe(1);

			await filler(w, id);
			const before = (await rowsOf(id)).length;
			w.gate.noteServerReachable();
			await w.gate.flush();
			expect((await rowsOf(id)).length, "a replay stores nothing").toBe(before);
			expect(await receiptsOf(id)).toBe(1);
		} finally {
			await w.cleanup();
		}
	}, 60_000);
});

// ── scenario 4 ───────────────────────────────────────────────────────────────────────────────

describe("4. a session the server has never seen", () => {
	test("aged past a day it replays [state, ManagedEventsLost]; the row exists, is owned, and keeps the creating report's fields", async () => {
		const w = await world();
		try {
			const id = uid("aged");
			await w.own(id);
			w.gate.noteCwd(id, w.work);
			await w.outage();
			expect(
				(
					await w.gate.reportState(
						stateOf(id, {
							agentType: "codex_cli",
							cwd: w.work,
							model: "model-x",
							desiredThreadTitle: "aged title",
						}),
					)
				).outcome,
			).toBe("queued");
			const lostFrom = Date.now();
			expect(await w.gate.reportEvents(id, batch("old"))).toBe("queued");
			const lostTo = Date.now();
			w.skew(25 * HOUR);
			await w.rebind();
			const mark = w.seen.length;
			await w.gate.flush();

			const calls = w.seen.slice(mark).map((s) => s.path.split("/").pop());
			expect(calls).toEqual(["managed-session-state", "events"]);
			const row = await sessionRow(id);
			expect(row?.agentType).toBe("codex_cli");
			expect(row?.cwd).toBe(w.work);
			expect(row?.model).toBe("model-x");
			expect(row?.displayName, "the creating report's title names the session").toBe("aged title");
			expect((await managedRow(id))?.supervisorId).toBe(w.supervisor.id);
			const rows = await rowsOf(id);
			expect(rows.map((r) => r.eventType)).toEqual(["ManagedEventsLost"]);
			// the gap is stamped with when the first lost event was queued, not when it was sent
			const lostAt = parseStoredTimestamp(rows[0]?.occurredAt as string) as number;
			expect(lostAt).toBeGreaterThanOrEqual(lostFrom);
			expect(lostAt).toBeLessThanOrEqual(lostTo);
			expect(w.outbox.summary().pending).toBe(0);
		} finally {
			await w.cleanup();
		}
	}, 60_000);

	test("[events, state, patch] for a row-less session: the creating report goes first, then the events, and the row keeps agentType, cwd and model", async () => {
		const w = await world();
		try {
			const id = uid("fold-first");
			await w.own(id);
			w.gate.noteCwd(id, w.work);
			await w.outage();
			expect(await w.gate.reportEvents(id, batch("early", wholeSecond(-60_000)))).toBe("queued");
			await w.gate.reportState(
				stateOf(id, {
					agentType: "codex_cli",
					cwd: w.work,
					model: "model-x",
					desiredThreadTitle: "t1",
				}),
			);
			await w.gate.reportState({
				sessionId: id,
				status: "completed",
				managedState: "completed",
			} as ManagedSessionStateInput);
			await w.rebind();
			const mark = w.seen.length;
			await w.gate.flush();

			const calls = w.seen.slice(mark).map((s) => s.path.split("/").pop());
			expect(calls).toEqual(["events", "managed-session-state", "events", "managed-session-state"]);
			const row = await sessionRow(id);
			expect(row?.agentType).toBe("codex_cli");
			expect(row?.cwd).toBe(w.work);
			expect(row?.model).toBe("model-x");
			expect(row?.status).toBe("completed");
			expect(row?.displayName, "the creating report's title names the session").toBe("t1");
			expect((await managedRow(id))?.desiredThreadTitle).toBe("t1");
			expect((await rowsOf(id)).map((r) => r.content)).toEqual(["early"]);
			expect(w.outbox.summary().pending).toBe(0);
		} finally {
			await w.cleanup();
		}
	}, 60_000);
});

// ── scenario 5 ───────────────────────────────────────────────────────────────────────────────

describe("5. a restart in the middle of an outage", () => {
	test("a rebuilt gate, outbox and drain deliver what the old ones kept, the bridge spool included", async () => {
		const w = await world();
		try {
			const id = uid("restart");
			const bridge = uid("rb");
			await w.own(id);
			await w.own(bridge);
			w.gate.noteCwd(id, w.work);
			w.gate.noteLaunch(uid("launch"), bridge, w.work, { interactive: true });
			await w.outage();
			const stamps = [wholeSecond(-120_000), wholeSecond(-60_000)];
			await w.gate.reportEvents(id, batch("r1", stamps[0]));
			await w.gate.reportState(stateOf(id, { cwd: w.work }));
			await w.gate.reportEvents(id, batch("r2", stamps[1]));
			const typedAt = wholeSecond(-30_000);
			const reports = writeBridgeSpool(w.home, bridge, [
				{
					kind: "state",
					body: {
						sessionId: bridge,
						status: "active",
						managedState: "interactive_terminal",
						providerSessionId: bridge,
						correlationSource: "launch_correlation_id",
						metadata: bridgeMeta(join(w.home, ".agentpulse", "interactive", bridge)),
					},
				},
				{
					kind: "events",
					body: {
						events: [
							{
								eventType: "InteractivePromptObserved",
								category: "prompt",
								content: "typed",
								rawPayload: { source: "host_terminal" },
							},
						],
					},
					at: typedAt,
				},
			]);

			await w.restart();
			expect(
				w.gate.isInteractiveLaunch(bridge),
				"the interactive launch outlived the process",
			).toBe(true);
			expect(w.outbox.summary().pending).toBe(3);
			await w.rebind();
			await w.gate.flush();
			await w.drain.drain();

			expect((await rowsOf(id)).map((r) => r.content)).toEqual(["r1", "r2"]);
			expect((await rowsOf(id)).map((r) => r.occurredAt)).toEqual(stamps);
			expect((await rowsOf(bridge)).map((r) => [r.content, r.occurredAt])).toEqual([
				["typed", typedAt],
			]);
			expect(outboxFiles(w.home)).toEqual([]);
			expect(spoolFiles(reports)).toEqual([]);
		} finally {
			await w.cleanup();
		}
	}, 60_000);
});

// ── scenario 6 ───────────────────────────────────────────────────────────────────────────────

describe("6. folding queued state reports equals sending them in order", () => {
	const VOLATILE = new Set([
		"id",
		"sessionId",
		"createdAt",
		"updatedAt",
		"lastActivityAt",
		"startedAt",
		"endedAt",
		"displayName",
		"launchRequestId",
		"lastProviderSyncAt",
		"providerSessionId",
	]);
	/** A row without ids and times; a title the server generated (random per session) is masked, one a report named is kept. */
	const strip = (row: Record<string, unknown> | undefined, named: unknown[] = []) =>
		Object.fromEntries(
			Object.entries(row ?? {})
				.filter(([k]) => !VOLATILE.has(k))
				.map(([k, v]) => [k, k === "desiredThreadTitle" && !named.includes(v) ? "<generated>" : v]),
		);

	const PAIRS: Array<
		[string, Partial<ManagedSessionStateInput>, Partial<ManagedSessionStateInput>]
	> = [
		["status: the later report's own value", { status: "active" }, { status: "completed" }],
		[
			"status: a later report that omits it resets it",
			{ status: "completed" },
			{ managedState: "headless" },
		],
		[
			"title: the later report's own value, even an absent one",
			{ desiredThreadTitle: "first" },
			{ managedState: "headless" },
		],
		[
			"cwd and model: kept when the later report omits them",
			{ cwd: "/tmp/x", model: "m1" },
			{ status: "active" },
		],
		[
			"cwd and model: replaced when the later report names them",
			{ cwd: "/tmp/x", model: "m1" },
			{ cwd: "/tmp/y", model: "m2" },
		],
		[
			"metadata: merged shallowly",
			{ metadata: { a: 1, keep: true } },
			{ metadata: { a: 2, b: 3 } },
		],
		[
			"other fields: the later or else the earlier",
			{ agentType: "codex_cli", providerThreadId: "th-1" },
			{ managedState: "managed" },
		],
	];

	for (const [label, a, b] of PAIRS) {
		test(label, async () => {
			const w = await world();
			try {
				const x = uid("fold-x");
				const y = uid("fold-y");
				await w.own(x);
				await w.own(y);
				const one = stateOf(x, a);
				// the second report's absent keys are really absent
				const twoBody = {
					sessionId: x,
					agentType: one.agentType,
					...b,
				} as ManagedSessionStateInput;
				// both rows exist before the pair: a title the creating report names is the session's name for good
				for (const sid of [x, y]) {
					await w.post(`/supervisors/${w.supervisor.id}/managed-session-state`, stateOf(sid));
				}
				await w.post(`/supervisors/${w.supervisor.id}/managed-session-state`, one);
				await w.post(`/supervisors/${w.supervisor.id}/managed-session-state`, twoBody);
				const folded = foldStateReports({ ...one, sessionId: y }, {
					...twoBody,
					sessionId: y,
				} as ManagedSessionStateInput);
				await w.post(`/supervisors/${w.supervisor.id}/managed-session-state`, folded);
				expect(strip((await sessionRow(y)) as never)).toEqual(
					strip((await sessionRow(x)) as never),
				);
				const named = [a.desiredThreadTitle, b.desiredThreadTitle];
				expect(strip((await managedRow(y)) as never, named)).toEqual(
					strip((await managedRow(x)) as never, named),
				);
			} finally {
				await w.cleanup();
			}
		}, 30_000);
	}

	test("the pairs cover every rule of the fold", () => {
		expect(PAIRS.length).toBeGreaterThanOrEqual(6);
	});

	/** Every field a row holds that two sessions should share, displayName included (a generated desired title is masked). */
	const stripWithName = (row: Record<string, unknown> | undefined, named: unknown[]) =>
		Object.fromEntries(
			Object.entries(strip(row, named)).concat(row ? [["displayName", row.displayName]] : []),
		);

	// Neither row exists yet. The oldest queued report creates the session, which the server reads
	// differently from an update (a title names the session, the agent type sticks), so it is sent as it
	// is and the outbox folds only the reports after it. X gets all three in order; Y gets what the
	// outbox makes of them once they have aged past a day.
	for (const [label, a, b] of PAIRS) {
		test(`${label} (the row doesn't exist yet)`, async () => {
			const w = await world();
			try {
				const x = uid("new-x");
				const y = uid("new-y");
				await w.own(x);
				await w.own(y);
				const creator = (sid: string) =>
					({
						sessionId: sid,
						agentType: "codex_cli",
						status: "active",
						managedState: "headless",
						cwd: "/tmp/creator",
						model: "m-creator",
						desiredThreadTitle: "creator title",
					}) as ManagedSessionStateInput;
				const first = (sid: string) => ({ ...stateOf(sid, a), sessionId: sid });
				const second = (sid: string) =>
					({ sessionId: sid, agentType: "codex_cli", ...b }) as ManagedSessionStateInput;
				const url = `/supervisors/${w.supervisor.id}/managed-session-state`;
				for (const body of [creator(x), first(x), second(x)]) await w.post(url, body);

				await w.outage();
				for (const body of [creator(y), first(y), second(y)]) {
					expect((await w.gate.reportState(body)).outcome).toBe("queued");
				}
				w.skew(25 * HOUR);
				await w.rebind();
				const mark = w.seen.length;
				await w.gate.flush();
				const posted = w.seen.slice(mark).filter((s) => s.path.endsWith("/managed-session-state"));
				expect(posted, "the creating report, then the other two folded into one").toHaveLength(2);
				expect(JSON.parse(posted[0]?.body as string)).toMatchObject({
					desiredThreadTitle: "creator title",
					agentType: "codex_cli",
				});

				const named = ["creator title", a.desiredThreadTitle, b.desiredThreadTitle];
				expect(stripWithName((await sessionRow(y)) as never, named)).toEqual(
					stripWithName((await sessionRow(x)) as never, named),
				);
				expect(stripWithName((await managedRow(y)) as never, named)).toEqual(
					stripWithName((await managedRow(x)) as never, named),
				);
			} finally {
				await w.cleanup();
			}
		}, 60_000);
	}
});

// ── scenario 7 ───────────────────────────────────────────────────────────────────────────────

describe("7. isolation", () => {
	test("a session whose queue head is a symlink is held; another session's reports are delivered", async () => {
		const w = await world();
		try {
			const p = uid("held");
			const q = uid("free");
			await w.own(p);
			await w.own(q);
			await w.gate.reportState(stateOf(p));
			await w.gate.reportState(stateOf(q));
			await w.outage();
			await w.gate.reportEvents(p, batch("p-1"));
			await w.gate.reportEvents(q, batch("q-1", wholeSecond(-60_000)));
			const head = join(
				w.home,
				".agentpulse",
				"supervisor-outbox",
				outboxDirName(p),
				"0000000000000001.json",
			);
			const decoy = join(w.home, "decoy.json");
			writeFileSync(decoy, "{}", { mode: 0o600 });
			rmSync(head);
			symlinkSync(decoy, head);
			await w.restart();
			await w.rebind();
			await w.gate.flush();
			expect((await rowsOf(q)).map((r) => r.content)).toEqual(["q-1"]);
			expect(await rowsOf(p)).toHaveLength(0);
			expect(w.outbox.hasPending(p)).toBe(true);
			expect(existsSync(decoy)).toBe(true);
		} finally {
			await w.cleanup();
		}
	}, 30_000);
});

// ── scenario 8 ───────────────────────────────────────────────────────────────────────────────

describe("8. exclusion at replay and mid-flush", () => {
	const writeRules = (w: World, lines: string[]) => {
		const file = join(w.home, ".agentpulse", "exclude");
		writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
		chmodSync(file, 0o600);
		const at = new Date(Date.now() + 5_000);
		utimesSync(file, at, at);
	};

	test("a rule added during the outage: none of the queued reports land, and the directory is gone", async () => {
		const w = await world();
		try {
			const id = uid("excluded");
			await w.own(id);
			w.gate.noteCwd(id, w.work);
			await w.outage();
			await w.gate.reportEvents(id, batch("secret-1"));
			await w.gate.reportEvents(id, batch("secret-2"));
			expect(outboxFiles(w.home)).toHaveLength(1);
			writeRules(w, [join(w.home, "work")]);
			await w.rebind();
			const mark = w.seen.length;
			await w.gate.flush();
			expect(w.seen.slice(mark).filter((s) => s.path.includes(id))).toEqual([]);
			expect(await rowsOf(id)).toHaveLength(0);
			expect(outboxFiles(w.home)).toEqual([]);
		} finally {
			await w.cleanup();
		}
	}, 30_000);

	test("a rule that appears while the flush is under way stops it at the next entry", async () => {
		const w = await world();
		try {
			const id = uid("mid-flush");
			await w.own(id);
			w.gate.noteCwd(id, w.work);
			await w.gate.reportState(stateOf(id, { cwd: w.work }));
			await w.outage();
			for (const c of ["m1", "m2", "m3"])
				await w.gate.reportEvents(id, batch(c, wholeSecond(-60_000)));
			await w.rebind();
			// the rule lands the moment the server has taken the first entry
			w.onServed((seen) => {
				if (seen.path.endsWith(`/${id}/events`)) writeRules(w, [join(w.home, "work")]);
			});
			await w.gate.flush();
			const rows = await rowsOf(id);
			expect(
				rows.map((r) => r.content),
				"the entry in flight landed, nothing after the rule did",
			).toEqual(["m1"]);
			expect((await sessionRow(id))?.status, "and the session got its one closing report").toBe(
				"completed",
			);
			expect(outboxFiles(w.home)).toEqual([]);
		} finally {
			await w.cleanup();
		}
	}, 30_000);
});
