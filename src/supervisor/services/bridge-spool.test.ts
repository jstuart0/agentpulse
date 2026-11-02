/**
 * The terminal-bridge spool drain: what it admits, what it validates, what it does with each answer from the
 * gate, and what it costs when nothing is happening. Real files in a temp home; the gate is a recorder except
 * where a test needs the real one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATE_ARRIVAL_MS } from "../../shared/late-arrival.js";
import type { ManagedSessionEventInput, ManagedSessionStateInput } from "../../shared/types.js";
import {
	MAX_ACTIVE_DIRS,
	MAX_FILES_PER_DIR,
	MAX_FILES_PER_TICK,
	SCAN_INTERVAL_MS,
	type SpoolStat,
	createBridgeSpoolDrain,
} from "./bridge-spool.js";
import { type PrivateFileRead, readPrivateFileNoFollow } from "./private-store.js";
import { createReportGate } from "./report-gate.js";
import {
	SupervisorNetworkError,
	SupervisorRequestError,
	createCredentialTripwire,
} from "./report-resilience.js";

const NONCE = "0123456789abcdef0123456789abcdef";
const T0 = Date.parse("2026-11-01T12:00:00Z");

let home: string;
let clock: number;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ap-bridge-spool-"));
	clock = T0;
	mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
	mkdirSync(root(), { mode: 0o700 });
	chmodSync(root(), 0o700);
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const root = () => join(home, ".agentpulse", "interactive");
const bridgeDir = (id: string) => join(root(), id);
const reportsDir = (id: string) => join(bridgeDir(id), "reports");
const seqFile = (id: string, seq: number) =>
	join(reportsDir(id), `${String(seq).padStart(16, "0")}.json`);

function makeBridge(id: string, nonce: string | null = NONCE) {
	mkdirSync(reportsDir(id), { recursive: true, mode: 0o700 });
	chmodSync(bridgeDir(id), 0o700);
	chmodSync(reportsDir(id), 0o700);
	const config = join(bridgeDir(id), "bridge.json");
	writeFileSync(
		config,
		JSON.stringify({ session_id: id, cwd: "/anywhere", ...(nonce ? { launchNonce: nonce } : {}) }),
		{ mode: 0o600 },
	);
	chmodSync(config, 0o600);
}

const stateBody = (id: string, over: Record<string, unknown> = {}) => ({
	sessionId: id,
	status: "active",
	managedState: "interactive_terminal",
	providerSessionId: id,
	correlationSource: "launch_correlation_id",
	metadata: {
		launchMode: "interactive_terminal",
		interactiveBridge: {
			socketPath: join(bridgeDir(id), "control.sock"),
			bridgePid: 4242,
			childPid: 4243,
		},
	},
	...over,
});
/** The metadata of a bridge that has ended. */
const endedMetadata = (id: string, exitCode = 0) => ({
	launchMode: "interactive_terminal",
	interactiveBridge: {
		socketPath: join(bridgeDir(id), "control.sock"),
		bridgePid: 4242,
		childPid: 4243,
	},
	exitCode,
});
const eventBody = (over: Record<string, unknown> = {}) => ({
	events: [
		{
			eventType: "InteractivePromptObserved",
			category: "prompt",
			content: "hello",
			rawPayload: { source: "host_terminal" },
			...over,
		},
	],
});
let counter = 0;
function envelope(kind: "state" | "events", body: unknown, over: Record<string, unknown> = {}) {
	return {
		v: 1,
		nonce: NONCE,
		kind,
		occurredAt: new Date(T0 - 5_000).toISOString(),
		...(kind === "events" ? { deliveryId: `delivery-${++counter}-abcdefgh` } : {}),
		body,
		...over,
	};
}
function put(id: string, seq: number, content: unknown) {
	const file = seqFile(id, seq);
	writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), {
		mode: 0o600,
	});
	chmodSync(file, 0o600);
}

type Call =
	| { kind: "state"; id: string; body: ManagedSessionStateInput; replay?: boolean }
	| {
			kind: "events";
			id: string;
			events: ManagedSessionEventInput[];
			opts?: { deliveryId?: string; replay?: boolean };
	  };

type Answer = "sent" | "queued" | "excluded" | "blocked" | Error;

function recorder(
	answer: (call: Call) => Answer = () => "sent",
	interactive: (id: string) => boolean = () => true,
) {
	const calls: Call[] = [];
	const gate = {
		isInteractiveLaunch: interactive,
		async reportState(body: ManagedSessionStateInput, opts?: { replay?: boolean }) {
			const call: Call = { kind: "state", id: body.sessionId, body, replay: opts?.replay };
			calls.push(call);
			const result = answer(call);
			if (result instanceof Error) throw result;
			return { session: { displayName: "" }, managedSession: {}, outcome: result } as never;
		},
		async reportEvents(
			id: string,
			events: ManagedSessionEventInput[],
			opts?: { deliveryId?: string; replay?: boolean },
		) {
			const call: Call = { kind: "events", id, events, opts };
			calls.push(call);
			const result = answer(call);
			if (result instanceof Error) throw result;
			return result;
		},
	};
	return { gate, calls };
}

function makeDrain(
	gate: ReturnType<typeof recorder>["gate"],
	over: {
		tripwire?: ReturnType<typeof createCredentialTripwire>;
		onCredentialRejected?: () => void | Promise<void>;
		logs?: string[];
	} = {},
) {
	const tripwire = over.tripwire ?? createCredentialTripwire({ now: () => clock });
	const drain = createBridgeSpoolDrain({
		gate: gate as never,
		home,
		now: () => clock,
		log: (line) => over.logs?.push(line),
		credentialTripwire: tripwire,
		onCredentialRejected: over.onCredentialRejected ?? (() => undefined),
	});
	return { drain, tripwire };
}

const remaining = (id: string) =>
	existsSync(reportsDir(id))
		? readdirSync(reportsDir(id)).filter((n) => /^\d{16}\.json$/.test(n))
		: [];

describe("order and the happy path", () => {
	test("reports go out in seq order, state and events alike, to the gate with the directory name as the session", async () => {
		makeBridge("sess-1");
		put("sess-1", 1, envelope("state", stateBody("sess-1")));
		put("sess-1", 2, envelope("events", eventBody({ content: "one" })));
		put("sess-1", 3, envelope("events", eventBody({ content: "two" })));
		put(
			"sess-1",
			4,
			envelope(
				"state",
				stateBody("sess-1", {
					status: "completed",
					managedState: "completed",
					metadata: endedMetadata("sess-1"),
				}),
			),
		);
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate);
		drain.admit("sess-1");
		await drain.drain();
		expect(calls.map((c) => c.kind)).toEqual(["state", "events", "events", "state"]);
		expect(calls.map((c) => c.id)).toEqual(["sess-1", "sess-1", "sess-1", "sess-1"]);
		const events = calls.filter((c) => c.kind === "events") as Extract<Call, { kind: "events" }>[];
		expect(events.map((c) => c.events[0]?.content)).toEqual(["one", "two"]);
		expect(events[0]?.opts?.deliveryId).toMatch(/^delivery-/);
		expect(events[0]?.events[0]?.occurredAt).toBe(new Date(T0 - 5_000).toISOString());
		expect(remaining("sess-1")).toEqual([]);
		expect(drain.stats().sent).toBe(4);
	});

	test("an events file has no sessionId of its own and is accepted against the directory it is in", async () => {
		makeBridge("dir-id");
		put("dir-id", 1, envelope("events", eventBody()));
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate);
		drain.admit("dir-id");
		await drain.drain();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.id).toBe("dir-id");
		expect(JSON.stringify(calls[0])).not.toContain("sessionId");
	});

	test("a temp file the bridge hasn't finished is ignored", async () => {
		makeBridge("s1");
		put("s1", 1, envelope("events", eventBody()));
		writeFileSync(join(reportsDir("s1"), ".tmp-0000000000000002"), "partial");
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate);
		drain.admit("s1");
		await drain.drain();
		expect(calls).toHaveLength(1);
		expect(existsSync(join(reportsDir("s1"), ".tmp-0000000000000002"))).toBe(true);
	});
});

describe("validation: anything outside the whitelist is deleted, counted lost and never sent", () => {
	const valid = (id: string) => envelope("events", eventBody());
	const CASES: Array<[string, (id: string) => unknown]> = [
		["not JSON", () => "{not json"],
		["a wrong version", (id) => ({ ...(valid(id) as object), v: 2 })],
		["another launch's nonce", (id) => ({ ...(valid(id) as object), nonce: "f".repeat(32) })],
		["an unknown kind", (id) => envelope("events", eventBody(), { kind: "other" })],
		[
			"an unparseable occurredAt",
			() => envelope("events", eventBody(), { occurredAt: "yesterday" }),
		],
		["an extra envelope key", () => envelope("events", eventBody(), { extra: 1 })],
		[
			"a state envelope with a delivery id",
			(id) => envelope("state", stateBody(id), { deliveryId: "delivery-x-abcdefgh" }),
		],
		[
			"an events envelope with no delivery id",
			() => {
				const e = envelope("events", eventBody()) as Record<string, unknown>;
				e.deliveryId = undefined;
				return e;
			},
		],
		["a bad delivery id", () => envelope("events", eventBody(), { deliveryId: "bad id!" })],
		["a state body with an extra key", (id) => envelope("state", stateBody(id, { cwd: "/etc" }))],
		[
			"a state body missing a key",
			(id) => {
				const b = stateBody(id) as Record<string, unknown>;
				b.metadata = undefined;
				return envelope("state", b);
			},
		],
		[
			"a state sessionId that isn't the directory",
			() => envelope("state", stateBody("someone-else")),
		],
		[
			"a providerSessionId that isn't the directory",
			(id) => envelope("state", stateBody(id, { providerSessionId: "x" })),
		],
		[
			"an unknown managedState",
			(id) => envelope("state", stateBody(id, { managedState: "headless" })),
		],
		["an unknown status", (id) => envelope("state", stateBody(id, { status: "archived" }))],
		[
			"another correlationSource",
			(id) => envelope("state", stateBody(id, { correlationSource: "session_id" })),
		],
		[
			"metadata with nine keys",
			(id) =>
				envelope(
					"state",
					stateBody(id, {
						metadata: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 1])),
					}),
				),
		],
		[
			"metadata over 4 KiB",
			(id) => envelope("state", stateBody(id, { metadata: { blob: "x".repeat(4_100) } })),
		],
		[
			"an events body with an extra key",
			() => envelope("events", { ...eventBody(), sessionId: "x" }),
		],
		[
			"two events in one body",
			() => envelope("events", { events: [...eventBody().events, ...eventBody().events] }),
		],
		[
			"an event type outside the two",
			() => envelope("events", eventBody({ eventType: "ManagedEventsLost" })),
		],
		[
			"an event that tries a watcher type",
			() => envelope("events", eventBody({ eventType: "AiReport" })),
		],
		["an unknown category", () => envelope("events", eventBody({ category: "ai_report" }))],
		["an extra event key", () => envelope("events", eventBody({ source: "managed_control" }))],
		["content that isn't a string", () => envelope("events", eventBody({ content: 7 }))],
		[
			"content over 64 KiB",
			() => envelope("events", eventBody({ content: "c".repeat(64 * 1024 + 1) })),
		],
		[
			"a rawPayload with five keys",
			() => envelope("events", eventBody({ rawPayload: { a: 1, b: 2, c: 3, d: 4, e: 5 } })),
		],
		[
			"a rawPayload over 1 KiB",
			() => envelope("events", eventBody({ rawPayload: { blob: "x".repeat(1_100) } })),
		],
		["a rawPayload that is a list", () => envelope("events", eventBody({ rawPayload: [1] }))],
	];
	for (const [label, build] of CASES) {
		test(label, async () => {
			makeBridge("v1");
			put("v1", 1, build("v1"));
			put("v1", 2, envelope("events", eventBody({ content: "good" })));
			const { gate, calls } = recorder();
			const { drain } = makeDrain(gate);
			drain.admit("v1");
			await drain.drain();
			expect(calls.map((c) => (c.kind === "events" ? c.events[0]?.content : "state"))).toEqual([
				"good",
			]);
			expect(remaining("v1")).toEqual([]);
			expect(drain.stats().lost).toBe(1);
		});
	}

	test("the positive control: a body at every limit is accepted", async () => {
		makeBridge("edge");
		put(
			"edge",
			1,
			envelope(
				"state",
				stateBody("edge", {
					status: "failed",
					managedState: "failed",
					metadata: endedMetadata("edge", 255),
				}),
			),
		);
		put(
			"edge",
			2,
			envelope(
				"events",
				eventBody({ content: "c".repeat(64 * 1024), rawPayload: { a: 1, b: 2, c: 3, d: 4 } }),
			),
		);
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate);
		drain.admit("edge");
		await drain.drain();
		expect(calls).toHaveLength(2);
		expect(drain.stats().lost).toBe(0);
	});

	test("a report that isn't a private plain file is left alone, never read through a link", async () => {
		makeBridge("v2");
		const secret = join(home, "secret.json");
		writeFileSync(
			secret,
			JSON.stringify(envelope("events", eventBody({ content: "from the secret" }))),
			{ mode: 0o600 },
		);
		symlinkSync(secret, seqFile("v2", 1));
		put("v2", 2, envelope("events", eventBody({ content: "plain" })));
		const logs: string[] = [];
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate, { logs });
		drain.admit("v2");
		await drain.drain();
		expect(
			calls.map((c) => (c as { events: ManagedSessionEventInput[] }).events[0]?.content),
		).toEqual(["plain"]);
		expect(existsSync(secret)).toBe(true);
		expect(readdirSync(reportsDir("v2"))).toContain("0000000000000001.json");
		await drain.drain();
		expect(logs.filter((l) => l.includes("left alone"))).toHaveLength(1);
	});
});

describe("what each answer from the gate does to the file", () => {
	const one = (id: string) => {
		makeBridge(id);
		put(id, 1, envelope("events", eventBody({ content: `${id}-a` })));
		put(id, 2, envelope("events", eventBody({ content: `${id}-b` })));
	};

	for (const outcome of ["sent", "queued", "excluded"] as const) {
		test(`${outcome}: the file is removed`, async () => {
			one("o1");
			const { gate } = recorder(() => outcome);
			const { drain } = makeDrain(gate);
			drain.admit("o1");
			await drain.drain();
			expect(remaining("o1")).toEqual([]);
		});
	}

	test("blocked: the file stays and the whole tick stops, other directories included", async () => {
		one("b1");
		one("b2");
		const { gate, calls } = recorder(() => "blocked");
		const { drain } = makeDrain(gate);
		drain.admit("b1");
		drain.admit("b2");
		await drain.drain();
		expect(calls).toHaveLength(1);
		expect(remaining("b1")).toHaveLength(2);
		expect(remaining("b2")).toHaveLength(2);
	});

	for (const [label, error] of [
		["entry (400 invalid_body)", new SupervisorRequestError(400, "Bad Request", "invalid_body")],
		[
			"session (403 session_not_owned)",
			new SupervisorRequestError(403, "Forbidden", "session_not_owned"),
		],
	] as const) {
		test(`thrown ${label}: the file is removed and counted lost, and the next one is tried`, async () => {
			one("t1");
			let first = true;
			const { gate, calls } = recorder(() => {
				if (first) {
					first = false;
					return error;
				}
				return "sent";
			});
			const { drain } = makeDrain(gate);
			drain.admit("t1");
			await drain.drain();
			expect(calls).toHaveLength(2);
			expect(remaining("t1")).toEqual([]);
			expect(drain.stats().lost).toBe(1);
		});
	}

	for (const [label, error] of [
		["network", new SupervisorNetworkError()],
		["server (500)", new SupervisorRequestError(500, "Internal")],
		[
			"backoff (503 busy + Retry-After)",
			new SupervisorRequestError(503, "Unavailable", "busy", 2_000),
		],
		["stop (404)", new SupervisorRequestError(404, "Not Found")],
		["other (a TypeError)", new TypeError("boom")],
	] as const) {
		test(`thrown ${label}: the file stays, this directory stops for the tick, another directory still goes`, async () => {
			one("k1");
			one("k2");
			const { gate, calls } = recorder((call) => (call.id === "k1" ? error : "sent"));
			const { drain } = makeDrain(gate);
			drain.admit("k1");
			drain.admit("k2");
			await drain.drain();
			expect(remaining("k1")).toHaveLength(2);
			expect(remaining("k2")).toEqual([]);
			expect(calls.filter((c) => c.id === "k1")).toHaveLength(1);
			expect(drain.stats().lost).toBe(0);
		});
	}

	test("a stopped directory is tried again on the next tick and then delivers", async () => {
		one("again");
		let failing = true;
		const { gate, calls } = recorder(() => (failing ? new SupervisorNetworkError() : "sent"));
		const { drain } = makeDrain(gate);
		drain.admit("again");
		await drain.drain();
		expect(remaining("again")).toHaveLength(2);
		failing = false;
		await drain.drain();
		expect(remaining("again")).toEqual([]);
		expect(
			calls.map((c) => (c as { opts?: { deliveryId?: string } }).opts?.deliveryId).filter(Boolean),
		).toHaveLength(3);
	});

	test("a crash before the unlink re-drains the same delivery id", async () => {
		makeBridge("crash");
		put("crash", 1, envelope("events", eventBody(), { deliveryId: "stable-id-12345678" }));
		const first = recorder(() => new SupervisorNetworkError());
		const a = makeDrain(first.gate);
		a.drain.admit("crash");
		await a.drain.drain();
		expect(remaining("crash")).toHaveLength(1);
		const second = recorder();
		const b = makeDrain(second.gate);
		b.drain.admit("crash");
		await b.drain.drain();
		const ids = [...first.calls, ...second.calls].map(
			(c) => (c as { opts?: { deliveryId?: string } }).opts?.deliveryId,
		);
		expect(ids).toEqual(["stable-id-12345678", "stable-id-12345678"]);
	});

	describe("a credential rejection", () => {
		const rejection = new SupervisorRequestError(
			401,
			"Unauthorized",
			"Invalid supervisor credential",
		);

		test("is kept; the first only records, the second at least 10 s later calls onCredentialRejected", async () => {
			one("c1");
			let rejected = 0;
			const { gate } = recorder(() => rejection);
			const { drain } = makeDrain(gate, { onCredentialRejected: () => void rejected++ });
			drain.admit("c1");
			await drain.drain();
			expect(rejected).toBe(0);
			clock += 9_000;
			await drain.drain();
			expect(rejected).toBe(0);
			clock += 2_000;
			await drain.drain();
			expect(rejected).toBe(1);
			expect(remaining("c1")).toHaveLength(2);
		});

		test("the one shared tripwire counts it together with a rejection seen elsewhere", async () => {
			one("c2");
			const tripwire = createCredentialTripwire({ now: () => clock });
			let rejected = 0;
			const { gate } = recorder(() => rejection);
			const { drain } = makeDrain(gate, { tripwire, onCredentialRejected: () => void rejected++ });
			drain.admit("c2");
			tripwire.record(); // the heartbeat saw one
			clock += 10_000;
			await drain.drain();
			expect(rejected).toBe(1);
		});

		test("only a report the server took clears the tripwire: queued and excluded outcomes never contacted it", async () => {
			for (const outcome of ["queued", "excluded"] as const) {
				one(`reset-${outcome}`);
				const tripwire = createCredentialTripwire({ now: () => clock });
				const { gate } = recorder(() => outcome);
				const { drain } = makeDrain(gate, { tripwire });
				drain.admit(`reset-${outcome}`);
				tripwire.record();
				clock += 11_000;
				await drain.drain();
				expect(tripwire.record(), `${outcome} leaves the earlier rejection standing`).toBe(
					"confirmed",
				);
			}
			one("reset-sent");
			const tripwire = createCredentialTripwire({ now: () => clock });
			const { gate } = recorder(() => "sent");
			const { drain } = makeDrain(gate, { tripwire });
			drain.admit("reset-sent");
			tripwire.record();
			clock += 11_000;
			await drain.drain();
			expect(tripwire.record(), "sent clears it").toBe("first");
		});

		test("a success in between resets the tripwire", async () => {
			one("c3");
			let answer: Answer = rejection;
			let rejected = 0;
			const { gate } = recorder(() => answer);
			const { drain } = makeDrain(gate, { onCredentialRejected: () => void rejected++ });
			drain.admit("c3");
			await drain.drain();
			clock += 4_000;
			answer = "sent";
			await drain.drain();
			expect(remaining("c3")).toEqual([]);
			makeBridge("c3b");
			put("c3b", 1, envelope("events", eventBody()));
			drain.admit("c3b");
			answer = rejection;
			clock += 20_000;
			await drain.drain();
			expect(rejected, "the earlier rejection was forgotten by the success").toBe(0);
		});
	});
});

describe("the real gate and the real drain (B1)", () => {
	function realGate(opts: { rules?: string[] } = {}) {
		const sent: Array<{ path: string; body: unknown; headers?: Record<string, string> }> = [];
		const logs: string[] = [];
		const gate = createReportGate({
			request: async (path, options) => {
				sent.push({
					path,
					body: options?.body ? JSON.parse(String(options.body)) : undefined,
					headers: options?.headers as Record<string, string> | undefined,
				});
				return { session: { displayName: "x" }, managedSession: {}, events: [] };
			},
			supervisorId: "sup-1",
			home,
			now: () => clock,
			log: (line) => logs.push(line),
		});
		if (opts.rules) writeRules(opts.rules);
		return { gate, sent, logs };
	}
	let rulesVersion = 0;
	function writeRules(lines: string[]) {
		const file = join(home, ".agentpulse", "exclude");
		writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
		chmodSync(file, 0o600);
		const at = new Date(T0 + ++rulesVersion * 1000);
		utimesSync(file, at, at);
	}
	const removeRules = () => rmSync(join(home, ".agentpulse", "exclude"), { force: true });

	test("an invalid rules file keeps the spool file through three ticks; once it is fixed the next tick delivers it and removes it", async () => {
		makeBridge("real-1");
		put("real-1", 1, envelope("events", eventBody({ content: "must not be lost" })));
		const { gate, sent } = realGate({ rules: ["not/an/absolute/path"] });
		gate.noteLaunch("launch-1", "real-1", "/some/work");
		const { drain } = makeDrain(gate as never);
		drain.admit("real-1");
		for (let i = 0; i < 3; i++) {
			clock += 1_000;
			await drain.drain();
			expect(remaining("real-1"), `tick ${i + 1}`).toHaveLength(1);
		}
		expect(sent).toEqual([]);
		removeRules();
		clock += 1_000;
		await drain.drain();
		expect(remaining("real-1")).toEqual([]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.path).toBe("/supervisors/sup-1/managed-sessions/real-1/events");
		expect(JSON.stringify(sent[0]?.body)).toContain("must not be lost");
		expect(sent[0]?.headers?.["X-AgentPulse-Delivery-Id"]).toMatch(/^delivery-/);
	});

	test("a directory the gate has no record of is judged excluded while rules exist, even when bridge.json names an uncovered cwd (X1)", async () => {
		makeBridge("real-2");
		writeFileSync(
			join(bridgeDir("real-2"), "bridge.json"),
			JSON.stringify({ launchNonce: NONCE, cwd: join(home, "open") }),
			{ mode: 0o600 },
		);
		put("real-2", 1, envelope("events", eventBody({ content: "secret" })));
		const { gate, sent } = realGate({ rules: [join(home, "work")] });
		const { drain } = makeDrain(gate as never);
		drain.admit("real-2");
		await drain.drain();
		expect(sent).toEqual([]);
		expect(remaining("real-2"), "excluded: the file goes unsent").toEqual([]);
	});

	test("with no rules the same unknown directory is sent", async () => {
		makeBridge("real-3");
		put("real-3", 1, envelope("events", eventBody()));
		const { gate, sent } = realGate();
		const { drain } = makeDrain(gate as never);
		drain.admit("real-3");
		await drain.drain();
		expect(sent).toHaveLength(1);
		expect(remaining("real-3")).toEqual([]);
	});

	test("a launch the gate knows, in a covered directory, is excluded; in an uncovered one it is sent", async () => {
		makeBridge("real-4");
		makeBridge("real-5");
		put("real-4", 1, envelope("events", eventBody()));
		put("real-5", 1, envelope("events", eventBody()));
		const { gate, sent } = realGate({ rules: [join(home, "work")] });
		gate.noteLaunch("l4", "real-4", join(home, "work", "secret"));
		gate.noteLaunch("l5", "real-5", join(home, "open"));
		const { drain } = makeDrain(gate as never);
		drain.admit("real-4");
		drain.admit("real-5");
		await drain.drain();
		expect(sent.map((s) => s.path)).toEqual(["/supervisors/sup-1/managed-sessions/real-5/events"]);
		expect(remaining("real-4")).toEqual([]);
		expect(remaining("real-5")).toEqual([]);
	});
});

describe("replay age comes from when the drain first saw a file, never from the file", () => {
	test("a file with an old mtime and an old occurredAt is not a replay on first sight, and is after 61 s", async () => {
		makeBridge("r1");
		put(
			"r1",
			1,
			envelope("events", eventBody(), { occurredAt: new Date(T0 - 5 * 3_600_000).toISOString() }),
		);
		const old = new Date(T0 - 5 * 3_600_000);
		utimesSync(seqFile("r1", 1), old, old);
		let failing = true;
		const { gate, calls } = recorder(
			() => (failing ? new SupervisorNetworkError() : "sent"),
			() => false,
		);
		const { drain } = makeDrain(gate);
		await drain.drain(); // the first pass after start, with nothing followed yet
		drain.admit("r1");
		await drain.drain();
		failing = false;
		clock += LATE_ARRIVAL_MS - 1_000;
		await drain.drain();
		clock += 2_000;
		await drain.drain();
		const replays = calls.map((c) => (c.kind === "events" ? c.opts?.replay : c.replay));
		expect(replays).toEqual([false, false]);
	});

	test("every file already there at the first pass after the drain starts goes out as a replay, but not one written after", async () => {
		makeBridge("early");
		put("early", 1, envelope("events", eventBody({ content: "before the supervisor started" })));
		const { gate, calls } = recorder(
			() => "sent",
			() => false,
		);
		const { drain } = makeDrain(gate);
		drain.admit("early");
		await drain.drain();
		makeBridge("later");
		put("later", 1, envelope("events", eventBody({ content: "after" })));
		drain.admit("later");
		await drain.drain();
		const byContent = new Map(
			calls.map((c) => [
				(c as { events: ManagedSessionEventInput[] }).events[0]?.content,
				(c as { opts?: { replay?: boolean } }).opts?.replay,
			]),
		);
		expect(byContent.get("before the supervisor started")).toBe(true);
		expect(byContent.get("after")).toBe(false);
	});

	test("a file still there after more than a minute goes out as a replay", async () => {
		makeBridge("r2");
		put("r2", 1, envelope("events", eventBody()));
		let failing = true;
		const { gate, calls } = recorder(
			() => (failing ? new SupervisorNetworkError() : "sent"),
			() => false,
		);
		const { drain } = makeDrain(gate);
		await drain.drain(); // the first pass after start, with nothing followed yet
		drain.admit("r2");
		await drain.drain();
		failing = false;
		clock += LATE_ARRIVAL_MS + 1_000;
		await drain.drain();
		expect(calls.map((c) => (c.kind === "events" ? c.opts?.replay : c.replay))).toEqual([
			false,
			true,
		]);
	});

	test("a state file is marked a replay by the same rule", async () => {
		makeBridge("r3");
		put("r3", 1, envelope("state", stateBody("r3")));
		let failing = true;
		const { gate, calls } = recorder(
			() => (failing ? new SupervisorNetworkError() : "sent"),
			() => false,
		);
		const { drain } = makeDrain(gate);
		await drain.drain(); // the first pass after start, with nothing followed yet
		drain.admit("r3");
		await drain.drain();
		failing = false;
		clock += LATE_ARRIVAL_MS + 1_000;
		await drain.drain();
		expect(calls.map((c) => (c.kind === "state" ? c.replay : undefined))).toEqual([false, true]);
	});
});

describe("reports the bridge couldn't write", () => {
	const lostFile = (id: string, total: unknown) =>
		writeFileSync(join(reportsDir(id), "lost"), JSON.stringify({ v: 1, lostTotal: total }), {
			mode: 0o600,
		});

	test("the delta goes out once as a ManagedEventsLost event with the derived delivery id, then is acknowledged", async () => {
		makeBridge("l1");
		// a live bridge, so the directory stays followed between ticks
		const pidFile = join(bridgeDir("l1"), "bridge.pid");
		writeFileSync(pidFile, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
		const touch = () => utimesSync(pidFile, new Date(clock), new Date(clock));
		touch();
		lostFile("l1", 3);
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate);
		drain.admit("l1");
		await drain.drain();
		const call = calls[0] as Extract<Call, { kind: "events" }>;
		expect(call.events[0]).toMatchObject({
			eventType: "ManagedEventsLost",
			rawPayload: { lost: 3 },
		});
		expect(call.opts?.deliveryId).toBe(
			createHash("sha256").update("l1:lost:3").digest("hex").slice(0, 32),
		);
		expect(call.opts?.deliveryId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
		expect(readFileSync(join(reportsDir("l1"), ".lost-acked"), "utf-8")).toBe("3");
		clock += 2_000;
		touch();
		utimesSync(reportsDir("l1"), new Date(clock), new Date(clock));
		await drain.drain();
		expect(calls).toHaveLength(1);
		// a later, larger total sends only the difference
		lostFile("l1", 5);
		utimesSync(reportsDir("l1"), new Date(clock + 5_000), new Date(clock + 5_000));
		clock += 5_000;
		touch();
		await drain.drain();
		expect((calls[1] as Extract<Call, { kind: "events" }>).events[0]?.rawPayload).toEqual({
			lost: 2,
		});
	});

	test("a huge or negative or non-numeric total is clamped, never trusted", async () => {
		for (const [id, total, expected] of [
			["l2", 1e12, 10_000_000],
			["l3", -5, null],
			["l4", "lots", null],
			["l5", Number.NaN, null],
		] as const) {
			makeBridge(id);
			lostFile(id, total);
			const { gate, calls } = recorder();
			const { drain } = makeDrain(gate);
			drain.admit(id);
			await drain.drain();
			if (expected === null) expect(calls, id).toHaveLength(0);
			else
				expect((calls[0] as Extract<Call, { kind: "events" }>).events[0]?.rawPayload, id).toEqual({
					lost: expected,
				});
		}
	});

	test("a blocked gate leaves the total unacknowledged so it is sent when the rules are fixed", async () => {
		makeBridge("l6");
		lostFile("l6", 2);
		let blocked = true;
		const { gate, calls } = recorder(() => (blocked ? "blocked" : "sent"));
		const { drain } = makeDrain(gate);
		drain.admit("l6");
		await drain.drain();
		expect(existsSync(join(reportsDir("l6"), ".lost-acked"))).toBe(false);
		blocked = false;
		clock += 1_000;
		utimesSync(reportsDir("l6"), new Date(clock), new Date(clock));
		await drain.drain();
		expect(calls).toHaveLength(2);
		expect(readFileSync(join(reportsDir("l6"), ".lost-acked"), "utf-8")).toBe("2");
	});
});

describe("bounds and single flight", () => {
	test("overlapping ticks share one pass: the gate sees each file once", async () => {
		makeBridge("sf");
		for (let i = 1; i <= 3; i++) put("sf", i, envelope("events", eventBody({ content: `m${i}` })));
		let release!: () => void;
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const calls: string[] = [];
		const gate = {
			isInteractiveLaunch: () => true,
			async reportState() {
				return { outcome: "sent" } as never;
			},
			async reportEvents(_id: string, events: ManagedSessionEventInput[]) {
				calls.push(String(events[0]?.content));
				await hold;
				return "sent" as const;
			},
		};
		const { drain } = makeDrain(gate as never);
		drain.admit("sf");
		const a = drain.drain();
		const b = drain.drain();
		const c = drain.drain();
		expect(b).toBe(a);
		expect(c).toBe(a);
		await new Promise((r) => setTimeout(r, 20));
		release();
		await a;
		expect(calls).toEqual(["m1", "m2", "m3"]);
	});

	test(`one directory sends at most ${MAX_FILES_PER_DIR} files a tick, in order, and the rest on the next`, async () => {
		makeBridge("cap1");
		for (let i = 1; i <= 120; i++)
			put("cap1", i, envelope("events", eventBody({ content: `n${i}` })));
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate);
		drain.admit("cap1");
		await drain.drain();
		expect(calls).toHaveLength(MAX_FILES_PER_DIR);
		expect(remaining("cap1")).toHaveLength(70);
		await drain.drain();
		expect(calls).toHaveLength(100);
		await drain.drain();
		expect(calls).toHaveLength(120);
		const order = calls.map((c) =>
			Number(String((c as { events: ManagedSessionEventInput[] }).events[0]?.content).slice(1)),
		);
		expect(order).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
	});

	test(`a tick sends at most ${MAX_FILES_PER_TICK} files across directories`, async () => {
		const ids = Array.from({ length: 6 }, (_, i) => `many-${i}`);
		for (const id of ids) {
			makeBridge(id);
			for (let i = 1; i <= MAX_FILES_PER_DIR; i++) put(id, i, envelope("events", eventBody()));
		}
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate);
		for (const id of ids) drain.admit(id);
		await drain.drain();
		expect(calls).toHaveLength(MAX_FILES_PER_TICK);
		await drain.drain();
		expect(calls).toHaveLength(300);
	});

	test(`at most ${MAX_ACTIVE_DIRS} directories are followed`, () => {
		const { gate } = recorder();
		const { drain } = makeDrain(gate);
		for (let i = 0; i < MAX_ACTIVE_DIRS + 40; i++) drain.admit(`flood-${i}`);
		expect(drain.stats().followed).toBe(MAX_ACTIVE_DIRS);
	});

	test("an id that isn't a bridge directory name is never followed", () => {
		const { gate } = recorder();
		const { drain } = makeDrain(gate);
		for (const bad of ["", "../escape", "a/b", "x".repeat(129), "has space"]) drain.admit(bad);
		expect(drain.stats().followed).toBe(0);
	});
});

describe("which directories are followed (the parent scan)", () => {
	test("a bridge directory with a private bridge.json holding a nonce is found; the others are not", async () => {
		makeBridge("good");
		put("good", 1, envelope("events", eventBody({ content: "found" })));
		makeBridge("no-nonce", null);
		put("no-nonce", 1, envelope("events", eventBody()));
		mkdirSync(join(root(), "no-config"), { mode: 0o700 });
		mkdirSync(join(root(), "no-config", "reports"), { mode: 0o700 });
		// group-readable, though nobody else can write into it: not private, so not followed
		mkdirSync(join(root(), "open-dir"), { mode: 0o750 });
		chmodSync(join(root(), "open-dir"), 0o750);
		writeFileSync(join(root(), "open-dir", "bridge.json"), JSON.stringify({ launchNonce: NONCE }), {
			mode: 0o600,
		});
		chmodSync(join(root(), "open-dir", "bridge.json"), 0o600);
		mkdirSync(join(root(), "open-dir", "reports"), { mode: 0o700 });
		put("open-dir", 1, envelope("events", eventBody({ content: "must not be sent" })));
		mkdirSync(join(root(), "bad name"), { mode: 0o700 });
		const real = join(home, "real-target");
		mkdirSync(real, { mode: 0o700 });
		symlinkSync(real, join(root(), "linked"));
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate);
		await drain.drain();
		expect(calls.map((c) => c.id)).toEqual(["good"]);
	});

	test("a directory the scan once rejected is not read again until its mtime changes", async () => {
		makeBridge("late-config", null);
		// a report left behind makes the directory worth reading
		put("late-config", 1, envelope("events", eventBody()));
		const { gate } = recorder();
		const reads: string[] = [];
		const drain = createBridgeSpoolDrain({
			gate: gate as never,
			home,
			now: () => clock,
			log: () => undefined,
			credentialTripwire: createCredentialTripwire({ now: () => clock }),
			onCredentialRejected: () => undefined,
			readFile: (path, max): PrivateFileRead => {
				reads.push(path);
				return readPrivateFileNoFollow(path, max);
			},
		});
		await drain.drain();
		const first = reads.length;
		expect(first).toBeGreaterThan(0);
		clock += SCAN_INTERVAL_MS + 1_000;
		await drain.drain();
		expect(reads.length, "no re-read while the mtime is unchanged").toBe(first);
		writeFileSync(
			join(bridgeDir("late-config"), "bridge.json"),
			JSON.stringify({ launchNonce: NONCE }),
			{ mode: 0o600 },
		);
		const later = new Date(clock + 5_000);
		utimesSync(bridgeDir("late-config"), later, later);
		clock += SCAN_INTERVAL_MS + 1_000;
		await drain.drain();
		expect(reads.length).toBeGreaterThan(first);
	});

	test("a bridge whose reports directory isn't there yet is followed through a grace period, then forgotten", async () => {
		mkdirSync(bridgeDir("slow"), { mode: 0o700 });
		writeFileSync(join(bridgeDir("slow"), "bridge.json"), JSON.stringify({ launchNonce: NONCE }), {
			mode: 0o600,
		});
		chmodSync(join(bridgeDir("slow"), "bridge.json"), 0o600);
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate);
		drain.admit("slow");
		await drain.drain();
		expect(drain.stats().followed).toBe(1);
		mkdirSync(reportsDir("slow"), { mode: 0o700 });
		chmodSync(reportsDir("slow"), 0o700);
		put("slow", 1, envelope("events", eventBody()));
		clock += 1_000;
		await drain.drain();
		expect(calls).toHaveLength(1);
		const { drain: other } = makeDrain(gate);
		mkdirSync(bridgeDir("never"), { mode: 0o700 });
		writeFileSync(join(bridgeDir("never"), "bridge.json"), JSON.stringify({ launchNonce: NONCE }), {
			mode: 0o600,
		});
		other.admit("never");
		await other.drain();
		clock += 11 * 60_000;
		await other.drain();
		expect(other.stats().followed).toBe(0);
	});

	test("a drained directory whose bridge is gone is let go; one whose bridge is alive is kept", async () => {
		makeBridge("dead");
		makeBridge("alive");
		const pidFile = join(bridgeDir("alive"), "bridge.pid");
		writeFileSync(pidFile, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
		utimesSync(pidFile, new Date(clock), new Date(clock));
		put("dead", 1, envelope("events", eventBody()));
		put("alive", 1, envelope("events", eventBody()));
		const { gate } = recorder();
		const { drain } = makeDrain(gate);
		drain.admit("dead");
		drain.admit("alive");
		await drain.drain();
		expect(drain.stats().followed).toBe(1);
		expect(await drain.liveBridgeCount()).toBe(1);
	});
});

describe("liveBridgeCount", () => {
	test("counts a pid file naming a live process touched within 90 s, not a stale one, a dead pid or a malformed file", async () => {
		const pid = (id: string, content: string, ageMs: number) => {
			makeBridge(id);
			const file = join(bridgeDir(id), "bridge.pid");
			writeFileSync(file, content, { mode: 0o600 });
			utimesSync(file, new Date(clock - ageMs), new Date(clock - ageMs));
		};
		pid("live", JSON.stringify({ pid: process.pid }), 30_000);
		pid("stale", JSON.stringify({ pid: process.pid }), 91_000);
		pid("edge", JSON.stringify({ pid: process.pid }), 89_000);
		pid("dead", JSON.stringify({ pid: 2_147_483_000 }), 1_000);
		pid("junk", "not json", 1_000);
		pid("zero", JSON.stringify({ pid: 0 }), 1_000);
		makeBridge("nopid");
		const { gate } = recorder();
		const { drain } = makeDrain(gate);
		for (const id of ["live", "stale", "edge", "dead", "junk", "zero", "nopid"]) drain.admit(id);
		expect(await drain.liveBridgeCount()).toBe(2);
	});
});

describe("idle ceilings", () => {
	function fakes() {
		const counts = { stat: 0, readdir: 0, readFile: 0 };
		const priv: SpoolStat = {
			mtimeMs: T0,
			uid: process.getuid?.() ?? 0,
			mode: 0o40700,
			isSymbolicLink: () => false,
			isDirectory: () => true,
			isSocket: () => false,
		};
		return { counts, priv };
	}

	test("256 idle followed directories cost at most 256 stats and no listing a tick", async () => {
		const { counts, priv } = fakes();
		const { gate } = recorder();
		const drain = createBridgeSpoolDrain({
			gate: gate as never,
			home,
			now: () => clock,
			log: () => undefined,
			credentialTripwire: createCredentialTripwire({ now: () => clock }),
			onCredentialRejected: () => undefined,
			stat: async (path) => {
				counts.stat++;
				return path.endsWith("bridge.pid") ? { ...priv, mtimeMs: clock } : priv;
			},
			readdir: async (path) => {
				counts.readdir++;
				if (path === root()) return [];
				return [];
			},
			readFile: (path): PrivateFileRead => {
				counts.readFile++;
				if (path.endsWith("bridge.pid")) return { kind: "ok", text: JSON.stringify({ pid: 1 }) };
				return { kind: "ok", text: JSON.stringify({ launchNonce: NONCE }) };
			},
			isPidAlive: () => true,
		});
		for (let i = 0; i < 256; i++) drain.admit(`idle-${i}`);
		clock += SCAN_INTERVAL_MS + 1;
		await drain.drain(); // settles each directory once
		expect(drain.stats().followed).toBe(256);
		counts.stat = 0;
		counts.readdir = 0;
		counts.readFile = 0;
		clock += 1_000;
		await drain.drain();
		expect(counts.stat).toBeLessThanOrEqual(256);
		expect(counts.readdir).toBe(0);
		expect(counts.readFile).toBe(0);
	});

	test("10,000 finished bridges: after the first scan a rescan reads no bridge.json and costs at most one lstat each", async () => {
		const { counts, priv } = fakes();
		const names = Array.from({ length: 10_000 }, (_, i) => `old-${i}`);
		const { gate } = recorder();
		const drain = createBridgeSpoolDrain({
			gate: gate as never,
			home,
			now: () => clock,
			log: () => undefined,
			credentialTripwire: createCredentialTripwire({ now: () => clock }),
			onCredentialRejected: () => undefined,
			stat: async () => {
				counts.stat++;
				return priv;
			},
			readdir: async (path) => {
				counts.readdir++;
				return path === root() ? names : [];
			},
			readFile: (): PrivateFileRead => {
				counts.readFile++;
				return { kind: "ok", text: JSON.stringify({ cwd: "/x" }) }; // no nonce: rejected
			},
		});
		const realSetImmediate = globalThis.setImmediate;
		let yields = 0;
		globalThis.setImmediate = ((fn: () => void, ...rest: unknown[]) => {
			yields++;
			return (realSetImmediate as (...a: unknown[]) => unknown)(fn, ...rest);
		}) as unknown as typeof setImmediate;
		try {
			await drain.drain();
		} finally {
			globalThis.setImmediate = realSetImmediate;
		}
		expect(counts.readFile).toBe(10_000);
		// the fakes cost nothing, so only the scan's own yield lets the event loop turn: 10,000 / 200
		expect(yields, "the first scan yields to the event loop as it goes").toBeGreaterThanOrEqual(45);
		counts.stat = 0;
		counts.readdir = 0;
		counts.readFile = 0;
		clock += SCAN_INTERVAL_MS + 1_000;
		await drain.drain();
		expect(counts.readFile, "no bridge.json is read again").toBe(0);
		expect(counts.stat).toBeLessThanOrEqual(10_000);
		expect(counts.readdir).toBe(1);
		expect(drain.stats().followed).toBe(0);
	}, 60_000);
});

describe("isBridgeActive: whether the gate may forget an interactive launch", () => {
	test("true while bridge.pid is fresh, false for a stale pid file, no file, or an unknown id", () => {
		const { gate } = recorder();
		const { drain } = makeDrain(gate);
		makeBridge("fresh");
		makeBridge("stale");
		makeBridge("nopid");
		const pid = (id: string, at: number) => {
			const file = join(bridgeDir(id), "bridge.pid");
			writeFileSync(file, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
			utimesSync(file, new Date(at), new Date(at));
		};
		pid("fresh", clock - 10_000);
		pid("stale", clock - 10 * 60_000);
		expect(drain.isBridgeActive("fresh")).toBe(true);
		expect(drain.isBridgeActive("stale")).toBe(false);
		expect(drain.isBridgeActive("nopid")).toBe(false);
		expect(drain.isBridgeActive("never-heard-of")).toBe(false);
	});
});

describe("scrubbing the credentials an older supervisor left in bridge.json", () => {
	test("the four keys are removed and the rest kept; a config without them is untouched; a second run does nothing", async () => {
		makeBridge("old-1", null);
		writeFileSync(
			join(bridgeDir("old-1"), "bridge.json"),
			JSON.stringify({
				session_id: "old-1",
				cwd: "/work",
				launchNonce: NONCE,
				command: ["claude"],
				server_url: "https://example.invalid",
				supervisor_id: "sup",
				supervisor_token: "aps_secret",
				api_key: "ap_secret",
				socket_path: "/x/control.sock",
			}),
			{ mode: 0o600 },
		);
		makeBridge("new-1");
		const before = readFileSync(join(bridgeDir("new-1"), "bridge.json"), "utf-8");
		const { gate } = recorder();
		const { drain } = makeDrain(gate);
		expect(await drain.scrubLegacyBridgeConfigs()).toBe(1);
		const after = JSON.parse(readFileSync(join(bridgeDir("old-1"), "bridge.json"), "utf-8"));
		expect(after).toEqual({
			session_id: "old-1",
			cwd: "/work",
			launchNonce: NONCE,
			command: ["claude"],
			socket_path: "/x/control.sock",
		});
		expect(readFileSync(join(bridgeDir("new-1"), "bridge.json"), "utf-8")).toBe(before);
		expect(readFileSync(join(bridgeDir("old-1"), "bridge.json"), "utf-8")).not.toContain("secret");
		expect(await drain.scrubLegacyBridgeConfigs()).toBe(0);
	});

	test("a config in a directory others can write to, or a file others can read, is left alone", async () => {
		mkdirSync(bridgeDir("loose"), { mode: 0o777 });
		chmodSync(bridgeDir("loose"), 0o777);
		writeFileSync(join(bridgeDir("loose"), "bridge.json"), JSON.stringify({ api_key: "x" }), {
			mode: 0o600,
		});
		makeBridge("readable", null);
		writeFileSync(join(bridgeDir("readable"), "bridge.json"), JSON.stringify({ api_key: "x" }), {
			mode: 0o644,
		});
		chmodSync(join(bridgeDir("readable"), "bridge.json"), 0o644);
		const { gate } = recorder();
		const { drain } = makeDrain(gate);
		expect(await drain.scrubLegacyBridgeConfigs()).toBe(0);
		expect(readFileSync(join(bridgeDir("loose"), "bridge.json"), "utf-8")).toContain("api_key");
	});
});

describe("only a launch this supervisor started as interactive is found by the scan (an agent can plant a directory)", () => {
	test("a planted directory with a copied nonce and reports is never followed or sent; the real one is", async () => {
		makeBridge("real-launch");
		put("real-launch", 1, envelope("events", eventBody({ content: "real" })));
		makeBridge("planted-by-an-agent");
		put("planted-by-an-agent", 1, envelope("events", eventBody({ content: "forged" })));
		const { gate, calls } = recorder(
			() => "sent",
			(id) => id === "real-launch",
		);
		const { drain } = makeDrain(gate);
		await drain.drain();
		await drain.drain();
		expect(
			calls.map((c) => (c as { events: ManagedSessionEventInput[] }).events[0]?.content),
		).toEqual(["real"]);
		expect(remaining("planted-by-an-agent"), "left alone, not even removed").toHaveLength(1);
	});

	test("with the real gate: noteLaunch(interactive) is what makes the scan find a surviving bridge, across a restart, even with no rules", async () => {
		makeBridge("survivor");
		put("survivor", 1, envelope("events", eventBody({ content: "after the restart" })));
		makeBridge("never-launched");
		put("never-launched", 1, envelope("events", eventBody({ content: "forged" })));
		const sentPaths: string[] = [];
		const make = () =>
			createReportGate({
				request: async (path) => {
					sentPaths.push(path);
					return { session: { displayName: "x" }, managedSession: {}, events: [] };
				},
				supervisorId: "sup-1",
				home,
				now: () => clock,
				log: () => undefined,
			});
		const before = make();
		expect(before.noteLaunch("launch-1", "survivor", home, { interactive: true })).toBe(true);
		// the supervisor restarts: a new gate on the same home, a new drain that was told nothing
		const after = make();
		expect(after.isInteractiveLaunch("survivor")).toBe(true);
		expect(after.isInteractiveLaunch("never-launched")).toBe(false);
		const { drain } = makeDrain(after as never);
		await drain.drain();
		expect(sentPaths).toEqual(["/supervisors/sup-1/managed-sessions/survivor/events"]);
		expect(remaining("never-launched")).toHaveLength(1);
	});
});

describe("the state metadata whitelist is exact", () => {
	const bad: Array<[string, (id: string) => Record<string, unknown>]> = [
		["an extra metadata key", (id) => ({ ...stateBody(id).metadata, note: "x" })],
		["no interactiveBridge", () => ({ launchMode: "interactive_terminal" })],
		["another launchMode", (id) => ({ ...stateBody(id).metadata, launchMode: "headless" })],
		[
			"a socketPath that isn't this directory's control socket",
			(id) => ({
				launchMode: "interactive_terminal",
				interactiveBridge: { socketPath: "/tmp/elsewhere.sock", bridgePid: 1, childPid: 2 },
				...(id ? {} : {}),
			}),
		],
		[
			"an extra interactiveBridge key",
			(id) => ({
				launchMode: "interactive_terminal",
				interactiveBridge: {
					...(stateBody(id).metadata as { interactiveBridge: object }).interactiveBridge,
					extra: 1,
				},
			}),
		],
		[
			"a string pid",
			(id) => ({
				launchMode: "interactive_terminal",
				interactiveBridge: {
					socketPath: join(bridgeDir(id), "control.sock"),
					bridgePid: "42",
					childPid: 1,
				},
			}),
		],
		[
			"a zero pid",
			(id) => ({
				launchMode: "interactive_terminal",
				interactiveBridge: {
					socketPath: join(bridgeDir(id), "control.sock"),
					bridgePid: 0,
					childPid: 1,
				},
			}),
		],
	];
	for (const [label, metadata] of bad) {
		test(label, async () => {
			makeBridge("md");
			put("md", 1, envelope("state", stateBody("md", { metadata: metadata("md") })));
			const { gate, calls } = recorder();
			const { drain } = makeDrain(gate);
			drain.admit("md");
			await drain.drain();
			expect(calls).toEqual([]);
			expect(drain.stats().lost).toBe(1);
		});
	}

	test("an ended state needs an exitCode in range, and a running one may not carry one", async () => {
		const cases: Array<[string, Record<string, unknown>, boolean]> = [
			[
				"ended with exitCode 3",
				{ status: "failed", managedState: "failed", metadata: endedMetadata("md2", 3) },
				true,
			],
			["ended without exitCode", { status: "failed", managedState: "failed" }, false],
			[
				"ended with exitCode 9999",
				{ status: "failed", managedState: "failed", metadata: endedMetadata("md2", 9999) },
				false,
			],
			[
				"ended with a fractional exitCode",
				{ status: "failed", managedState: "failed", metadata: endedMetadata("md2", 1.5) },
				false,
			],
			["running with an exitCode", { metadata: endedMetadata("md2", 0) }, false],
		];
		for (const [label, over, accepted] of cases) {
			makeBridge("md2");
			put("md2", 1, envelope("state", stateBody("md2", over)));
			const { gate, calls } = recorder();
			const { drain } = makeDrain(gate);
			drain.admit("md2");
			await drain.drain();
			expect(calls.length, label).toBe(accepted ? 1 : 0);
			rmSync(reportsDir("md2"), { recursive: true, force: true });
		}
	});
});

describe("limits on what is read and when", () => {
	test("only the first 2,000 names of a reports directory are looked at, matched through a set", async () => {
		const junk = Array.from({ length: 2_000 }, (_, i) => `junk-${i}`);
		const beyond = Array.from({ length: 5 }, (_, i) => `${String(i + 1).padStart(16, "0")}.json`);
		const { gate } = recorder();
		const reads: string[] = [];
		const drain = createBridgeSpoolDrain({
			gate: gate as never,
			home,
			now: () => clock,
			log: () => undefined,
			credentialTripwire: createCredentialTripwire({ now: () => clock }),
			onCredentialRejected: () => undefined,
			stat: async () => ({
				mtimeMs: T0,
				uid: process.getuid?.() ?? 0,
				mode: 0o40700,
				isSymbolicLink: () => false,
				isDirectory: () => true,
				isSocket: () => false,
			}),
			readdir: async () => [...junk, ...beyond],
			readFile: (path): PrivateFileRead => {
				reads.push(path);
				return path.endsWith("bridge.json")
					? { kind: "ok", text: JSON.stringify({ launchNonce: NONCE }) }
					: { kind: "absent" };
			},
		});
		drain.admit("big");
		await drain.drain();
		expect(reads.filter((p) => /\d{16}\.json$/.test(p))).toEqual([]);
	});

	test("the lost-count event carries the lost file's own time, so a retry is byte for byte the same", async () => {
		makeBridge("lt");
		writeFileSync(join(reportsDir("lt"), "lost"), JSON.stringify({ v: 1, lostTotal: 4 }), {
			mode: 0o600,
		});
		const stamp = new Date(T0 - 7 * 3_600_000);
		utimesSync(join(reportsDir("lt"), "lost"), stamp, stamp);
		let failing = true;
		const { gate, calls } = recorder(() => (failing ? new SupervisorNetworkError() : "sent"));
		const { drain } = makeDrain(gate);
		drain.admit("lt");
		await drain.drain();
		failing = false;
		clock += 5_000;
		utimesSync(reportsDir("lt"), new Date(clock), new Date(clock));
		await drain.drain();
		expect(calls).toHaveLength(2);
		const [first, second] = calls as Array<Extract<Call, { kind: "events" }>>;
		expect(JSON.stringify(second?.events)).toBe(JSON.stringify(first?.events));
		expect(first?.events[0]?.occurredAt).toBe(stamp.toISOString());
		expect(second?.opts?.deliveryId).toBe(first?.opts?.deliveryId);
	});

	test("a crash between the gate's 'sent' and the unlink: the next tick sends the same delivery id again", async () => {
		makeBridge("crash2");
		put("crash2", 1, envelope("events", eventBody(), { deliveryId: "stable-crash-12345678" }));
		let unlinkFails = true;
		const { gate, calls } = recorder();
		const drain = createBridgeSpoolDrain({
			gate: gate as never,
			home,
			now: () => clock,
			log: () => undefined,
			credentialTripwire: createCredentialTripwire({ now: () => clock }),
			onCredentialRejected: () => undefined,
			unlink: (path) => {
				if (unlinkFails) throw new Error("EIO: the supervisor died here");
				rmSync(path);
			},
		});
		drain.admit("crash2");
		await drain.drain();
		expect(remaining("crash2"), "the file is still there").toHaveLength(1);
		unlinkFails = false;
		await drain.drain();
		expect(remaining("crash2")).toEqual([]);
		expect(calls.map((c) => (c as { opts?: { deliveryId?: string } }).opts?.deliveryId)).toEqual([
			"stable-crash-12345678",
			"stable-crash-12345678",
		]);
	});
});

describe("following and letting go", () => {
	const fakeStat = (over: Partial<SpoolStat> = {}): SpoolStat => ({
		mtimeMs: T0,
		uid: process.getuid?.() ?? 0,
		mode: 0o40700,
		isSymbolicLink: () => false,
		isDirectory: () => true,
		isSocket: () => false,
		...over,
	});

	test("256 followed bridges that have died are let go after 90 s, and a new launch is then admitted", async () => {
		const pidAgeMs = { value: 1_000 };
		const { gate } = recorder();
		const drain = createBridgeSpoolDrain({
			gate: gate as never,
			home,
			now: () => clock,
			log: () => undefined,
			credentialTripwire: createCredentialTripwire({ now: () => clock }),
			onCredentialRejected: () => undefined,
			stat: async (path) =>
				path.endsWith("bridge.pid") ? fakeStat({ mtimeMs: clock - pidAgeMs.value }) : fakeStat(),
			readdir: async () => [],
			readFile: (path): PrivateFileRead =>
				path.endsWith("bridge.pid")
					? { kind: "ok", text: JSON.stringify({ pid: 1 }) }
					: { kind: "ok", text: JSON.stringify({ launchNonce: NONCE }) },
			isPidAlive: () => true,
		});
		for (let i = 0; i < MAX_ACTIVE_DIRS; i++) drain.admit(`dead-${i}`);
		await drain.drain(); // settles each once; the bridges look alive
		expect(drain.stats().followed).toBe(MAX_ACTIVE_DIRS);
		drain.admit("one-too-many");
		expect(drain.stats().followed, "full").toBe(MAX_ACTIVE_DIRS);
		// the bridges die: their pid files stop being touched. Nothing else in the directories changes.
		pidAgeMs.value = 200_000;
		clock += 89_000;
		await drain.drain();
		expect(drain.stats().followed, "not yet 90 s since the last look").toBe(MAX_ACTIVE_DIRS);
		clock += 2_000;
		await drain.drain();
		expect(drain.stats().followed).toBe(0);
		drain.admit("new-launch");
		expect(drain.stats().followed).toBe(1);
	});

	test("one live bridge among 3,000 finished directories is followed at the first scan, without reading the others", async () => {
		const names = Array.from({ length: 3_000 }, (_, i) => `done-${i}`);
		names[1_777] = "live-one";
		const readBridgeJson: string[] = [];
		const { gate } = recorder();
		const drain = createBridgeSpoolDrain({
			gate: gate as never,
			home,
			now: () => clock,
			log: () => undefined,
			credentialTripwire: createCredentialTripwire({ now: () => clock }),
			onCredentialRejected: () => undefined,
			stat: async (path) => {
				if (path.endsWith("bridge.pid")) {
					if (path.includes("/live-one/")) return fakeStat({ mtimeMs: clock - 5_000 });
					throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
				}
				return fakeStat();
			},
			readdir: async (path) => (path === root() ? names : []),
			readFile: (path): PrivateFileRead => {
				if (path.endsWith("bridge.json")) {
					readBridgeJson.push(path);
					return { kind: "ok", text: JSON.stringify({ launchNonce: NONCE }) };
				}
				return { kind: "ok", text: JSON.stringify({ pid: 99 }) };
			},
			isPidAlive: () => true,
		});
		await drain.drain();
		expect(drain.stats().followed).toBe(1);
		expect(readBridgeJson).toHaveLength(1);
		expect(readBridgeJson[0]).toContain("live-one");
	});

	test("a finished directory that left reports behind is followed; one that left none, or whose bridge is gone with nothing in it, is not", async () => {
		makeBridge("left-something");
		put("left-something", 1, envelope("events", eventBody({ content: "unsent" })));
		makeBridge("left-nothing");
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate);
		await drain.drain();
		expect(calls.map((c) => c.id)).toEqual(["left-something"]);
	});

	test("more candidates than room are queued, not forgotten, and followed as room appears; none is read twice", async () => {
		const count = MAX_ACTIVE_DIRS + 44;
		const names = Array.from({ length: count }, (_, i) => `live-${i}`);
		const reads: string[] = [];
		const pidAge = { value: 1_000 };
		const { gate } = recorder();
		const drain = createBridgeSpoolDrain({
			gate: gate as never,
			home,
			now: () => clock,
			log: () => undefined,
			credentialTripwire: createCredentialTripwire({ now: () => clock }),
			onCredentialRejected: () => undefined,
			stat: async (path) =>
				path.endsWith("bridge.pid") ? fakeStat({ mtimeMs: clock - pidAge.value }) : fakeStat(),
			readdir: async (path) => (path === root() ? names : []),
			readFile: (path): PrivateFileRead => {
				if (path.endsWith("bridge.json")) {
					reads.push(path);
					return { kind: "ok", text: JSON.stringify({ launchNonce: NONCE }) };
				}
				return { kind: "ok", text: JSON.stringify({ pid: 99 }) };
			},
			isPidAlive: () => true,
		});
		await drain.drain();
		expect(drain.stats().followed).toBe(MAX_ACTIVE_DIRS);
		expect(reads, "each nonce was read once, at the scan, and handed on").toHaveLength(count);
		// the first 256 bridges die; their slots go to the waiting ones, with no further reads
		pidAge.value = 500_000;
		clock += 100_000;
		await drain.drain();
		expect(drain.stats().followed).toBeGreaterThan(0);
		expect(reads, "no bridge.json read twice").toHaveLength(count);
	});

	test("the first scan of 10,000 directories never holds the event loop for long", async () => {
		const names = Array.from({ length: 10_000 }, (_, i) => `hist-${i}`);
		const { gate } = recorder();
		const drain = createBridgeSpoolDrain({
			gate: gate as never,
			home,
			now: () => clock,
			log: () => undefined,
			credentialTripwire: createCredentialTripwire({ now: () => clock }),
			onCredentialRejected: () => undefined,
			stat: async () => fakeStat(),
			readdir: async (path) => (path === root() ? names : []),
			readFile: (): PrivateFileRead => ({ kind: "absent" }),
		});
		let maxGap = 0;
		let last = performance.now();
		const timer = setInterval(() => {
			const t = performance.now();
			maxGap = Math.max(maxGap, t - last);
			last = t;
		}, 2);
		await drain.drain();
		clearInterval(timer);
		expect(maxGap).toBeLessThan(150);
	}, 60_000);
});

describe("what the spool will not keep for ever (AGEN-83 final review)", () => {
	test("a private report over the size limit is removed and counted lost, not kept as if it were tampered with", async () => {
		makeBridge("big");
		put("big", 1, `${"x".repeat(1024 * 1024)}more`);
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate);
		drain.admit("big");
		await drain.drain();
		expect(remaining("big")).toEqual([]);
		expect(drain.stats().lost).toBe(1);
		expect(calls).toHaveLength(0);
	});

	test("a report that is not private is still left alone and said so, not removed", async () => {
		makeBridge("open");
		put("open", 1, envelope("events", eventBody()));
		chmodSync(seqFile("open", 1), 0o644);
		const logs: string[] = [];
		const { gate } = recorder();
		const { drain } = makeDrain(gate, { logs });
		drain.admit("open");
		await drain.drain();
		expect(remaining("open")).toHaveLength(1);
		expect(logs.some((l) => l.includes("isn't a private plain file"))).toBe(true);
	});

	test("a report held longer than the server keeps a receipt (72 h) is dropped as lost, by its file time after a restart", async () => {
		makeBridge("old");
		put("old", 1, envelope("events", eventBody()));
		const aged = new Date(clock - 73 * 3_600_000);
		utimesSync(seqFile("old", 1), aged, aged);
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate);
		drain.admit("old");
		await drain.drain();
		expect(calls).toHaveLength(0);
		expect(remaining("old")).toEqual([]);
		expect(drain.stats().lost).toBe(1);
	});

	test("one held 71 h is still sent", async () => {
		makeBridge("fresh");
		put("fresh", 1, envelope("events", eventBody()));
		const aged = new Date(clock - 71 * 3_600_000);
		utimesSync(seqFile("fresh", 1), aged, aged);
		const { gate, calls } = recorder();
		const { drain } = makeDrain(gate);
		drain.admit("fresh");
		await drain.drain();
		expect(calls).toHaveLength(1);
	});

	test("a report this process has held 72 h (the server was unreachable) is dropped by the process's own count", async () => {
		makeBridge("held");
		put("held", 1, envelope("events", eventBody()));
		const { gate, calls } = recorder(() => new Error("down"));
		const { drain } = makeDrain(gate);
		drain.admit("held");
		await drain.drain();
		expect(calls).toHaveLength(1);
		clock += 73 * 3_600_000;
		await drain.drain();
		expect(calls).toHaveLength(1); // not sent again
		expect(remaining("held")).toEqual([]);
		expect(drain.stats().lost).toBe(1);
	});
});
