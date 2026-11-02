/**
 * The report gate with the offline outbox wired in (AGEN-83 phase 5): what is kept when the server can't take a
 * report, what is sent when it returns and in what order, how each kind of failure is treated, and what the
 * credential tripwire may and may not do. Real files in a temp home, a scripted `request`, an injected clock.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedSessionEventInput, ManagedSessionStateInput } from "../../shared/types.js";
import {
	type CredentialDeps,
	FLUSH_MAX_PER_PASS,
	FLUSH_MAX_PER_SESSION,
	createReportGate,
} from "./report-gate.js";
import { createReportOutbox, outboxDirName } from "./report-outbox.js";
import {
	BACKOFF_BUDGET_MS,
	SupervisorNetworkError,
	SupervisorRequestError,
	createCredentialTripwire,
	wasCredentialHandled,
} from "./report-resilience.js";

const T0 = Date.parse("2026-11-01T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const SERVER_OK = { session: { displayName: "from-server" }, managedSession: {}, events: [] };

let home: string;
let work: string;
let clock: number;
let rulesVersion = 0;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-gate-outbox-")));
	work = join(home, "work", "secret-project");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
	clock = T0;
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function writeRules(lines: string[]) {
	const file = join(home, ".agentpulse", "exclude");
	writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	const at = new Date(Date.parse("2026-02-01T00:00:00Z") + ++rulesVersion * 1000);
	utimesSync(file, at, at);
}
const removeRules = () => rmSync(join(home, ".agentpulse", "exclude"), { force: true });

interface Call {
	path: string;
	rawBody: string;
	body: unknown;
	headers?: Record<string, string>;
	at: number;
}
type Script = (call: Call) => unknown | Promise<unknown>;

const outboxRoot = () => join(home, ".agentpulse", "supervisor-outbox");

function buildWorld(
	over: {
		script?: Script;
		canConfirm?: boolean;
		withTripwire?: boolean;
		random?: () => number;
		outbox?: ReturnType<typeof createReportOutbox>;
	} = {},
) {
	const calls: Call[] = [];
	const logs: string[] = [];
	const scheduled: number[] = [];
	let rejected = 0;
	let script: Script = over.script ?? (() => SERVER_OK);
	const request = async (path: string, options?: RequestInit) => {
		const rawBody = String(options?.body ?? "");
		const call: Call = {
			path,
			rawBody,
			body: rawBody ? JSON.parse(rawBody) : undefined,
			headers: options?.headers as Record<string, string> | undefined,
			at: clock,
		};
		calls.push(call);
		const result = await script(call);
		if (result instanceof Error) throw result;
		return result;
	};
	const outbox =
		over.outbox ??
		createReportOutbox({ home, supervisorId: "sup-1", now: () => clock, log: (l) => logs.push(l) });
	const tripwire = createCredentialTripwire({
		now: () => clock,
		canConfirm: over.canConfirm,
		log: (l) => logs.push(l),
	});
	const credentials: CredentialDeps =
		over.withTripwire === false
			? {}
			: { credentialTripwire: tripwire, onCredentialRejected: () => void rejected++ };
	const gate = createReportGate({
		request,
		supervisorId: "sup-1",
		home,
		now: () => clock,
		log: (l) => logs.push(l),
		outbox,
		...credentials,
		random: over.random ?? (() => 0.5),
		schedule: (fn, ms) => {
			scheduled.push(ms);
			fn();
		},
	});
	return {
		gate,
		outbox,
		calls,
		logs,
		scheduled,
		tripwire,
		rejected: () => rejected,
		setScript: (next: Script) => {
			script = next;
		},
		pending: () => outbox.summary().pending,
	};
}

/** A world whose outbox has finished listing, so a healthy host sends live. */
async function world(over: Parameters<typeof buildWorld>[0] = {}) {
	const built = buildWorld(over);
	await built.outbox.ready();
	return built;
}
type World = Awaited<ReturnType<typeof world>>;

const probe = (
	content: string,
	extra: Partial<ManagedSessionEventInput> = {},
): ManagedSessionEventInput[] => [
	{ eventType: "ManagedProbe", category: "system_event", content, ...extra },
];
const stateOf = (
	sessionId: string,
	extra: Partial<ManagedSessionStateInput> = {},
): ManagedSessionStateInput => ({
	sessionId,
	agentType: "claude_code",
	status: "active",
	managedState: "headless",
	...extra,
});
const network = () => new SupervisorNetworkError(new TypeError("fetch failed"));
const http = (status: number, error?: string, retryAfterMs?: number) =>
	new SupervisorRequestError(status, "x", error, retryAfterMs);
const CREDENTIAL = () => http(401, "Invalid supervisor credential");

/** A flush at the current clock; the calls it made. */
async function flushed(w: World) {
	const before = w.calls.length;
	await w.gate.flush();
	return w.calls.slice(before);
}

describe("a healthy host", () => {
	test("sends live, creates no outbox root, and the outcome is sent", async () => {
		const w = await world();
		w.gate.noteCwd("s1", work);
		expect(await w.gate.reportEvents("s1", probe("a"))).toBe("sent");
		const state = await w.gate.reportState(stateOf("s1"));
		expect(state.outcome).toBe("sent");
		expect(state.session.displayName).toBe("from-server");
		expect(existsSync(outboxRoot())).toBe(false);
		expect(w.calls).toHaveLength(2);
	});

	test("without an outbox a failure throws as it always did", async () => {
		const calls: string[] = [];
		const gate = createReportGate({
			request: async (path) => {
				calls.push(path);
				throw network();
			},
			supervisorId: "sup-1",
			home,
			log: () => undefined,
		});
		await expect(gate.reportEvents("s1", probe("a"))).rejects.toBeInstanceOf(
			SupervisorNetworkError,
		);
		expect(gate.isOffline()).toBe(false);
	});
});

describe("when the server can't be reached", () => {
	test("a network error queues the report, latches offline, and the caller gets 'queued' with an empty state result", async () => {
		const w = await world({ script: () => network() });
		w.gate.noteCwd("s1", work);
		const state = await w.gate.reportState(stateOf("s1"));
		expect(state.outcome).toBe("queued");
		expect(state.session.displayName).toBe("");
		expect(w.gate.isOffline()).toBe(true);
		expect(w.pending()).toBe(1);
		expect(w.calls).toHaveLength(1);
	});

	test("while latched, every session's reports are queued without a call", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("s1", probe("first"));
		const before = w.calls.length;
		expect(await w.gate.reportEvents("s2", probe("other session"))).toBe("queued");
		expect(await w.gate.reportEvents("s1", probe("same session"))).toBe("queued");
		expect((await w.gate.reportState(stateOf("s3"))).outcome).toBe("queued");
		expect(w.calls.length).toBe(before);
		expect(w.pending()).toBe(4);
	});

	test("a report queues behind what its session already has queued even once the server is back, so order holds", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("s1", probe("old"));
		w.setScript(() => SERVER_OK);
		w.gate.noteServerReachable();
		const before = w.calls.length;
		expect(await w.gate.reportEvents("s1", probe("new"))).toBe("queued");
		expect(w.calls.length, "no live call overtakes the queue").toBe(before);
	});

	test("a 5xx or 408 or 429 queues it too (attempted), without latching the whole host offline", async () => {
		for (const status of [500, 502, 408, 429]) {
			const w = await world({ script: () => http(status) });
			expect(await w.gate.reportEvents(`s${status}`, probe("x"))).toBe("queued");
			expect(w.gate.isOffline(), String(status)).toBe(false);
			expect(w.outbox.hasPending(`s${status}`)).toBe(true);
		}
	});

	test("the server's own back-pressure (a 503 busy with Retry-After) on a live send queues it", async () => {
		const w = await world({ script: () => http(503, "busy", 2_000) });
		expect(await w.gate.reportEvents("s1", probe("x"))).toBe("queued");
		expect(w.gate.isOffline()).toBe(false);
	});

	test("if the outbox can't keep it the caller sees the original error, as without an outbox", async () => {
		const w = await world({
			script: () => network(),
			outbox: createReportOutbox({
				home,
				supervisorId: "sup-1",
				now: () => clock,
				limits: { sessions: 0 },
			}),
		});
		await expect(w.gate.reportEvents("s1", probe("x"))).rejects.toBeInstanceOf(
			SupervisorNetworkError,
		);
	});

	test("a failure that is not a delivery problem is thrown, not queued: credential, session, entry, stop", async () => {
		const cases: Array<[string, unknown]> = [
			["credential", CREDENTIAL()],
			["session", http(403, "session_not_owned")],
			["entry", http(400, "invalid_body")],
			["stop", http(404)],
			["other", new TypeError("boom")],
		];
		for (const [label, error] of cases) {
			const w = await world({ script: () => error });
			await expect(w.gate.reportEvents(`s-${label}`, probe("x")), label).rejects.toBe(error);
			expect(w.pending(), label).toBe(0);
		}
	});

	test("a report produced while the rules are invalid is not queued", async () => {
		const w = await world({ script: () => network() });
		w.gate.noteCwd("s1", work);
		writeRules(["not/an/absolute/path"]);
		expect(await w.gate.reportEvents("s1", probe("x"))).toBe("blocked");
		expect((await w.gate.reportState(stateOf("s1"))).outcome).toBe("blocked");
		expect(w.pending()).toBe(0);
		expect(existsSync(outboxRoot())).toBe(false);
	});

	test("a 2xx that isn't JSON (an HTML page from a proxy) is no delivery: queued, and the reports stay", async () => {
		const w = await world({
			script: () => new SupervisorNetworkError(new SyntaxError("Unexpected token '<'")),
		});
		expect(await w.gate.reportEvents("s1", probe("x"))).toBe("queued");
		expect((await w.gate.reportState(stateOf("s1"))).outcome).toBe("queued");
		expect(w.pending()).toBe(2);
	});
});

describe("sending what was kept", () => {
	test("in order across kinds, with the original bytes, the same delivery id and the replay header", async () => {
		const w = await world({ script: () => network() });
		w.gate.noteCwd("s1", work);
		await w.gate.reportState(stateOf("s1", { cwd: work }));
		await w.gate.reportEvents("s1", probe("e1"), { deliveryId: "delivery-one-12345678" });
		await w.gate.reportState(stateOf("s1", { status: "completed", managedState: "stopped" }));
		await w.gate.reportEvents("s1", probe("e2"), { deliveryId: "delivery-two-12345678" });
		w.setScript(() => SERVER_OK);
		w.gate.noteServerReachable();
		const sent = await flushed(w);

		expect(sent.map((c) => c.path.replace("/supervisors/sup-1", ""))).toEqual([
			"/managed-session-state",
			"/managed-sessions/s1/events",
			"/managed-session-state",
			"/managed-sessions/s1/events",
		]);
		expect(sent[1]?.headers).toEqual({
			"X-AgentPulse-Delivery-Id": "delivery-one-12345678",
			"X-AgentPulse-Replay": "1",
		});
		expect(sent[3]?.headers?.["X-AgentPulse-Delivery-Id"]).toBe("delivery-two-12345678");
		expect(sent[0]?.headers).toEqual({ "X-AgentPulse-Replay": "1" });
		expect(w.pending()).toBe(0);
		expect(existsSync(join(outboxRoot(), outboxDirName("s1")))).toBe(false);
	});

	test("the queued bytes are exactly the bytes of the first attempt", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("s1", probe("exact", { rawPayload: { n: 1 } }), {
			deliveryId: "delivery-exact-1234",
		});
		const first = w.calls[0] as Call;
		w.setScript(() => SERVER_OK);
		w.gate.noteServerReachable();
		const [replay] = await flushed(w);
		expect(replay?.rawBody).toBe(first.rawBody);
		expect(replay?.headers?.["X-AgentPulse-Delivery-Id"]).toBe(
			first.headers?.["X-AgentPulse-Delivery-Id"],
		);
	});

	test("two reports for one session at once keep their order, even when the first is slow", async () => {
		const order: string[] = [];
		let release!: () => void;
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const w = await world({
			script: async (call) => {
				const content = (call.body as { events: Array<{ content: string }> }).events[0]
					?.content as string;
				order.push(`start:${content}`);
				if (content === "first") await hold;
				order.push(`end:${content}`);
				return SERVER_OK;
			},
		});
		const a = w.gate.reportEvents("s1", probe("first"));
		const b = w.gate.reportEvents("s1", probe("second"));
		await new Promise((r) => setTimeout(r, 20));
		expect(order).toEqual(["start:first"]);
		release();
		await Promise.all([a, b]);
		expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
	});

	test("a flush waits a random moment first when the server has just come back", async () => {
		const w = await world({ script: () => network(), random: () => 0.5 });
		await w.gate.reportEvents("s1", probe("x"));
		w.setScript(() => SERVER_OK);
		w.gate.noteServerReachable();
		await w.gate.flush();
		expect(w.scheduled).toEqual([2_500]);
		await w.gate.reportEvents("s2", probe("y"));
		w.gate.noteServerUnreachable();
		w.gate.noteServerReachable();
		await w.gate.flush();
		expect(w.scheduled, "nothing queued, nothing to wait for").toEqual([2_500]);
	});

	test("a flush does nothing while the host is latched offline", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("s1", probe("x"));
		w.setScript(() => SERVER_OK);
		expect(await flushed(w)).toEqual([]);
		w.gate.noteServerReachable();
		expect(await flushed(w)).toHaveLength(1);
	});

	test("a network failure in a flush latches offline, keeps everything and ends the pass", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("s1", probe("a"));
		await w.gate.reportEvents("s2", probe("b"));
		w.gate.noteServerReachable();
		const sent = await flushed(w);
		expect(sent).toHaveLength(1);
		expect(w.gate.isOffline()).toBe(true);
		expect(w.pending()).toBe(2);
	});

	test(`a flush sends at most ${FLUSH_MAX_PER_SESSION} for one session and ${FLUSH_MAX_PER_PASS} in all`, async () => {
		const w = await world({ script: () => network() });
		for (let i = 0; i < 130; i++) await w.gate.reportEvents("big", probe(`m${i}`));
		for (let i = 0; i < 80; i++) await w.gate.reportEvents("other", probe(`o${i}`));
		w.setScript(() => SERVER_OK);
		w.gate.noteServerReachable();
		const first = await flushed(w);
		expect(first).toHaveLength(FLUSH_MAX_PER_PASS);
		expect(first.filter((c) => c.path.includes("/big/"))).toHaveLength(FLUSH_MAX_PER_SESSION);
		const second = await flushed(w);
		expect(second.length).toBeGreaterThan(0);
		let total = first.length + second.length;
		for (let i = 0; i < 5; i++) total += (await flushed(w)).length;
		expect(total).toBe(210);
		expect(w.pending()).toBe(0);
	});

	test("a delivery completes a flush: the summary reports what was delivered", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("s1", probe("a"));
		await w.gate.reportEvents("s1", probe("b"));
		w.setScript(() => SERVER_OK);
		w.gate.noteServerReachable();
		await w.gate.flush();
		expect(w.outbox.summary()).toMatchObject({
			pending: 0,
			lastFlushDelivered: 2,
			lastFlushLost: 0,
		});
		expect(w.outbox.summary().lastFlushAt).toBe(new Date(clock).toISOString());
	});
});

describe("a restart: every session counts as pending until the outbox has listed its directories", () => {
	test("a report during the load lands behind the entries an earlier run left", async () => {
		const earlier = await world({ script: () => network() });
		await earlier.outbox.ready();
		await earlier.gate.reportEvents("s1", probe("before-restart"));

		const fresh = createReportOutbox({ home, supervisorId: "sup-1", now: () => clock });
		const w = buildWorld({ outbox: fresh });
		expect(fresh.listed(), "the listing has not run yet").toBe(false);
		expect(await w.gate.reportEvents("s1", probe("during-load"))).toBe("queued");
		expect(w.calls, "no live call overtook the queue").toEqual([]);
		await fresh.ready();
		w.gate.noteServerReachable();
		const sent = await flushed(w);
		expect(
			sent.map((c) => (c.body as { events: Array<{ content: string }> }).events[0]?.content),
		).toEqual(["before-restart", "during-load"]);
	});

	test("once listed, a session with nothing queued sends live again", async () => {
		const fresh = createReportOutbox({ home, supervisorId: "sup-1", now: () => clock });
		const w = await world({ outbox: fresh });
		await fresh.ready();
		expect(await w.gate.reportEvents("s1", probe("live"))).toBe("sent");
	});
});

describe("exclusion and the rules", () => {
	test("an exclusion added mid-flush stops at the entry boundary, the directory is gone, and the session gets its one closing report", async () => {
		const w = await world({ script: () => network() });
		w.gate.noteCwd("s1", work);
		await w.gate.reportState(stateOf("s1", { cwd: work }));
		for (const c of ["a", "b", "c"]) await w.gate.reportEvents("s1", probe(c));
		expect(w.pending()).toBe(4);
		w.gate.noteServerReachable();
		let n = 0;
		w.setScript(() => {
			n++;
			if (n === 1) writeRules([work]); // the rule appears as the first entry is being sent
			return SERVER_OK;
		});
		const sent = await flushed(w);
		const paths = sent.map((c) => c.path.replace("/supervisors/sup-1", ""));
		// the state that was in flight, then the closing report: no event goes out after the rule
		expect(paths).toEqual(["/managed-session-state", "/managed-session-state"]);
		expect(sent[1]?.body).toEqual({
			sessionId: "s1",
			status: "completed",
			managedState: "stopped",
			providerSyncState: "synced",
		});
		expect(w.pending()).toBe(0);
		expect(existsSync(join(outboxRoot(), outboxDirName("s1")))).toBe(false);
		expect(JSON.stringify(sent)).not.toContain('"a"');
	});

	test("rules turning invalid mid-flush hold everything: nothing more goes out, nothing is purged", async () => {
		const w = await world({ script: () => network() });
		w.gate.noteCwd("s1", work);
		for (const c of ["a", "b", "c"]) await w.gate.reportEvents("s1", probe(c));
		let n = 0;
		w.setScript(() => {
			n++;
			if (n === 1) writeRules(["not/an/absolute/path"]);
			return SERVER_OK;
		});
		w.gate.noteServerReachable();
		await w.gate.flush();
		expect(n).toBe(1);
		expect(w.pending()).toBe(2);
		removeRules();
		w.setScript(() => SERVER_OK);
		const rest = await flushed(w);
		expect(rest).toHaveLength(2);
		expect(w.pending()).toBe(0);
	});

	test("scan purges the outbox of a session a new rule covers, held entries included, and an unknown session under rules", async () => {
		const w = await world({ script: () => network() });
		w.gate.noteCwd("covered", work);
		w.gate.noteCwd("open", join(home, "open"));
		await w.gate.reportEvents("covered", probe("secret"));
		await w.gate.reportEvents("open", probe("fine"));
		await w.gate.reportEvents("stranger", probe("no record"));
		// make the covered session's head a link: held
		const dir = join(outboxRoot(), outboxDirName("covered"));
		const entry = join(dir, "0000000000000001.json");
		const decoy = join(home, "decoy.json");
		writeFileSync(decoy, "{}", { mode: 0o600 });
		rmSync(entry);
		symlinkSync(decoy, entry);
		expect(w.outbox.head("covered")).toBe("held");
		writeRules([work]);
		await w.gate.scan();
		expect(existsSync(dir)).toBe(false);
		expect(w.outbox.hasPending("covered")).toBe(false);
		expect(w.outbox.hasPending("stranger"), "an unknown session fails closed under rules").toBe(
			false,
		);
		expect(w.outbox.hasPending("open")).toBe(true);
	});

	test("a report that arrives for a session now excluded purges what it had queued", async () => {
		const w = await world({ script: () => network() });
		w.gate.noteCwd("s1", work);
		await w.gate.reportEvents("s1", probe("old"));
		expect(w.pending()).toBe(1);
		writeRules([work]);
		expect(await w.gate.reportEvents("s1", probe("new"))).toBe("excluded");
		expect(w.pending()).toBe(0);
	});
});

describe("each kind of failure while sending what was kept (D8)", () => {
	async function queuedState(w: World, id = "s1") {
		await w.gate.reportState(stateOf(id));
		w.gate.noteServerReachable();
	}

	test("server (5xx): this session backs off, the failure counts, the head stays", async () => {
		const w = await world({ script: () => network() });
		await queuedState(w);
		w.setScript(() => http(500));
		await flushed(w);
		expect(w.pending()).toBe(1);
		expect((w.outbox.head("s1") as { failures?: number }).failures).toBe(1);
		expect(await flushed(w), "in backoff: no call").toEqual([]);
	});

	test("stop (404): this session backs off like server and the failure counts; another session still delivers", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportState(stateOf("A"));
		await w.gate.reportState(stateOf("B"));
		w.gate.noteServerReachable();
		w.setScript((call) =>
			call.path.includes("managed-session-state") &&
			(call.body as ManagedSessionStateInput).sessionId === "A"
				? http(404)
				: SERVER_OK,
		);
		await w.gate.flush();
		expect(w.outbox.hasPending("A")).toBe(true);
		expect(w.outbox.hasPending("B")).toBe(false);
		expect((w.outbox.head("A") as { failures?: number }).failures).toBe(1);
	});

	test("session (403 session_not_owned): the session's queue is purged, counted lost", async () => {
		const w = await world({ script: () => network() });
		await queuedState(w);
		await w.gate.reportEvents("s1", probe("x"));
		w.setScript(() => http(403, "session_not_owned"));
		await w.gate.flush();
		expect(w.outbox.hasPending("s1")).toBe(false);
		expect(w.outbox.summary().lastFlushLost).toBe(2);
	});

	test("entry (400 invalid_body): that report is dropped, counted lost, and the next one is tried at once", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("s1", probe("bad"));
		await w.gate.reportEvents("s1", probe("good"));
		w.gate.noteServerReachable();
		w.setScript((call) =>
			JSON.stringify(call.body).includes('"bad"') ? http(400, "invalid_body") : SERVER_OK,
		);
		const sent = await flushed(w);
		expect(sent).toHaveLength(2);
		expect(w.pending()).toBe(0);
		expect(w.outbox.summary()).toMatchObject({ lastFlushDelivered: 1, lastFlushLost: 1 });
	});

	test("other (a local TypeError): kept, retried, never counted", async () => {
		const w = await world({ script: () => network() });
		await queuedState(w);
		w.setScript(() => new TypeError("local bug"));
		await flushed(w);
		expect(w.pending()).toBe(1);
		expect((w.outbox.head("s1") as { failures?: number }).failures).toBeUndefined();
		expect(w.logs.join("\n")).toContain("local reason");
	});

	test("an HTML 200 in a flush leaves every queued entry in place", async () => {
		const w = await world({ script: () => network() });
		await queuedState(w);
		await w.gate.reportEvents("s1", probe("x"));
		w.setScript(() => new SupervisorNetworkError(new SyntaxError("Unexpected token '<'")));
		await w.gate.flush();
		expect(w.pending()).toBe(2);
		expect(w.outbox.summary().lastFlushDelivered).toBe(0);
	});

	test("held: a session whose head can't be trusted is skipped and does not block another", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportState(stateOf("P"));
		await w.gate.reportState(stateOf("Q"));
		const entry = join(outboxRoot(), outboxDirName("P"), "0000000000000001.json");
		const decoy = join(home, "decoy.json");
		writeFileSync(decoy, "{}", { mode: 0o600 });
		rmSync(entry);
		symlinkSync(decoy, entry);
		w.gate.noteServerReachable();
		w.setScript(() => SERVER_OK);
		const sent = await flushed(w);
		expect(sent.map((c) => (c.body as ManagedSessionStateInput).sessionId)).toEqual(["Q"]);
		expect(w.outbox.hasPending("P")).toBe(true);
	});
});

describe("backoff: the wait after each failure", () => {
	async function failingState(random: () => number) {
		const w = await world({ script: () => network(), random });
		await w.gate.reportState(stateOf("s1"));
		w.gate.noteServerReachable();
		return w;
	}

	test("3, 6, 12, 24, 48, 60, 60 seconds: not a call a millisecond earlier, a call exactly then", async () => {
		const w = await failingState(() => 0.5);
		w.setScript(() => http(500));
		const waits = [3, 6, 12, 24, 48, 60, 60].map((s) => s * 1000);
		expect(await flushed(w)).toHaveLength(1);
		for (const wait of waits.slice(0, -1)) {
			clock += wait - 1;
			expect(await flushed(w), `${wait} ms is not enough`).toEqual([]);
			clock += 1;
			expect(await flushed(w), `${wait} ms is`).toHaveLength(1);
		}
		const last = waits[waits.length - 1] as number;
		clock += last - 1;
		expect(await flushed(w)).toEqual([]);
		clock += 1;
		expect(await flushed(w)).toHaveLength(1);
	});

	test("jitter is within 20% either way", async () => {
		for (const [random, factor] of [
			[() => 0, 0.8],
			[() => 0.999999, 1.2],
		] as const) {
			const w = await failingState(random);
			w.setScript(() => http(500));
			await flushed(w);
			clock += Math.floor(3_000 * factor) - 2;
			expect(await flushed(w)).toEqual([]);
			clock += 4;
			expect(await flushed(w)).toHaveLength(1);
			clock += 1_000_000;
		}
	});

	test("Retry-After takes precedence when it asks for longer", async () => {
		const w = await failingState(() => 0.5);
		w.setScript(() => http(500, undefined, 90_000));
		await flushed(w);
		clock += 89_999;
		expect(await flushed(w)).toEqual([]);
		clock += 1;
		expect(await flushed(w)).toHaveLength(1);
	});

	test("a success clears the session's backoff", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportState(stateOf("s1"));
		await w.gate.reportState(stateOf("s1", { cwd: work }));
		w.gate.noteServerReachable();
		let first = true;
		w.setScript(() => {
			if (first) {
				first = false;
				return http(500);
			}
			return SERVER_OK;
		});
		await flushed(w);
		clock += 3_000;
		expect(await flushed(w)).toHaveLength(2);
	});
});

describe("the poison rule", () => {
	async function stuck(error: unknown) {
		const w = await world({ script: () => network() });
		await w.gate.reportState(stateOf("s1"));
		w.gate.noteServerReachable();
		w.setScript(() => error);
		return w;
	}
	const attempts = async (w: World, n: number, everyMs: number) => {
		for (let i = 0; i < n; i++) {
			await w.gate.flush();
			clock += everyMs;
		}
	};

	for (const [label, error] of [
		["server (500)", http(500)],
		["stop (404)", http(404)],
	] as const) {
		test(`${label}: 8 failures over more than an hour remove the head as lost`, async () => {
			const w = await stuck(error);
			await attempts(w, 8, 10 * MINUTE);
			expect(w.pending()).toBe(0);
			expect(w.outbox.summary().lastFlushLost).toBe(1);
		});

		test(`${label}: 8 failures inside an hour do not`, async () => {
			const w = await stuck(error);
			await attempts(w, 8, 7 * MINUTE);
			expect(w.pending()).toBe(1);
		});
	}
});

describe("back-pressure is waiting, not failing", () => {
	async function pressured(retryAfterMs: number, kind: "state" | "events" = "state") {
		const w = await world({ script: () => network() });
		if (kind === "state") await w.gate.reportState(stateOf("s1"));
		else {
			w.gate.noteCwd("s1", work);
			await w.gate.reportEvents("s1", probe("x"));
		}
		w.gate.noteServerReachable();
		w.setScript(() => http(503, "busy", retryAfterMs));
		return w;
	}

	test("fifty 503-busy answers over a day never count and never poison", async () => {
		const w = await pressured(2_000);
		for (let i = 0; i < 50; i++) {
			await w.gate.flush();
			clock += 30 * MINUTE;
		}
		expect(w.pending()).toBe(1);
		expect((w.outbox.head("s1") as { failures?: number }).failures).toBeUndefined();
	});

	test("but waiting longer than six hours in all makes each further backoff count", async () => {
		const w = await pressured(HOUR);
		const failures = async () => (w.outbox.head("s1") as { failures?: number }).failures;
		// six one-hour waits: exactly the budget, not over it
		for (let i = 0; i < 6; i++) {
			await w.gate.flush();
			clock += HOUR;
		}
		expect(await failures()).toBeUndefined();
		// the seventh pushes the head past six hours: it counts from here on
		await w.gate.flush();
		clock += HOUR;
		expect(await failures()).toBe(1);
		await w.gate.flush();
		expect(await failures()).toBe(2);
		expect(BACKOFF_BUDGET_MS).toBe(6 * HOUR);
	});

	test("a different head starts a fresh budget", async () => {
		const w = await pressured(HOUR);
		for (let i = 0; i < 7; i++) {
			await w.gate.flush();
			clock += HOUR;
		}
		expect((w.outbox.head("s1") as { failures?: number }).failures).toBe(1);
		w.setScript(() => SERVER_OK);
		await w.gate.flush();
		expect(w.pending()).toBe(0);
	});
});

describe("events for a session the server has no row for", () => {
	test("a 500 does not count while the gate has never delivered anything for the session; after six hours of waiting it does", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("ghost", probe("early"));
		w.gate.noteServerReachable();
		w.setScript(() => http(500, undefined, HOUR));
		for (let i = 0; i < 6; i++) {
			await w.gate.flush();
			clock += HOUR;
		}
		expect((w.outbox.head("ghost") as { failures?: number }).failures).toBeUndefined();
		await w.gate.flush();
		expect((w.outbox.head("ghost") as { failures?: number }).failures).toBe(1);
	});

	test("once the gate has delivered something for the session, a 500 is an ordinary counted failure", async () => {
		const w = await world();
		w.gate.noteCwd("known", work);
		await w.gate.reportState(stateOf("known"));
		w.setScript(() => network());
		await w.gate.reportEvents("known", probe("x"));
		w.gate.noteServerReachable();
		w.setScript(() => http(500));
		await w.gate.flush();
		expect((w.outbox.head("known") as { failures?: number }).failures).toBe(1);
	});

	test("the state that creates the row, queued behind the events, is not stuck forever: when the row appears everything flows", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("late-row", probe("first"));
		w.gate.noteServerReachable();
		let rowExists = false;
		w.setScript((call) => {
			if (call.path.endsWith("/events") && !rowExists) return http(500);
			rowExists = true;
			return SERVER_OK;
		});
		await w.gate.flush();
		expect(w.pending()).toBe(1);
		clock += 5 * MINUTE;
		rowExists = true;
		await w.gate.flush();
		expect(w.pending()).toBe(0);
	});
});

describe("the credential tripwire", () => {
	async function rejectedWorld(over: Parameters<typeof world>[0] = {}) {
		const w = await world({ script: () => network(), ...over });
		await w.gate.reportState(stateOf("s1"));
		w.gate.noteServerReachable();
		w.setScript(() => CREDENTIAL());
		return w;
	}

	test("one rejection does not end the supervisor, a second at least 10 s later does, and the entries are kept throughout", async () => {
		const w = await rejectedWorld();
		await w.gate.flush();
		expect(w.rejected()).toBe(0);
		clock += 9_000;
		await w.gate.flush();
		expect(w.rejected()).toBe(0);
		clock += 2_000;
		await w.gate.flush();
		expect(w.rejected()).toBe(1);
		expect(w.pending()).toBe(1);
	});

	test("a credential rejection on a live send is thrown, tagged as already counted, and feeds the same tripwire", async () => {
		const w = await world({ script: () => CREDENTIAL() });
		let thrown: unknown;
		await w.gate.reportEvents("s1", probe("x")).catch((e) => {
			thrown = e;
		});
		expect(thrown).toBeInstanceOf(SupervisorRequestError);
		expect(wasCredentialHandled(thrown)).toBe(true);
		clock += 10_000;
		await w.gate.reportEvents("s1", probe("y")).catch(() => undefined);
		expect(w.rejected()).toBe(1);
	});

	test("a rejection from any other send (a launch status, a control status) feeds it too", async () => {
		const w = await world({ script: () => CREDENTIAL() });
		w.gate.noteCwd("launch-1", work);
		await w.gate.reportLaunchStatus("launch-1", { status: "running" }).catch(() => undefined);
		clock += 10_000;
		await w.gate.reportLaunchStatus("launch-1", { status: "running" }).catch(() => undefined);
		expect(w.rejected()).toBe(1);
	});

	test("over plain http to a non-local server it is never acted on, however far apart", async () => {
		const w = await rejectedWorld({ canConfirm: false });
		for (let i = 0; i < 6; i++) {
			await w.gate.flush();
			clock += 5 * MINUTE;
		}
		expect(w.rejected()).toBe(0);
		expect(w.logs.filter((l) => l.includes("not acting on it"))).toHaveLength(1);
		expect(w.pending()).toBe(1);
	});

	test("a gate with no tripwire counts nothing and throws as before", async () => {
		const w = await world({ script: () => CREDENTIAL(), withTripwire: false });
		await expect(w.gate.reportEvents("s1", probe("x"))).rejects.toBeInstanceOf(
			SupervisorRequestError,
		);
		expect(w.rejected()).toBe(0);
	});

	describe("every success path resets it", () => {
		const armed = (w: World) => {
			w.tripwire.record();
			clock += 11_000;
		};
		const stillFirst = (w: World) => {
			// had the earlier rejection survived, this one (11 s later) would confirm
			expect(w.tripwire.record()).toBe("first");
		};

		test("a live send", async () => {
			const w = await world();
			armed(w);
			await w.gate.reportEvents("s1", probe("ok"));
			stillFirst(w);
		});

		test("a flush", async () => {
			const w = await world({ script: () => network() });
			await w.gate.reportEvents("s1", probe("x"));
			w.setScript(() => SERVER_OK);
			w.gate.noteServerReachable();
			armed(w);
			await w.gate.flush();
			stillFirst(w);
		});

		test("a heartbeat (noteServerReachable)", async () => {
			const w = await world();
			armed(w);
			w.gate.noteServerReachable();
			stillFirst(w);
		});

		test("any other send: a launch status", async () => {
			const w = await world();
			w.gate.noteCwd("l1", work);
			armed(w);
			await w.gate.reportLaunchStatus("l1", { status: "running" });
			stillFirst(w);
		});

		test("but an excluded or queued report, which never reached the server, does not", async () => {
			const w = await world({ script: () => network() });
			w.gate.noteCwd("s1", work);
			await w.gate.reportEvents("s1", probe("x")); // queued after a network failure
			w.tripwire.record();
			clock += 11_000;
			await w.gate.reportEvents("s1", probe("queued behind")); // queued, no call
			writeRules([work]);
			await w.gate.reportEvents("s1", probe("excluded"));
			expect(w.tripwire.record(), "the earlier rejection is still standing").toBe("confirmed");
		});
	});
});

describe("noteServerReachable and the offline latch", () => {
	test("a successful send clears the latch", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("s1", probe("x"));
		expect(w.gate.isOffline()).toBe(true);
		w.setScript(() => SERVER_OK);
		w.gate.noteCwd("launch", work);
		await w.gate.reportLaunchStatus("launch", { status: "running" });
		expect(w.gate.isOffline()).toBe(false);
	});

	test("noteServerUnreachable then noteServerReachable round-trips", async () => {
		const w = await world();
		w.gate.noteServerUnreachable();
		expect(w.gate.isOffline()).toBe(true);
		w.gate.noteServerReachable();
		expect(w.gate.isOffline()).toBe(false);
	});
});

describe("a queued Codex bootstrap state still yields a runtime", () => {
	test("launchManagedCodexRequest (dry run) with every report queued returns its runtime", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("warm", probe("x")); // latch offline
		const { launchManagedCodexRequest } = await import("../providers/codex-managed.js");
		const previous = process.env.AGENTPULSE_SUPERVISOR_DRY_RUN;
		process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "true";
		try {
			w.gate.noteCwd("codex-1", work);
			const result = await launchManagedCodexRequest(
				{
					id: "launch-1",
					launchCorrelationId: "codex-1",
					agentType: "codex_cli",
					requestedLaunchMode: "managed_codex",
					cwd: work,
					model: "m",
					approvalPolicy: "default",
					sandboxMode: "default",
					env: {},
					launchSpec: {},
				} as never,
				{
					reportState: (body) => w.gate.reportState(body),
					reportEvents: (events) => w.gate.reportEvents("codex-1", events),
				},
			);
			expect(result.runtime.sessionId).toBe("codex-1");
			expect(result.runtime.currentThreadTitle).toBe("");
			expect(w.outbox.hasPending("codex-1")).toBe(true);
		} finally {
			if (previous === undefined) process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = undefined;
			else process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = previous;
		}
	});
});

describe("leftovers", () => {
	test("flush removes nothing it shouldn't: the outbox root holds only what is queued", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("s1", probe("x"));
		expect(readdirSync(outboxRoot()).filter((n) => n.startsWith("s-"))).toHaveLength(1);
		w.setScript(() => SERVER_OK);
		w.gate.noteServerReachable();
		await w.gate.flush();
		expect(readdirSync(outboxRoot()).filter((n) => n.startsWith("s-"))).toEqual([]);
	});
});

describe("the Phase 5 review fixes", () => {
	const stateEntry = (w: World, id: string) =>
		w.outbox.head(id) as { kind: string; failures?: number };

	test("a live report issued mid-flush is not held for the whole turn: it completes within about one round trip", async () => {
		const RTT = 30;
		const w = await world({ script: () => network() });
		for (let i = 0; i < 50; i++) await w.gate.reportEvents("a", probe(`m${i}`));
		w.setScript(async () => {
			await new Promise((r) => setTimeout(r, RTT));
			return SERVER_OK;
		});
		w.gate.noteServerReachable();
		const turn = w.gate.flush();
		await new Promise((r) => setTimeout(r, 5));
		const started = performance.now();
		await w.gate.reportEvents("a", probe("live"));
		const took = performance.now() - started;
		await turn;
		// the whole turn is 50 round trips (1.5 s): the report waited for at most the one in flight
		expect(took).toBeLessThan(RTT * 4 + 100);
	}, 20_000);

	test("the 100-per-pass cap with three sessions of 60: 100 first (A 50, B 50, C none), then the rest", async () => {
		const w = await world({ script: () => network() });
		for (const id of ["A", "B", "C"]) {
			for (let i = 0; i < 60; i++) await w.gate.reportEvents(id, probe(`${id}${i}`));
		}
		w.setScript(() => SERVER_OK);
		w.gate.noteServerReachable();
		const first = await flushed(w);
		const per = (calls: Call[], id: string) =>
			calls.filter((c) => c.path.includes(`/${id}/`)).length;
		expect(first).toHaveLength(100);
		const firstCounts = ["A", "B", "C"].map((id) => per(first, id)).sort((x, y) => x - y);
		expect(firstCounts, "two sessions get their 50 and the third is short").toEqual([0, 50, 50]);
		expect(await flushed(w)).toHaveLength(70);
		expect(await flushed(w)).toHaveLength(10);
		expect(w.pending()).toBe(0);
	});

	test("a second head is its own: after the first is delivered and pressure returns, its failures stay undefined for six hours", async () => {
		const w = await world({ script: () => network() });
		w.gate.noteCwd("s1", work);
		await w.gate.reportState(stateOf("s1"));
		await w.gate.reportEvents("s1", probe("second"));
		expect(w.pending()).toBe(2);
		w.gate.noteServerReachable();
		let delivered = 0;
		w.setScript(() => (delivered++ === 0 ? SERVER_OK : http(503, "busy", HOUR)));
		for (let i = 0; i < 6; i++) {
			await w.gate.flush();
			clock += HOUR;
		}
		expect(w.pending()).toBe(1);
		expect(stateEntry(w, "s1").kind).toBe("events");
		expect(stateEntry(w, "s1").failures).toBeUndefined();
	});

	test("[events, state] queued for a session the server has never seen: the state goes first, then the events, without a six-hour stall", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("ghost", probe("early"));
		await w.gate.reportState(stateOf("ghost"));
		expect(w.pending()).toBe(2);
		w.gate.noteServerReachable();
		let row = false;
		w.setScript((call) => {
			if (call.path.endsWith("/events")) return row ? SERVER_OK : http(500);
			row = true;
			return SERVER_OK;
		});
		const made = await flushed(w);
		expect(made.map((c) => c.path.split("/").pop())).toEqual([
			"events",
			"managed-session-state",
			"events",
		]);
		expect(made[1]?.headers?.["X-AgentPulse-Replay"]).toBeDefined();
		expect(w.pending()).toBe(0);
	});

	test("with no state queued for such a session, the six-hour path ends with the events counted and removed", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("ghost", probe("early"));
		w.gate.noteServerReachable();
		w.setScript(() => http(500, undefined, HOUR));
		for (let i = 0; i < 6; i++) {
			await w.gate.flush();
			clock += HOUR;
		}
		expect(stateEntry(w, "ghost").failures).toBeUndefined();
		for (let i = 0; i < 12 && w.pending() > 0; i++) {
			await w.gate.flush();
			clock += HOUR;
		}
		expect(w.pending()).toBe(0);
		expect(w.outbox.summary().lastFlushLost).toBeGreaterThanOrEqual(0);
	});

	test("a 401 or 403 that isn't the server's own is back-pressure: hours of it drop nothing, one call per pass", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportState(stateOf("s1"));
		await w.gate.reportState(stateOf("s2"));
		w.gate.noteServerReachable();
		w.setScript(() => http(401, "Unauthorized"));
		let calls = 0;
		for (let i = 0; i < 100; i++) {
			calls += (await flushed(w)).length;
			clock += 61_000;
		}
		expect(calls, "the whole pass is held, so one call per attempt").toBeLessThanOrEqual(100);
		expect(w.pending()).toBe(2);
		expect(stateEntry(w, "s1").failures).toBeUndefined();
		expect(w.rejected()).toBe(0);
	});

	test("but a proxy's 403 that outlasts the six-hour budget starts to count", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportState(stateOf("s1"));
		w.gate.noteServerReachable();
		w.setScript(() => http(403, "Forbidden", HOUR));
		for (let i = 0; i < 6; i++) {
			await w.gate.flush();
			clock += HOUR;
		}
		expect(stateEntry(w, "s1").failures).toBeUndefined();
		await w.gate.flush();
		expect(stateEntry(w, "s1").failures).toBe(1);
	});

	test("the missing-row snapshot is the fold of every queued state report: the creating one's agentType, cwd and model survive a newest patch that omits them", async () => {
		const w = await world({ script: () => network() });
		w.gate.noteCwd("ghost", work);
		await w.gate.reportEvents("ghost", probe("early"));
		await w.gate.reportState(
			stateOf("ghost", {
				agentType: "codex_cli",
				cwd: work,
				model: "model-x",
				desiredThreadTitle: "t1",
			}),
		);
		await w.gate.reportState({
			sessionId: "ghost",
			status: "completed",
			managedState: "completed",
		} as ManagedSessionStateInput);
		expect(w.pending()).toBe(3);
		w.gate.noteServerReachable();
		let row = false;
		w.setScript((call) => {
			if (call.path.endsWith("/events")) return row ? SERVER_OK : http(500);
			row = true;
			return SERVER_OK;
		});
		const made = await flushed(w);
		const snapshot = made.find((c) => c.path.endsWith("/managed-session-state"));
		expect(snapshot?.body).toMatchObject({
			sessionId: "ghost",
			agentType: "codex_cli",
			cwd: work,
			model: "model-x",
			status: "completed",
		});
		expect(made.filter((c) => c.path.endsWith("/managed-session-state"))).toHaveLength(1);
		expect(w.pending()).toBe(0);
	});

	test("a snapshot the server refuses keeps every queued state report", async () => {
		const w = await world({ script: () => network() });
		await w.gate.reportEvents("ghost", probe("early"));
		await w.gate.reportState(stateOf("ghost", { cwd: work }));
		await w.gate.reportState(stateOf("ghost", { status: "completed" }));
		w.gate.noteServerReachable();
		w.setScript((call) => (call.path.endsWith("/events") ? http(500) : http(500)));
		await w.gate.flush();
		expect(w.pending()).toBe(3);
	});

	test("a live send that hits a proxy's 401 is kept as back-pressure: attempted, held, never counted", async () => {
		const w = await world({ script: () => http(401, "Unauthorized") });
		expect(await w.gate.reportEvents("s1", probe("x"))).toBe("queued");
		expect(w.pending()).toBe(1);
		const head = w.outbox.head("s1") as { attempted: boolean; failures?: number };
		expect(head.attempted).toBe(true);
		expect(head.failures).toBeUndefined();
		expect(w.rejected()).toBe(0);
		// the hold: a flush right away sends nothing, one after the wait does
		w.setScript(() => SERVER_OK);
		expect(await flushed(w)).toHaveLength(0);
		clock += 5 * MINUTE;
		expect(await flushed(w)).toHaveLength(1);
		expect(w.pending()).toBe(0);
	});
});
