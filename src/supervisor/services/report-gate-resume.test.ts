/**
 * The report gate's resume methods (AGEN-115, phase 3): reportResumeState (live only, never queued, closes
 * on a later exclusion), refuseResume (one fixed body per resume kind while rules exist, never the launch
 * sentence, for a session the gate doesn't know), forgetLaunch and queuedState. Real files in a temp home,
 * a scripted `request`, an injected clock.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedSessionEventInput, ManagedSessionStateInput } from "../../shared/types.js";
import { type CredentialDeps, createReportGate } from "./report-gate.js";
import { createReportOutbox } from "./report-outbox.js";
import {
	SupervisorNetworkError,
	SupervisorRequestError,
	createCredentialTripwire,
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
		maxTrackedSessions?: number;
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
		maxTrackedSessions: over.maxTrackedSessions,
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

const resumeBody = (sessionId: string) =>
	({
		sessionId,
		managedState: "managed",
		status: "idle",
		providerSyncState: "synced",
		clearProviderSyncError: true,
		resumeActionId: "act-1",
	}) as ManagedSessionStateInput;

describe("reportResumeState", () => {
	test("sends live, marks the session reported, and carries the action id", async () => {
		const w = await world();
		const outcome = await w.gate.reportResumeState(resumeBody("s1"));
		expect(outcome).toBe("sent");
		expect(w.calls.at(-1)?.path).toContain("/managed-session-state");
		expect((w.calls.at(-1)?.body as Record<string, unknown>).resumeActionId).toBe("act-1");
		expect(w.calls.at(-1)?.headers).toBeUndefined();
	});

	test("never queues: a network failure throws and the outbox stays empty", async () => {
		const w = await world();
		w.setScript(() => new SupervisorNetworkError(new Error("down")));
		await expect(w.gate.reportResumeState(resumeBody("s1"))).rejects.toBeInstanceOf(
			SupervisorNetworkError,
		);
		expect(w.pending()).toBe(0);
	});

	test("never queues behind a backlog for other sessions either", async () => {
		const w = await world();
		w.setScript(() => new SupervisorNetworkError(new Error("down")));
		await w.gate.reportEvents("other", probe("queued"));
		expect(w.pending()).toBe(1);
		w.setScript(() => SERVER_OK);
		expect(await w.gate.reportResumeState(resumeBody("s1"))).toBe("sent");
		expect(w.outbox.hasPending("s1")).toBe(false);
	});

	test("a refusal from the server (session_not_owned) is thrown to the caller", async () => {
		const w = await world();
		w.setScript(() => new SupervisorRequestError(403, "no", "session_not_owned"));
		await expect(w.gate.reportResumeState(resumeBody("s1"))).rejects.toBeInstanceOf(
			SupervisorRequestError,
		);
	});

	test("an excluded or blocked session sends nothing and says so", async () => {
		const w = await world();
		w.gate.noteLaunch("l1", "s1", work);
		writeRules([work]);
		expect(await w.gate.reportResumeState(resumeBody("s1"))).toBe("excluded");
		writeRules(["bad line with no slash"]);
		expect(await w.gate.reportResumeState(resumeBody("s2"))).toBe("blocked");
		expect(w.calls.filter((c) => c.path.includes("/managed-session-state"))).toEqual([]);
	});

	test("it marks the session reported, so a rule added afterwards closes it with one contentless report", async () => {
		const w = await world();
		w.gate.noteLaunch("l1", "s1", work);
		await w.gate.reportResumeState(resumeBody("s1"));
		writeRules([work]);
		await w.gate.scan();
		const closing = w.calls.filter((c) => c.path.includes("/managed-session-state")).at(-1);
		expect(closing?.body).toMatchObject({
			sessionId: "s1",
			status: "completed",
			managedState: "stopped",
		});
		expect(Object.keys(closing?.body as object).sort()).toEqual([
			"managedState",
			"providerSyncState",
			"sessionId",
			"status",
		]);
	});
});

describe("refuseResume", () => {
	test("while rules exist: one body per kind, whatever the cause, and never the launch sentence", async () => {
		const w = await world();
		writeRules([join(home, "elsewhere")]);
		const bodies: string[] = [];
		w.setScript((call) => {
			if (call.path.includes("/control-actions/")) bodies.push(call.rawBody);
			return SERVER_OK;
		});
		// An id the gate has never heard of: decide() would call it excluded, and refuseControlAction would post the launch sentence.
		await w.gate.refuseResume("act-1", "host-x refused this session");
		await w.gate.refuseResume("act-2", "host-x refused this session");
		expect(bodies.length).toBe(2);
		expect(JSON.parse(bodies[0]).status).toBe("failed");
		expect(JSON.parse(bodies[0]).error).toBe("host-x refused this session");
		expect(bodies[0]).not.toContain("doesn't allow launches");
	});

	test("it posts to the action's status path and nothing else", async () => {
		const w = await world();
		await w.gate.refuseResume("act-9", "words");
		expect(w.calls.map((c) => c.path)).toEqual(["/supervisors/sup-1/control-actions/act-9/status"]);
	});

	test("while the rules are invalid nothing is posted", async () => {
		const w = await world();
		writeRules(["bad line with no slash"]);
		await w.gate.refuseResume("act-1", "words");
		expect(w.calls).toEqual([]);
	});
});

describe("forgetLaunch and queuedState", () => {
	test("forgetLaunch drops what noteLaunch remembered, so a retry isn't poisoned; an excluded session stays excluded", async () => {
		const w = await world();
		expect(w.gate.noteLaunch("l1", "s1", work)).toBe(true);
		w.gate.forgetLaunch("l1", "s1");
		// Forgotten: with rules present the session is unknown, so excluded.
		writeRules([join(home, "elsewhere")]);
		expect(w.gate.verdict("s1")).toBe("excluded");
		// Re-noting works (the id is not held).
		expect(w.gate.noteLaunch("l1", "s1", work)).toBe(true);
		expect(w.gate.verdict("s1", work)).toBe("send");
	});

	test("a session a rule excluded is never un-marked by forgetLaunch", async () => {
		const w = await world();
		w.gate.noteLaunch("l1", "s1", work);
		writeRules([work]);
		expect(w.gate.verdict("s1", work)).toBe("excluded");
		w.gate.forgetLaunch("l1", "s1");
		removeRules();
		expect(w.gate.verdict("s1", work)).toBe("excluded");
	});

	test("queuedState: none, pending (also before the outbox listed), and held", async () => {
		const w = buildWorld();
		// Not yet listed: pending, the case hasPending alone misses.
		expect(w.gate.queuedState("s1")).toBe("pending");
		await w.outbox.ready();
		expect(w.gate.queuedState("s1")).toBe("none");
		w.setScript(() => new SupervisorNetworkError(new Error("down")));
		await w.gate.reportEvents("s1", probe("x"));
		expect(w.gate.queuedState("s1")).toBe("pending");
		expect(w.gate.queuedState("s2")).toBe("none");
	});
});
