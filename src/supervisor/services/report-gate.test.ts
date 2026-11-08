/**
 * The supervisor's one gate for reports about a session. Every request that
 * carries session data goes through it: it keeps session and launch ids against
 * the directories the supervisor handled them for, evaluates those against the
 * user's exclude rules as they are now, and decides between sending, sending the
 * one content-free closing report, and dropping.
 *
 * Nothing here talks to a server: the gate's only way out is the injected
 * `request`, which these tests replace with a recorder. Every case gets its own
 * throwaway home.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPERVISOR_EXCLUDE_STATE_STAMP_RELATIVE_PATH } from "../../shared/hook-headers.js";
import { createRulesWatch } from "./exclude-rules-watch.js";
import {
	LAUNCH_REFUSED_CODE,
	LAUNCH_REFUSED_MESSAGE,
	type ReportGate,
	createReportGate,
	isTrustedDirectoryStat,
	isTrustedStateFileStat,
} from "./report-gate.js";
import { createReportOutbox } from "./report-outbox.js";
import { SupervisorNetworkError, SupervisorRequestError } from "./report-resilience.js";

const SUPERVISOR_ID = "sup-1";
const BASE = `/supervisors/${SUPERVISOR_ID}`;

let home: string;
let work: string;
let elsewhere: string;
let clock: number;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-report-gate-")));
	work = join(home, "work", "secret-project");
	elsewhere = join(home, "work", "open-project");
	for (const dir of [work, elsewhere]) mkdirSync(dir, { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
	clock = Date.parse("2026-01-01T00:00:00Z");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

let rulesVersion = 0;
function writeRules(lines: string[]) {
	const file = join(home, ".agentpulse", "exclude");
	writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	// a distinct mtime every time, so two writes of the same size are still two different files
	const at = new Date(Date.parse("2026-02-01T00:00:00Z") + ++rulesVersion * 1000);
	utimesSync(file, at, at);
}
const removeRules = () => rmSync(join(home, ".agentpulse", "exclude"), { force: true });

type Call = { path: string; method: string; body: unknown };

function recorder(fail?: (call: Call) => Error | null) {
	const calls: Call[] = [];
	/** The headers each request in `calls` carried (parallel to it); undefined when it carried none. */
	const headers: Array<Record<string, string> | undefined> = [];
	const request = async (path: string, options?: RequestInit) => {
		const call: Call = {
			path,
			method: options?.method ?? "GET",
			body: options?.body ? JSON.parse(String(options.body)) : undefined,
		};
		const error = fail?.(call);
		if (error) throw error;
		calls.push(call);
		headers.push(options?.headers as Record<string, string> | undefined);
		return { session: { displayName: "from-server" }, managedSession: {}, events: [] };
	};
	return { calls, headers, request };
}

function makeGate(
	opts: {
		fail?: (call: Call) => Error | null;
		version?: string;
		/** Reuse a recorder so a second gate (a restarted supervisor) reports into the same list. */
		shared?: ReturnType<typeof recorder>;
		maxTrackedSessions?: number;
		isBridgeActive?: (sessionId: string) => boolean;
		logs?: string[];
	} = {},
) {
	const { calls, headers, request } = opts.shared ?? recorder(opts.fail);
	const gate = createReportGate({
		request,
		supervisorId: SUPERVISOR_ID,
		home,
		version: opts.version ?? "9.9.9",
		now: () => clock,
		log: (line) => opts.logs?.push(line),
		maxTrackedSessions: opts.maxTrackedSessions,
		isBridgeActive: opts.isBridgeActive,
	});
	return { gate, calls, headers };
}

const stateBody = (sessionId: string, cwd: string, extra: Record<string, unknown> = {}) => ({
	sessionId,
	agentType: "claude_code" as const,
	cwd,
	model: "model-xyz",
	status: "active" as const,
	managedState: "headless" as const,
	desiredThreadTitle: "a very private title",
	metadata: { note: "private metadata" },
	...extra,
});

const eventsFor = (text = "private prompt text") => [
	{ eventType: "UserPromptSubmit", category: "prompt" as const, content: text },
];

const FINAL = (sessionId: string) => ({
	sessionId,
	status: "completed",
	managedState: "stopped",
	providerSyncState: "synced",
});

const paths = (calls: Call[]) => calls.map((c) => `${c.method} ${c.path}`);

/** Starts a session in `cwd` the way a launch does: both ids noted, the first state report sent. */
async function startSession(gate: ReportGate, sessionId: string, cwd: string) {
	gate.noteCwd(sessionId, cwd);
	await gate.reportState(stateBody(sessionId, cwd));
}

describe("with no rules at all the gate is invisible", () => {
	test("every kind of report goes out unchanged, to the same paths", async () => {
		const { gate, calls } = makeGate();
		gate.noteCwd("launch-1", work);
		gate.noteCwd("sess-1", work);
		await gate.reportLaunchStatus("launch-1", { status: "launching" });
		await gate.reportState(stateBody("sess-1", work));
		await gate.reportEvents("sess-1", eventsFor());
		await gate.reportControlStatus("act-1", "sess-1", { status: "succeeded" });
		expect(paths(calls)).toEqual([
			`POST ${BASE}/launches/launch-1/status`,
			`POST ${BASE}/managed-session-state`,
			`POST ${BASE}/managed-sessions/sess-1/events`,
			`POST ${BASE}/control-actions/act-1/status`,
		]);
		expect(calls[1]?.body).toEqual(stateBody("sess-1", work));
		// events carry the time the gate sent them (its clock), and nothing else is added
		expect(calls[2]?.body).toEqual({
			events: eventsFor().map((e) => ({ ...e, occurredAt: new Date(clock).toISOString() })),
		});
		expect(calls[3]?.body).toEqual({ status: "succeeded" });
	});

	test("an id whose directory was never noted is still reported while there are no rules", async () => {
		const { gate, calls } = makeGate();
		await gate.reportState({ sessionId: "stranger", status: "active" });
		expect(calls).toHaveLength(1);
	});
});

describe("a rule added after launch stops the reports, and one contentless closing report is sent", () => {
	test("a session in a clean directory; a rule covering it is added; the next state and events reports send nothing but ONE final state report with no cwd, title, model or event text", async () => {
		const { gate, calls } = makeGate();
		await startSession(gate, "sess-1", work);
		await gate.reportEvents("sess-1", eventsFor());
		expect(calls).toHaveLength(2);
		const before = calls.length;

		writeRules([join(home, "work")]);
		await gate.reportState(
			stateBody("sess-1", work, { desiredThreadTitle: "second private title" }),
		);
		await gate.reportEvents("sess-1", eventsFor("second private prompt"));
		await gate.reportState(stateBody("sess-1", work));

		const after = calls.slice(before);
		expect(after).toHaveLength(1);
		expect(after[0]).toEqual({
			path: `${BASE}/managed-session-state`,
			method: "POST",
			body: FINAL("sess-1"),
		});
		const serialised = JSON.stringify(after);
		for (const secret of [work, "private", "model-xyz", "metadata", "prompt text"]) {
			expect(serialised, secret).not.toContain(secret);
		}
	});

	test("the final report is the same terminal state a stop reports: completed / stopped / synced, and nothing else", async () => {
		const { gate, calls } = makeGate();
		await startSession(gate, "sess-1", work);
		writeRules([work]);
		await gate.reportEvents("sess-1", eventsFor());
		expect(calls.at(-1)?.body).toEqual({
			sessionId: "sess-1",
			status: "completed",
			managedState: "stopped",
			providerSyncState: "synced",
		});
		expect(Object.keys(calls.at(-1)?.body as object).sort()).toEqual([
			"managedState",
			"providerSyncState",
			"sessionId",
			"status",
		]);
	});

	test("after the final report nothing more goes out for the session: reports of every kind and later scans", async () => {
		const { gate, calls } = makeGate();
		await startSession(gate, "sess-1", work);
		writeRules([work]);
		await gate.reportState(stateBody("sess-1", work));
		const sent = calls.length;
		await gate.reportState(stateBody("sess-1", work));
		await gate.reportEvents("sess-1", eventsFor());
		await gate.reportControlStatus("act-9", "sess-1", { status: "running" });
		await gate.scan();
		await gate.scan();
		expect(calls.slice(sent).filter((c) => c.path.includes("managed-session"))).toEqual([]);
	});

	test("an idle session is closed by the periodic scan alone, once", async () => {
		const { gate, calls } = makeGate();
		await startSession(gate, "idle-1", work);
		const before = calls.length;
		writeRules([work]);
		await gate.scan();
		await gate.scan();
		expect(calls.slice(before)).toEqual([
			{ path: `${BASE}/managed-session-state`, method: "POST", body: FINAL("idle-1") },
		]);
		await gate.reportState(stateBody("idle-1", work));
		expect(calls).toHaveLength(before + 1);
	});

	test("reports arriving together send exactly one final", async () => {
		const { gate, calls } = makeGate();
		await startSession(gate, "busy-1", work);
		const before = calls.length;
		writeRules([work]);
		await Promise.all([
			gate.reportState(stateBody("busy-1", work)),
			gate.reportState(stateBody("busy-1", work)),
			gate.reportEvents("busy-1", eventsFor()),
			gate.reportEvents("busy-1", eventsFor()),
			gate.scan(),
		]);
		expect(calls.slice(before)).toHaveLength(1);
	});

	test("a final report that fails is tried again on the next scan, and once it has gone out it is not sent again", async () => {
		let failing = true;
		const { gate, calls } = makeGate({
			fail: (call) =>
				failing && (call.body as { managedState?: string }).managedState === "stopped"
					? new Error("network down")
					: null,
		});
		await startSession(gate, "flaky-1", work);
		const before = calls.length;
		writeRules([work]);
		await gate.reportState(stateBody("flaky-1", work)); // does not throw into the provider
		expect(calls.length).toBe(before);
		failing = false;
		await gate.scan();
		expect(calls.slice(before)).toHaveLength(1);
		await gate.scan();
		expect(calls.slice(before)).toHaveLength(1);
	});

	test("a session in another directory keeps reporting normally in the same run", async () => {
		const { gate, calls } = makeGate();
		await startSession(gate, "secret-1", work);
		await startSession(gate, "open-1", elsewhere);
		writeRules([work]);
		const before = calls.length;
		await gate.reportState(stateBody("open-1", elsewhere));
		await gate.reportEvents("open-1", eventsFor());
		await gate.reportState(stateBody("secret-1", work));
		const after = calls.slice(before);
		expect(paths(after)).toEqual([
			`POST ${BASE}/managed-session-state`,
			`POST ${BASE}/managed-sessions/open-1/events`,
			`POST ${BASE}/managed-session-state`,
		]);
		expect((after[0]?.body as { sessionId: string }).sessionId).toBe("open-1");
		expect(after[2]?.body).toEqual(FINAL("secret-1"));
	});

	test("once excluded, a later note of a clean directory does not bring the session back", async () => {
		const { gate, calls } = makeGate();
		await startSession(gate, "sticky-1", work);
		writeRules([work]);
		await gate.scan();
		const sent = calls.length;
		gate.noteCwd("sticky-1", elsewhere);
		await gate.reportState(stateBody("sticky-1", elsewhere));
		expect(calls).toHaveLength(sent);
	});

	test("removing the rule later does not resume a session already closed", async () => {
		const { gate, calls } = makeGate();
		await startSession(gate, "closed-1", work);
		writeRules([work]);
		await gate.scan();
		const sent = calls.length;
		removeRules();
		await gate.reportState(stateBody("closed-1", work));
		expect(calls).toHaveLength(sent);
	});
});

describe("a session that was never reported has no row, and an unknown directory counts as excluded while rules exist", () => {
	test("excluded from the start: nothing is ever sent, not even a final report", async () => {
		const { gate, calls } = makeGate();
		writeRules([work]);
		gate.noteCwd("never-1", work);
		await gate.reportState(stateBody("never-1", work));
		await gate.reportEvents("never-1", eventsFor());
		await gate.scan();
		expect(calls).toEqual([]);
	});

	test("a session whose directory the supervisor never saw: dropped while rules exist, no final report", async () => {
		const { gate, calls } = makeGate();
		writeRules([work]);
		await gate.reportState({ sessionId: "mystery-1", status: "active" });
		await gate.reportEvents("mystery-1", eventsFor());
		await gate.scan();
		expect(calls).toEqual([]);
	});

	test("the same unknown directory is reported again once the rules are gone", async () => {
		const { gate, calls } = makeGate();
		writeRules([work]);
		await gate.reportState({ sessionId: "mystery-1", status: "active" });
		removeRules();
		await gate.reportState({ sessionId: "mystery-1", status: "active" });
		expect(calls).toHaveLength(1);
	});

	test("the state report hands back something providers can read when it was dropped", async () => {
		const { gate } = makeGate();
		writeRules([work]);
		gate.noteCwd("quiet-1", work);
		const result = await gate.reportState(stateBody("quiet-1", work));
		expect(typeof result.session.displayName).toBe("string");
	});
});

describe("the supervisor's own knowledge of a session's directory wins", () => {
	test("a directory a report body carries does not teach the gate anything: an unknown session stays unknown", async () => {
		const { gate, calls } = makeGate();
		writeRules([work]);
		await gate.reportState(stateBody("stranger-1", elsewhere));
		expect(calls).toEqual([]);
		expect(gate.verdict("stranger-1")).toBe("excluded");
	});

	test("a directory a report body carries never replaces the one the supervisor launched the session in", async () => {
		const { gate, calls } = makeGate();
		gate.noteCwd("sess-1", work);
		writeRules([work]);
		await gate.reportState(stateBody("sess-1", elsewhere));
		await gate.reportEvents("sess-1", eventsFor());
		expect(calls).toEqual([]);
		expect(gate.verdict("sess-1")).toBe("excluded");
	});

	test("the first directory noted for an id stays: a second note for the same id changes nothing", () => {
		const { gate } = makeGate();
		gate.noteCwd("sess-1", work);
		gate.noteCwd("sess-1", elsewhere);
		writeRules([work]);
		expect(gate.verdict("sess-1")).toBe("excluded");
	});

	test("a session known in a covered directory is excluded whatever directory an action names, with no scan in between, and stays excluded", () => {
		const { gate } = makeGate();
		gate.noteCwd("sess-1", work);
		writeRules([work]);
		expect(gate.verdict("sess-1", elsewhere)).toBe("excluded");
		removeRules();
		expect(gate.verdict("sess-1")).toBe("excluded");
	});

	test("a clean known session is excluded when the directory the action names is covered", () => {
		const { gate } = makeGate();
		gate.noteCwd("sess-1", elsewhere);
		writeRules([work]);
		expect(gate.verdict("sess-1", work)).toBe("excluded");
	});

	test("a known session and an action naming a different clean directory: refused, and the session is not excluded by it", () => {
		const { gate } = makeGate();
		gate.noteCwd("sess-1", elsewhere);
		writeRules([work]);
		expect(gate.verdict("sess-1", join(home, "work"))).toBe("refused");
		expect(gate.verdict("sess-1", elsewhere)).toBe("send");
		expect(gate.verdict("sess-1")).toBe("send");
	});

	test("the same directory spelled differently (trailing slash, a symlink to it) is the same directory", async () => {
		const link = join(home, "work", "link-to-open");
		symlinkSync(elsewhere, link);
		const { gate } = makeGate();
		gate.noteCwd("sess-1", elsewhere);
		writeRules([work]);
		expect(gate.verdict("sess-1", `${elsewhere}/`)).toBe("send");
		expect(gate.verdict("sess-1", link)).toBe("send");
	});

	test("an unknown session while rules exist is excluded whatever directory the action names; with no rules it is as before", () => {
		const { gate } = makeGate();
		expect(gate.verdict("stranger-1", elsewhere)).toBe("send");
		writeRules([work]);
		expect(gate.verdict("stranger-1", elsewhere)).toBe("excluded");
		expect(gate.verdict("stranger-1", work)).toBe("excluded");
	});

	test("with no rules at all a known session and an action naming another directory is not refused", () => {
		const { gate } = makeGate();
		gate.noteCwd("sess-1", elsewhere);
		expect(gate.verdict("sess-1", work)).toBe("send");
	});

	test("a directory with no session: judged by the directory alone", () => {
		const { gate } = makeGate();
		expect(gate.verdictForDirectory(work)).toBe("send");
		writeRules([work]);
		expect(gate.verdictForDirectory(work)).toBe("excluded");
		expect(gate.verdictForDirectory(elsewhere)).toBe("send");
		expect(gate.verdictForDirectory(undefined)).toBe("excluded");
		writeRules(["relative"]);
		expect(gate.verdictForDirectory(elsewhere)).toBe("blocked");
	});
});

describe("a session counts as reported only after its report was delivered", () => {
	test("the first state report fails, the directory is then excluded: no closing report, because the server never held the session", async () => {
		let failing = true;
		const { gate, calls } = makeGate({ fail: () => (failing ? new Error("network down") : null) });
		gate.noteCwd("sess-1", work);
		await expect(gate.reportState(stateBody("sess-1", work))).rejects.toThrow("network down");
		failing = false;
		writeRules([work]);
		await gate.reportState(stateBody("sess-1", work));
		await gate.reportEvents("sess-1", eventsFor());
		await gate.scan();
		expect(calls).toEqual([]);
	});

	test("the first events report fails, the directory is then excluded: no closing report either", async () => {
		let failing = true;
		const { gate, calls } = makeGate({ fail: () => (failing ? new Error("network down") : null) });
		gate.noteCwd("sess-1", work);
		await expect(gate.reportEvents("sess-1", eventsFor())).rejects.toThrow("network down");
		failing = false;
		writeRules([work]);
		await gate.scan();
		expect(calls).toEqual([]);
	});

	test("one delivered report is enough: the session is then closed once when excluded", async () => {
		let failing = true;
		const { gate, calls } = makeGate({
			fail: (call) => (failing && call.path.endsWith("/events") ? new Error("down") : null),
		});
		await startSession(gate, "sess-1", work);
		await expect(gate.reportEvents("sess-1", eventsFor())).rejects.toThrow("down");
		failing = false;
		const before = calls.length;
		writeRules([work]);
		await gate.scan();
		expect(calls.slice(before)).toEqual([
			{ path: `${BASE}/managed-session-state`, method: "POST", body: FINAL("sess-1") },
		]);
	});
});

describe("the gate's memory survives a restart", () => {
	const gateFile = () => join(home, ".agentpulse", "supervisor-gate-state.json");

	test("a session closed before the restart is still excluded afterwards, even with the rules gone, and is not closed a second time", async () => {
		const shared = recorder();
		const first = makeGate({ shared }).gate;
		await startSession(first, "sess-1", work);
		writeRules([work]);
		await first.scan();
		const closings = () =>
			shared.calls.filter((c) => (c.body as { managedState?: string }).managedState === "stopped");
		expect(closings()).toHaveLength(1);

		removeRules();
		const second = makeGate({ shared }).gate;
		expect(second.verdict("sess-1")).toBe("excluded");
		await second.reportState(stateBody("sess-1", work));
		await second.reportEvents("sess-1", eventsFor());
		await second.scan();
		expect(closings()).toHaveLength(1);
	});

	test("a session that was excluded but never reported stays excluded after a restart, even with the rules gone", () => {
		const first = makeGate().gate;
		first.noteCwd("sess-1", work);
		writeRules([work]);
		expect(first.verdict("sess-1")).toBe("excluded");
		removeRules();
		expect(makeGate().gate.verdict("sess-1")).toBe("excluded");
		expect(makeGate().gate.verdict("sess-other")).toBe("send");
	});

	test("a session reported but not yet closed when the supervisor stopped gets exactly one closing report after the restart", async () => {
		const shared = recorder();
		const first = makeGate({ shared }).gate;
		await startSession(first, "sess-1", work);
		const before = shared.calls.length;
		writeRules([work]);
		await first.scan();

		const second = makeGate({ shared }).gate;
		await second.scan();
		await second.scan();
		const third = makeGate({ shared }).gate;
		await third.scan();
		expect(shared.calls.slice(before)).toEqual([
			{ path: `${BASE}/managed-session-state`, method: "POST", body: FINAL("sess-1") },
		]);
	});

	test("a directory known before the restart is still known: a clean session keeps reporting, a covered one stays quiet", async () => {
		const shared = recorder();
		const first = makeGate({ shared }).gate;
		first.noteCwd("clean-1", elsewhere);
		first.noteCwd("covered-1", work);
		writeRules([work]);
		await first.scan();

		const second = makeGate({ shared }).gate;
		expect(second.verdict("clean-1")).toBe("send");
		expect(second.verdict("clean-1", elsewhere)).toBe("send");
		expect(second.verdict("clean-1", work)).toBe("excluded");
		expect(second.verdict("covered-1")).toBe("excluded");
	});

	test("the file is private, written atomically, holds paths only as the supervisor learned them, and leaves no temporary file", async () => {
		const { gate } = makeGate();
		writeRules([join(home, "unrelated")]);
		await startSession(gate, "sess-1", work);
		expect(statSync(gateFile()).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(home, ".agentpulse")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
		const saved = JSON.parse(readFileSync(gateFile(), "utf-8"));
		expect(JSON.stringify(saved)).toContain("sess-1");
	});

	test("nothing is written when the private directory does not exist, and the gate still works", async () => {
		rmSync(join(home, ".agentpulse"), { recursive: true });
		const { gate, calls } = makeGate();
		await startSession(gate, "sess-1", work);
		expect(calls).toHaveLength(1);
		expect(existsSync(join(home, ".agentpulse"))).toBe(false);
	});

	test("a private regular state file is believed; one that is a symlink, is group-readable, or is damaged is not: the gate blocks everything, rules or no rules", async () => {
		const planted = JSON.stringify({
			version: 1,
			sessions: { "sess-1": { cwd: elsewhere, reported: true } },
		});
		const real = join(home, "planted.json");
		const plants: [string, () => void][] = [];
		plants.push(["private file", () => writeFileSync(gateFile(), planted, { mode: 0o600 })]);
		for (const plant of [
			() => {
				writeFileSync(real, planted, { mode: 0o600 });
				symlinkSync(real, gateFile());
			},
			() => {
				writeFileSync(gateFile(), planted, { mode: 0o644 });
				chmodSync(gateFile(), 0o644);
			},
			() => {
				writeFileSync(real, planted, { mode: 0o600 });
				linkSync(real, gateFile());
			},
			() => writeFileSync(gateFile(), "{not json", { mode: 0o600 }),
			() =>
				writeFileSync(gateFile(), JSON.stringify({ version: 99, sessions: {} }), { mode: 0o600 }),
		]) {
			plants.push(["ignored", plant]);
		}
		writeRules([work]);
		for (const [expectation, plant] of plants) {
			rmSync(gateFile(), { force: true });
			plant();
			const { gate } = makeGate();
			expect(gate.verdict("sess-1"), expectation).toBe(
				expectation === "private file" ? "send" : "blocked",
			);
		}
	});

	test("a directory other accounts can write into is not trusted: nothing is saved there and nothing in it is read", async () => {
		if (process.platform === "win32") return;
		const first = makeGate().gate;
		first.noteCwd("sess-1", work);
		writeRules([work]);
		expect(first.verdict("sess-1")).toBe("excluded");
		removeRules();
		expect(existsSync(gateFile())).toBe(true);
		expect(makeGate().gate.verdict("sess-1")).toBe("excluded");

		chmodSync(join(home, ".agentpulse"), 0o770);
		expect(makeGate().gate.verdict("sess-1")).toBe("blocked");
		rmSync(gateFile());
		first.noteCwd("sess-2", elsewhere);
		expect(existsSync(gateFile())).toBe(false);
	});

	test("the file holds no more entries than the gate remembers", async () => {
		const { gate } = makeGate({ maxTrackedSessions: 3 });
		writeRules([work]);
		for (let i = 0; i < 6; i++) gate.noteCwd(`id-${i}`, elsewhere);
		const saved = JSON.parse(readFileSync(gateFile(), "utf-8")) as { sessions: object };
		expect(Object.keys(saved.sessions).length).toBeLessThanOrEqual(3);
	});
});

describe("a bounded memory never turns a live session into a closing report", () => {
	for (const rules of [false, true]) {
		test(`an interactive launch with a live bridge is not the one forgotten to make room (${rules ? "rules in place" : "no rules"})`, () => {
			const active = new Set(["bridge"]);
			const { gate } = makeGate({ maxTrackedSessions: 4, isBridgeActive: (id) => active.has(id) });
			if (rules) writeRules([work]);
			gate.noteLaunch("launch-1", "bridge", elsewhere, { interactive: true });
			gate.noteCwd("plain-1", elsewhere);
			gate.noteCwd("plain-2", elsewhere);
			gate.noteCwd("plain-3", elsewhere);
			gate.noteCwd("plain-4", elsewhere);
			expect(
				gate.isInteractiveLaunch("bridge"),
				"the oldest record is kept: its bridge is alive",
			).toBe(true);
			// once the bridge is gone it is an ordinary record again
			active.clear();
			gate.noteCwd("plain-5", elsewhere);
			gate.noteCwd("plain-6", elsewhere);
			gate.noteCwd("plain-7", elsewhere);
			gate.noteCwd("plain-8", elsewhere);
			gate.noteCwd("plain-9", elsewhere);
			expect(gate.isInteractiveLaunch("bridge")).toBe(false);
		});
	}

	test("sessions that were reported and not closed are never forgotten: a new one is refused instead", async () => {
		const { gate, calls } = makeGate({ maxTrackedSessions: 3 });
		await startSession(gate, "live-1", elsewhere);
		await startSession(gate, "live-2", elsewhere);
		await startSession(gate, "live-3", elsewhere);
		writeRules([work]);
		expect(gate.noteCwd("live-4", elsewhere)).toBe(false);
		const before = calls.length;
		for (const id of ["live-1", "live-2", "live-3"]) {
			expect(gate.verdict(id)).toBe("send");
			await gate.reportEvents(id, eventsFor());
		}
		await gate.scan();
		expect(calls.slice(before).map((c) => c.path)).toEqual([
			`${BASE}/managed-sessions/live-1/events`,
			`${BASE}/managed-sessions/live-2/events`,
			`${BASE}/managed-sessions/live-3/events`,
		]);
	});

	test("what is forgotten first is what was never reported or is already closed", async () => {
		const { gate } = makeGate({ maxTrackedSessions: 3 });
		await startSession(gate, "live-1", elsewhere);
		gate.noteCwd("idle-1", elsewhere);
		gate.noteCwd("idle-2", elsewhere);
		writeRules([work]);
		expect(gate.noteCwd("new-1", elsewhere)).toBe(true);
		expect(gate.verdict("live-1")).toBe("send");
		expect(gate.verdict("new-1")).toBe("send");
		expect(gate.verdict("idle-1")).toBe("excluded");
	});
});

describe("a host with no rules file pays nothing for the gate, and finished sessions are let go", () => {
	const gateFile = () => join(home, ".agentpulse", "supervisor-gate-state.json");
	const finish = (gate: ReportGate, id: string, extra: Record<string, unknown> = {}) =>
		gate.reportState({
			sessionId: id,
			status: "completed",
			managedState: "completed",
			...extra,
		});
	/** A session that starts, reports active, and ends normally. */
	async function runToEnd(gate: ReportGate, id: string, cwd: string) {
		expect(gate.noteCwd(id, cwd)).toBe(true);
		await gate.reportState(stateBody(id, cwd));
		await finish(gate, id);
	}

	test("no state file is created or written while there are no rules, however many sessions start and end", async () => {
		const { gate } = makeGate();
		for (let i = 0; i < 25; i++) await runToEnd(gate, `s-${i}`, elsewhere);
		await gate.scan();
		expect(existsSync(gateFile())).toBe(false);
		expect(readdirSync(join(home, ".agentpulse")).filter((n) => n.includes("gate"))).toEqual([]);
	});

	test("5,001 sessions that each start, report active and end: the last one still starts, with no rules, at the real bound", async () => {
		const { gate, calls } = makeGate();
		for (let i = 0; i <= 5_000; i++) await runToEnd(gate, `s-${i}`, elsewhere);
		expect(gate.noteCwd("s-last", elsewhere)).toBe(true);
		expect(calls.length).toBe(5_001 * 2);
		expect(existsSync(gateFile())).toBe(false);
	});

	test("the same with rules in place (a small bound): the last of the finished sessions still starts and reports", async () => {
		const { gate, calls } = makeGate({ maxTrackedSessions: 10 });
		writeRules([work]);
		for (let i = 0; i <= 10; i++) await runToEnd(gate, `s-${i}`, elsewhere);
		const before = calls.length;
		expect(gate.noteCwd("s-last", elsewhere)).toBe(true);
		await gate.reportState(stateBody("s-last", elsewhere));
		expect(calls.length).toBe(before + 1);
		const saved = JSON.parse(readFileSync(gateFile(), "utf-8")) as { sessions: object };
		expect(Object.keys(saved.sessions).length).toBeLessThanOrEqual(10);
	});

	test("a full gate with no rules never refuses a launch, even when every session is live: the oldest is forgotten", async () => {
		const { gate } = makeGate({ maxTrackedSessions: 3 });
		await startSession(gate, "live-1", elsewhere);
		await startSession(gate, "live-2", elsewhere);
		await startSession(gate, "live-3", elsewhere);
		expect(gate.noteCwd("live-4", elsewhere)).toBe(true);
		expect(gate.noteCwd("live-5", elsewhere)).toBe(true);
		writeRules([work]);
		// with rules, what the gate no longer holds is unknown, and so quiet. live-1 was the oldest of
		// three live sessions; live-4 was idle, so the next launch took its slot first.
		expect(gate.verdict("live-1")).toBe("excluded");
		expect(gate.verdict("live-4")).toBe("excluded");
		expect(gate.verdict("live-2")).toBe("send");
		expect(gate.verdict("live-3")).toBe("send");
		expect(gate.verdict("live-5")).toBe("send");
	});

	test("when rules first appear, what the gate holds is saved then, and a restart knows it", async () => {
		const { gate } = makeGate();
		await startSession(gate, "live-1", elsewhere);
		await runToEnd(gate, "done-1", elsewhere);
		expect(existsSync(gateFile())).toBe(false);
		writeRules([work]);
		await gate.scan();
		expect(existsSync(gateFile())).toBe(true);
		const saved = JSON.parse(readFileSync(gateFile(), "utf-8")) as { sessions: object };
		expect(Object.keys(saved.sessions).sort()).toEqual(["done-1", "live-1"]);
		expect(makeGate().gate.verdict("live-1")).toBe("send");
	});

	test("with the rules gone again nothing is written, and the next scan after they return saves the memory as it is by then", async () => {
		const { gate } = makeGate();
		await startSession(gate, "live-1", elsewhere);
		writeRules([work]);
		await gate.scan();
		const before = readFileSync(gateFile(), "utf-8");
		removeRules();
		await startSession(gate, "live-2", elsewhere);
		expect(readFileSync(gateFile(), "utf-8"), "nothing was written while there were no rules").toBe(
			before,
		);
		writeRules([work]);
		await gate.scan();
		const saved = JSON.parse(readFileSync(gateFile(), "utf-8")) as { sessions: object };
		expect(Object.keys(saved.sessions).sort()).toEqual(["live-1", "live-2"]);
	});

	test("a scan with rules in place saves only what has not been saved: an unchanged memory is not rewritten", async () => {
		const { gate } = makeGate();
		await startSession(gate, "live-1", elsewhere);
		writeRules([work]);
		await gate.scan();
		const first = statSync(gateFile()).ino;
		await gate.scan();
		await gate.scan();
		expect(statSync(gateFile()).ino, "the file was replaced again").toBe(first);
	});

	test("once a session has been excluded, what the gate saves stays current when the rules go away: the exclusion lives on in the file", async () => {
		const { gate } = makeGate();
		gate.noteCwd("covered", work);
		writeRules([work]);
		expect(gate.verdict("covered")).toBe("excluded");
		removeRules();
		await startSession(gate, "live-1", elsewhere);
		const saved = JSON.parse(readFileSync(gateFile(), "utf-8")) as {
			sessions: Record<string, unknown>;
		};
		expect(Object.keys(saved.sessions).sort()).toEqual(["covered", "live-1"]);
	});

	test("a state file left over from an earlier run is not touched on a host with no rules and nothing excluded in it", async () => {
		const planted = JSON.stringify({
			version: 1,
			sessions: { old: { cwd: elsewhere, reported: true, done: true } },
		});
		writeFileSync(gateFile(), planted, { mode: 0o600 });
		const { gate } = makeGate();
		await startSession(gate, "live-1", elsewhere);
		await runToEnd(gate, "done-1", elsewhere);
		await gate.scan();
		expect(readFileSync(gateFile(), "utf-8")).toBe(planted);
		expect(readdirSync(join(home, ".agentpulse")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	test("a leftover file that holds an excluded session keeps being kept current: that exclusion must survive a restart", async () => {
		writeFileSync(
			gateFile(),
			JSON.stringify({ version: 1, sessions: { covered: { excluded: true } } }),
			{ mode: 0o600 },
		);
		const { gate } = makeGate();
		await startSession(gate, "live-1", elsewhere);
		const saved = JSON.parse(readFileSync(gateFile(), "utf-8")) as {
			sessions: Record<string, unknown>;
		};
		expect(Object.keys(saved.sessions).sort()).toEqual(["covered", "live-1"]);
		expect(makeGate().gate.verdict("covered")).toBe("excluded");
	});

	describe("with rules, a session is released when a terminal report for it is delivered", () => {
		const terminals: [string, Record<string, unknown>][] = [
			["status completed", { status: "completed", managedState: undefined }],
			["status failed", { status: "failed", managedState: undefined }],
			["managed state stopped", { status: undefined, managedState: "stopped" }],
			["managed state failed", { status: undefined, managedState: "failed" }],
			["managed state completed", { status: undefined, managedState: "completed" }],
		];
		for (const [label, terminal] of terminals) {
			test(`${label}: its slot is free again`, async () => {
				const { gate } = makeGate({ maxTrackedSessions: 2 });
				writeRules([work]);
				await startSession(gate, "a", elsewhere);
				await startSession(gate, "b", elsewhere);
				expect(gate.noteCwd("c", elsewhere)).toBe(false);
				await gate.reportState({ sessionId: "a", ...terminal });
				expect(gate.noteCwd("c", elsewhere)).toBe(true);
			});
		}

		test("a terminal report that was not delivered releases nothing", async () => {
			let failing = false;
			const { gate } = makeGate({
				maxTrackedSessions: 2,
				fail: (call) =>
					failing && (call.body as { status?: string }).status === "completed"
						? new Error("network down")
						: null,
			});
			writeRules([work]);
			await startSession(gate, "a", elsewhere);
			await startSession(gate, "b", elsewhere);
			failing = true;
			await expect(finish(gate, "a")).rejects.toThrow("network down");
			expect(gate.noteCwd("c", elsewhere)).toBe(false);
		});

		test("a later report that is not terminal (a prompt to a finished session) makes it live again", async () => {
			const { gate } = makeGate({ maxTrackedSessions: 2 });
			writeRules([work]);
			await startSession(gate, "a", elsewhere);
			await finish(gate, "a");
			await gate.reportState(stateBody("a", elsewhere));
			await startSession(gate, "b", elsewhere);
			expect(gate.noteCwd("c", elsewhere)).toBe(false);
		});

		test("reports that follow the terminal one (a stop reports its event afterwards) still go out, and the directory is still known", async () => {
			const { gate, calls } = makeGate();
			writeRules([work]);
			await startSession(gate, "a", elsewhere);
			await finish(gate, "a");
			const before = calls.length;
			await gate.reportEvents("a", eventsFor("stopped"));
			expect(calls.length).toBe(before + 1);
			expect(gate.verdict("a", elsewhere)).toBe("send");
		});

		test("a finished session is not closed when a rule covers it later: the server already has it as finished", async () => {
			const { gate, calls } = makeGate();
			await startSession(gate, "a", elsewhere);
			await finish(gate, "a");
			const before = calls.length;
			writeRules([elsewhere]);
			await gate.scan();
			expect(calls.length).toBe(before);
		});

		test("capacity is refused only when the bound's worth of sessions are genuinely live", async () => {
			const { gate } = makeGate({ maxTrackedSessions: 3 });
			writeRules([work]);
			await startSession(gate, "live-1", elsewhere);
			await runToEnd(gate, "done-1", elsewhere);
			await startSession(gate, "live-2", elsewhere);
			expect(gate.noteCwd("new-1", elsewhere)).toBe(true);
			expect(gate.verdict("live-1")).toBe("send");
			expect(gate.verdict("live-2")).toBe("send");
			await startSession(gate, "new-1", elsewhere);
			expect(gate.noteCwd("new-2", elsewhere)).toBe(false);
		});
	});

	describe("what is forgotten first when full", () => {
		test("a session that is not excluded goes before an excluded one, even when the excluded one is older", async () => {
			const { gate } = makeGate({ maxTrackedSessions: 2 });
			gate.noteCwd("covered", work);
			gate.noteCwd("open", elsewhere);
			writeRules([work]);
			expect(gate.verdict("covered")).toBe("excluded");
			expect(gate.noteCwd("new", elsewhere)).toBe(true);
			expect(gate.verdict("covered")).toBe("excluded");
			// the open one was forgotten: unknown while rules exist
			expect(gate.verdict("open")).toBe("excluded");
			expect(gate.verdict("new")).toBe("send");
		});

		test("when nothing but excluded sessions is idle, one of those is forgotten rather than refusing the launch", async () => {
			const { gate } = makeGate({ maxTrackedSessions: 2 });
			gate.noteCwd("covered-1", work);
			gate.noteCwd("covered-2", work);
			writeRules([work]);
			expect(gate.verdict("covered-1")).toBe("excluded");
			expect(gate.verdict("covered-2")).toBe("excluded");
			expect(gate.noteCwd("new", elsewhere)).toBe(true);
			expect(gate.verdict("new")).toBe("send");
		});

		test("the oldest of several idle ones goes first", async () => {
			const { gate } = makeGate({ maxTrackedSessions: 3 });
			gate.noteCwd("idle-1", elsewhere);
			gate.noteCwd("idle-2", elsewhere);
			gate.noteCwd("idle-3", elsewhere);
			writeRules([work]);
			expect(gate.noteCwd("new", elsewhere)).toBe(true);
			expect(gate.verdict("idle-2")).toBe("send");
			expect(gate.verdict("idle-3")).toBe("send");
			expect(gate.verdict("idle-1")).toBe("excluded");
		});
	});

	describe("an empty directory or an over-long id", () => {
		const longId = "x".repeat(1_025);
		test("with no rules file the launch proceeds as it did before the gate existed", () => {
			const { gate } = makeGate();
			expect(gate.noteCwd("sess-1", "")).toBe(true);
			expect(gate.noteCwd(longId, elsewhere)).toBe(true);
			expect(existsSync(gateFile())).toBe(false);
		});

		test("with rules in place it is refused", () => {
			const { gate } = makeGate();
			writeRules([work]);
			expect(gate.noteCwd("sess-1", "")).toBe(false);
			expect(gate.noteCwd(longId, elsewhere)).toBe(false);
		});

		test("while the rules are invalid it is refused too", () => {
			const { gate } = makeGate();
			writeRules(["not/an/absolute/path"]);
			expect(gate.rulesState()).toBe("invalid");
			expect(gate.noteCwd("sess-1", "")).toBe(false);
		});
	});
});

describe("a saved state that cannot be trusted is not an empty one", () => {
	const gateFile = () => join(home, ".agentpulse", "supervisor-gate-state.json");
	const plantedContent = () =>
		JSON.stringify({
			version: 1,
			sessions: { "sess-1": { cwd: elsewhere, reported: true } },
		});
	const MAX_BYTES = 32 * 1024 * 1024;
	/** Plants one kind of untrustworthy file; each returns what to do to make it trustworthy again, or null when deleting is the way. */
	const PLANTS: [string, () => (() => void) | null][] = [
		[
			"a symlink",
			() => {
				const real = join(home, "planted.json");
				writeFileSync(real, plantedContent(), { mode: 0o600 });
				symlinkSync(real, gateFile());
				return null;
			},
		],
		[
			"a second hard link",
			() => {
				const real = join(home, "planted.json");
				writeFileSync(real, plantedContent(), { mode: 0o600 });
				linkSync(real, gateFile());
				return () => rmSync(real);
			},
		],
		...[0o640, 0o620, 0o610, 0o604, 0o602, 0o601].map(
			(mode): [string, () => (() => void) | null] => [
				`mode ${mode.toString(8)} (group-only or other-only bits)`,
				() => {
					writeFileSync(gateFile(), plantedContent(), { mode });
					chmodSync(gateFile(), mode);
					return () => chmodSync(gateFile(), 0o600);
				},
			],
		),
		[
			"unparseable",
			() => {
				writeFileSync(gateFile(), "{not json", { mode: 0o600 });
				return null;
			},
		],
		[
			"an unknown version that still holds sessions",
			() => {
				writeFileSync(
					gateFile(),
					JSON.stringify({ version: 99, sessions: { "sess-1": { cwd: elsewhere } } }),
					{ mode: 0o600 },
				);
				return null;
			},
		],
		[
			"larger than the bound",
			() => {
				const head = plantedContent();
				writeFileSync(gateFile(), head + " ".repeat(MAX_BYTES + 1 - head.length), { mode: 0o600 });
				return null;
			},
		],
		[
			"a directory other accounts can write into",
			() => {
				writeFileSync(gateFile(), plantedContent(), { mode: 0o600 });
				chmodSync(join(home, ".agentpulse"), 0o770);
				return () => chmodSync(join(home, ".agentpulse"), 0o700);
			},
		],
	];

	for (const [label, plant] of PLANTS) {
		test(`${label}: with no rules file at all, nothing is reported, the heartbeat says invalid, the log names the file and the fix, and removing the file returns to normal`, async () => {
			const fix = plant();
			const logs: string[] = [];
			const { gate, calls } = makeGate({ logs });
			expect(gate.rulesState()).toBe("invalid");
			expect(gate.verdict("sess-1")).toBe("blocked");
			expect(gate.verdict("someone-else")).toBe("blocked");
			expect(gate.verdictForDirectory(elsewhere)).toBe("blocked");
			await gate.reportState(stateBody("sess-1", elsewhere));
			await gate.reportEvents("sess-1", eventsFor());
			await gate.reportLaunchStatus("launch-1", { status: "running" });
			await gate.reportControlStatus("act-1", "sess-1", { status: "succeeded" });
			await gate.scan();
			expect(calls).toEqual([]);
			const line = logs.find((l) => l.includes("supervisor-gate-state.json"));
			expect(line, logs.join("\n")).toBeDefined();
			expect(line).toContain("permissions");
			expect(line).toContain("delete");
			expect(logs.filter((l) => l.includes("supervisor-gate-state.json"))).toHaveLength(1);

			// repaired or deleted: back to normal, without a restart
			if (fix) fix();
			else rmSync(gateFile(), { force: true });
			expect(gate.rulesState()).toBe("none");
			expect(gate.verdict("sess-1")).toBe("send");
		});
	}

	test("a state file that is trustworthy again is read and believed: its sessions are known", async () => {
		writeFileSync(gateFile(), plantedContent(), { mode: 0o640 });
		chmodSync(gateFile(), 0o640);
		writeRules([work]);
		const { gate } = makeGate();
		expect(gate.verdict("sess-1")).toBe("blocked");
		chmodSync(gateFile(), 0o600);
		expect(gate.verdict("sess-1")).toBe("send");
		expect(gate.verdict("sess-1", elsewhere)).toBe("send");
		expect(gate.verdict("stranger")).toBe("excluded");
	});

	test("the log advises repair first, then deleting, and says what deleting costs", async () => {
		writeFileSync(gateFile(), "{not json", { mode: 0o600 });
		const logs: string[] = [];
		makeGate({ logs });
		const line = logs.find((l) => l.includes("supervisor-gate-state.json")) ?? "";
		const repair = line.indexOf("Repair its permissions");
		const remove = line.indexOf("Or delete it");
		expect(repair).toBeGreaterThan(-1);
		expect(remove).toBeGreaterThan(repair);
		const consequence = line.slice(remove);
		expect(consequence).toContain("sessions that are already running");
		expect(consequence).toContain("no closing report");
		expect(consequence).toContain("stay live on the dashboard until the sweep");
	});

	test("the stamp says the saved state is the cause, with no path in it, and says so about the exclude file when that is the cause", async () => {
		const stampFile = join(home, SUPERVISOR_EXCLUDE_STATE_STAMP_RELATIVE_PATH);
		writeRules([work]);
		writeFileSync(gateFile(), plantedContent(), { mode: 0o640 });
		chmodSync(gateFile(), 0o640);
		const { gate } = makeGate();
		await gate.scan();
		const raw = readFileSync(stampFile, "utf-8");
		expect(JSON.parse(raw)).toMatchObject({ rulesState: "invalid", cause: "state_file" });
		expect(raw).not.toContain(home);

		chmodSync(gateFile(), 0o600);
		await gate.scan();
		const ok = JSON.parse(readFileSync(stampFile, "utf-8")) as Record<string, unknown>;
		expect(ok.rulesState).toBe("ok");
		expect(ok.cause).toBeUndefined();

		writeRules(["relative"]);
		await gate.scan();
		expect(JSON.parse(readFileSync(stampFile, "utf-8"))).toMatchObject({
			rulesState: "invalid",
			cause: "exclude_file",
		});
	});

	test("once the file is repaired, a scan alone recovers: nothing else has to decide anything first, and the stamp goes back to ok", async () => {
		const stampFile = join(home, SUPERVISOR_EXCLUDE_STATE_STAMP_RELATIVE_PATH);
		writeRules([work]);
		writeFileSync(gateFile(), plantedContent(), { mode: 0o640 });
		chmodSync(gateFile(), 0o640);
		const { gate } = makeGate();
		await gate.scan();
		expect(JSON.parse(readFileSync(stampFile, "utf-8"))).toMatchObject({ rulesState: "invalid" });

		chmodSync(gateFile(), 0o600);
		await gate.scan();
		expect(JSON.parse(readFileSync(stampFile, "utf-8"))).toMatchObject({ rulesState: "ok" });
		expect(gate.verdict("sess-1")).toBe("send");
	});

	test("a state file with more entries than the bound loads only the newest ones", () => {
		const sessions: Record<string, unknown> = {};
		for (let i = 0; i < 5; i++) sessions[`id-${i}`] = { cwd: elsewhere };
		writeFileSync(gateFile(), JSON.stringify({ version: 1, sessions }), { mode: 0o600 });
		writeRules([work]);
		const { gate } = makeGate({ maxTrackedSessions: 3 });
		// known (with a directory no rule covers): send; forgotten: unknown while rules exist, so excluded
		expect(["id-0", "id-1", "id-2", "id-3", "id-4"].map((id) => gate.verdict(id))).toEqual([
			"excluded",
			"excluded",
			"send",
			"send",
			"send",
		]);
	});

	test("nothing is written over an untrusted file", async () => {
		writeFileSync(gateFile(), "{not json", { mode: 0o600 });
		const { gate } = makeGate();
		writeRules([work]);
		expect(gate.noteCwd("sess-1", elsewhere)).toBe(true);
		await gate.scan();
		expect(readFileSync(gateFile(), "utf-8")).toBe("{not json");
	});

	test("an owner other than this account is not trusted", async () => {
		if (process.platform === "win32" || process.getuid === undefined) return;
		writeFileSync(gateFile(), plantedContent(), { mode: 0o600 });
		const real = process.getuid;
		process.getuid = () => real.call(process) + 1;
		try {
			const { gate } = makeGate();
			expect(gate.rulesState()).toBe("invalid");
			expect(gate.verdict("sess-1")).toBe("blocked");
		} finally {
			process.getuid = real;
		}
	});

	test("the stat checks, one condition at a time (a file owned by someone else cannot be planted here without root)", () => {
		const me = 501;
		const dir = (
			over: Partial<{ isDirectory: () => boolean; uid: number; mode: number }> = {},
		) => ({
			isDirectory: () => true,
			uid: me,
			mode: 0o40700,
			...over,
		});
		expect(isTrustedDirectoryStat(dir(), me)).toBe(true);
		expect(isTrustedDirectoryStat(dir({ uid: me + 1 }), me)).toBe(false);
		expect(isTrustedDirectoryStat(dir({ mode: 0o40770 }), me)).toBe(false);
		expect(isTrustedDirectoryStat(dir({ mode: 0o40707 }), me)).toBe(false);
		expect(isTrustedDirectoryStat(dir({ isDirectory: () => false }), me)).toBe(false);
		expect(isTrustedDirectoryStat(dir({ uid: me + 1 }), undefined)).toBe(true);

		const file = (
			over: Partial<{
				isFile: () => boolean;
				nlink: number;
				size: number;
				uid: number;
				mode: number;
			}> = {},
		) => ({ isFile: () => true, nlink: 1, size: 100, uid: me, mode: 0o100600, ...over });
		expect(isTrustedStateFileStat(file(), me)).toBe(true);
		expect(isTrustedStateFileStat(file({ uid: me + 1 }), me)).toBe(false);
		expect(isTrustedStateFileStat(file({ mode: 0o100640 }), me)).toBe(false);
		expect(isTrustedStateFileStat(file({ mode: 0o100604 }), me)).toBe(false);
		expect(isTrustedStateFileStat(file({ nlink: 2 }), me)).toBe(false);
		expect(isTrustedStateFileStat(file({ size: MAX_BYTES }), me)).toBe(true);
		expect(isTrustedStateFileStat(file({ size: MAX_BYTES + 1 }), me)).toBe(false);
		expect(isTrustedStateFileStat(file({ isFile: () => false }), me)).toBe(false);
	});

	test("a file of exactly the bound is believed, one byte more is not", async () => {
		writeFileSync(gateFile(), plantedContent() + " ".repeat(MAX_BYTES - plantedContent().length), {
			mode: 0o600,
		});
		expect(makeGate().gate.rulesState()).toBe("none");
		writeFileSync(
			gateFile(),
			plantedContent() + " ".repeat(MAX_BYTES + 1 - plantedContent().length),
			{
				mode: 0o600,
			},
		);
		expect(makeGate().gate.rulesState()).toBe("invalid");
	});

	test("an absent file, or an absent directory, is normal", async () => {
		expect(makeGate().gate.rulesState()).toBe("none");
		rmSync(join(home, ".agentpulse"), { recursive: true });
		expect(makeGate().gate.rulesState()).toBe("none");
	});

	test("the stamp the CLI reads says invalid", async () => {
		writeFileSync(gateFile(), "{not json", { mode: 0o600 });
		const { gate } = makeGate();
		await gate.scan();
		const stamp = JSON.parse(
			readFileSync(join(home, SUPERVISOR_EXCLUDE_STATE_STAMP_RELATIVE_PATH), "utf-8"),
		) as { rulesState: string };
		expect(stamp.rulesState).toBe("invalid");
	});
});

describe("what the gate keeps and compares is held to the least it needs", () => {
	const gateFile = () => join(home, ".agentpulse", "supervisor-gate-state.json");

	test("directories are the same only when their real paths are: a path that goes through a symlink and back up is not the directory it reads like", async () => {
		const real = join(home, "c");
		const other = join(home, "d2", "c");
		mkdirSync(real, { recursive: true });
		mkdirSync(other, { recursive: true });
		mkdirSync(join(home, "d2", "sub"), { recursive: true });
		symlinkSync(join(home, "d2", "sub"), join(home, "L"));
		const { gate } = makeGate();
		gate.noteCwd("sess-1", real);
		writeRules([work]);
		// join() would fold the dots away, so the spelling is built by hand: "<home>/L/../c" reads like "<home>/c" but the operating system follows L first: it is <home>/d2/c
		expect(gate.verdict("sess-1", `${home}/L/../c`)).toBe("refused");
		expect(gate.verdict("sess-1", real)).toBe("send");
	});

	test("the very same string is the same directory even when it is gone (a retried cleanup); a different spelling of a directory that does not exist is not", async () => {
		const { gate } = makeGate();
		const gone = join(home, "not-there");
		gate.noteCwd("sess-1", gone);
		writeRules([work]);
		expect(gate.verdict("sess-1", gone)).toBe("send");
		expect(gate.verdict("sess-1", `${gone}/`)).toBe("refused");
		expect(gate.verdict("sess-1", `${gone}/../not-there`)).not.toBe("send");
	});

	test("the file holds no directory for a session that is excluded, and a directory in an older file is dropped for one", async () => {
		const { gate } = makeGate();
		gate.noteCwd("covered", work);
		gate.noteCwd("open", elsewhere);
		writeRules([work]);
		expect(gate.verdict("covered")).toBe("excluded");
		const saved = JSON.parse(readFileSync(gateFile(), "utf-8")) as {
			sessions: Record<string, { cwd?: string; excluded?: boolean }>;
		};
		expect(saved.sessions.covered).toEqual({ excluded: true });
		expect(saved.sessions.open?.cwd).toBe(elsewhere);
		expect(readFileSync(gateFile(), "utf-8")).not.toContain("secret-project");

		writeFileSync(
			gateFile(),
			JSON.stringify({ version: 1, sessions: { old: { cwd: work, excluded: true } } }),
			{ mode: 0o600 },
		);
		const again = makeGate().gate;
		expect(again.verdict("old")).toBe("excluded");
		again.noteCwd("another", elsewhere);
		expect(readFileSync(gateFile(), "utf-8")).not.toContain("secret-project");
	});

	test("a later note of a directory for an excluded session does not bring a directory back", () => {
		const { gate } = makeGate();
		gate.noteCwd("covered", work);
		writeRules([work]);
		expect(gate.verdict("covered")).toBe("excluded");
		gate.noteCwd("covered", elsewhere);
		expect(readFileSync(gateFile(), "utf-8")).not.toContain("open-project");
		expect(gate.verdict("covered")).toBe("excluded");
	});

	test("skipping a save because the directory is not trusted is said once in the log; with no rules at all nothing is saved and nothing is said", async () => {
		const logs: string[] = [];
		const { gate } = makeGate({ logs });
		writeRules([work]);
		chmodSync(join(home, ".agentpulse"), 0o770);
		gate.noteCwd("sess-1", elsewhere);
		gate.noteCwd("sess-2", elsewhere);
		const warned = logs.filter((l) => l.includes("isn't saved") || l.includes("not saved"));
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain(join(home, ".agentpulse"));

		chmodSync(join(home, ".agentpulse"), 0o700);
		rmSync(join(home, ".agentpulse", "exclude"));
		const quiet: string[] = [];
		const noRules = makeGate({ logs: quiet }).gate;
		chmodSync(join(home, ".agentpulse"), 0o770);
		noRules.noteCwd("sess-3", elsewhere);
		expect(quiet).toEqual([]);
	});

	test("a session id that names an object prototype is kept like any other, in memory and in the file", async () => {
		const first = makeGate().gate;
		writeRules([work]);
		first.noteCwd("__proto__", elsewhere);
		first.noteCwd("constructor", elsewhere);
		const text = readFileSync(gateFile(), "utf-8");
		expect(text).toContain('"__proto__"');
		expect(text).toContain('"constructor"');
		const second = makeGate().gate;
		expect(second.verdict("__proto__")).toBe("send");
		expect(second.verdict("constructor")).toBe("send");
		expect(second.verdict("toString")).toBe("excluded");
	});
});

describe("invalid rules drop every gated report, and nothing is replayed", () => {
	test("reporting stops while the file is invalid, resumes when it is fixed, and the dropped reports do not come back", async () => {
		const { gate, calls } = makeGate();
		await startSession(gate, "live-1", elsewhere);
		const started = calls.length;

		writeRules(["not/an/absolute/path"]);
		await gate.reportState(stateBody("live-1", elsewhere));
		await gate.reportEvents("live-1", eventsFor("dropped while invalid"));
		await gate.reportLaunchStatus("launch-x", { status: "running" });
		await gate.reportControlStatus("act-1", "live-1", { status: "succeeded" });
		await gate.scan();
		expect(calls).toHaveLength(started);

		writeRules([work]);
		await gate.reportEvents("live-1", eventsFor("after the fix"));
		expect(calls).toHaveLength(started + 1);
		expect(JSON.stringify(calls.slice(started))).toContain("after the fix");
		expect(JSON.stringify(calls)).not.toContain("dropped while invalid");
	});

	test("no closing report is sent while the rules are invalid, even for a session that a rule would cover", async () => {
		const { gate, calls } = makeGate();
		await startSession(gate, "live-2", work);
		const started = calls.length;
		writeRules([work, "relative"]);
		await gate.reportState(stateBody("live-2", work));
		await gate.scan();
		expect(calls).toHaveLength(started);
		writeRules([work]);
		await gate.scan();
		expect(calls.slice(started)).toEqual([
			{ path: `${BASE}/managed-session-state`, method: "POST", body: FINAL("live-2") },
		]);
	});

	test("the invalid marker follows the file: present while it is invalid, gone when fixed", async () => {
		const { gate } = makeGate();
		await startSession(gate, "live-3", elsewhere);
		const marker = join(home, ".agentpulse", "exclude.invalid");
		writeRules(["relative"]);
		await gate.scan();
		expect(existsSync(marker)).toBe(true);
		writeRules([work]);
		await gate.scan();
		expect(existsSync(marker)).toBe(false);
	});
});

describe("refusing a launch posts one fixed body, whatever the reason", () => {
	test("the body is exactly the generic refusal, with no path and no mention of exclusion, rules valid or not", async () => {
		const { gate, calls } = makeGate();
		await gate.refuseLaunch("launch-1");
		writeRules(["relative"]);
		await gate.refuseLaunch("launch-2");
		writeRules([work]);
		await gate.refuseLaunch("launch-3");
		const expected = {
			status: "failed",
			error: "This host doesn't allow launches in that directory.",
			providerLaunchMetadata: {
				prelaunchError: {
					code: "path_outside_trusted_roots",
					message: "This host doesn't allow launches in that directory.",
				},
			},
		};
		expect(calls.map((c) => c.body)).toEqual([expected, expected, expected]);
		expect(paths(calls)).toEqual([
			`POST ${BASE}/launches/launch-1/status`,
			`POST ${BASE}/launches/launch-2/status`,
			`POST ${BASE}/launches/launch-3/status`,
		]);
		expect(LAUNCH_REFUSED_MESSAGE).toBe("This host doesn't allow launches in that directory.");
		expect(LAUNCH_REFUSED_CODE).toBe("path_outside_trusted_roots");
		expect(JSON.stringify(calls).toLowerCase()).not.toContain("exclu");
	});

	test("a launch status for an excluded launch is dropped, for a clean one it is sent", async () => {
		const { gate, calls } = makeGate();
		writeRules([work]);
		gate.noteCwd("launch-secret", work);
		gate.noteCwd("launch-open", elsewhere);
		await gate.reportLaunchStatus("launch-secret", { status: "running", pid: 1 });
		await gate.reportLaunchStatus("launch-open", { status: "running", pid: 2 });
		expect(paths(calls)).toEqual([`POST ${BASE}/launches/launch-open/status`]);
	});
});

describe("control action results", () => {
	test("for an excluded session the result is exactly the generic failure, once per action, whatever the caller meant to say", async () => {
		const { gate, calls } = makeGate();
		await startSession(gate, "sess-1", work);
		writeRules([work]);
		const before = calls.length;
		await gate.reportControlStatus("act-1", "sess-1", {
			status: "succeeded",
			metadata: { cwd: work, output: "private output" },
		});
		await gate.reportControlStatus("act-1", "sess-1", { status: "failed", error: "private error" });
		await gate.reportControlStatus("act-2", "sess-1", { status: "running" });
		const statuses = calls.slice(before).filter((c) => c.path.includes("/control-actions/"));
		expect(statuses).toEqual([
			{
				path: `${BASE}/control-actions/act-1/status`,
				method: "POST",
				body: { status: "failed", error: LAUNCH_REFUSED_MESSAGE },
			},
			{
				path: `${BASE}/control-actions/act-2/status`,
				method: "POST",
				body: { status: "failed", error: LAUNCH_REFUSED_MESSAGE },
			},
		]);
		expect(JSON.stringify(calls.slice(before))).not.toContain("private");
	});

	test("for a clean session the result goes out as given", async () => {
		const { gate, calls } = makeGate();
		await startSession(gate, "sess-1", elsewhere);
		writeRules([work]);
		const before = calls.length;
		await gate.reportControlStatus("act-1", "sess-1", {
			status: "succeeded",
			metadata: { output: "fine" },
		});
		expect(calls.slice(before)).toEqual([
			{
				path: `${BASE}/control-actions/act-1/status`,
				method: "POST",
				body: { status: "succeeded", metadata: { output: "fine" } },
			},
		]);
	});

	test("an action with no session is judged by the directory it names", async () => {
		const { gate, calls } = makeGate();
		writeRules([work]);
		await gate.reportControlStatus(
			"act-cleanup",
			null,
			{ status: "succeeded", metadata: { cleanup: { resolvedPath: work } } },
			work,
		);
		expect(calls.map((c) => c.body)).toEqual([{ status: "failed", error: LAUNCH_REFUSED_MESSAGE }]);
	});
});

describe("the verdict an action handler asks before it executes anything", () => {
	test("send / excluded / blocked by rules state and directory", async () => {
		const { gate } = makeGate();
		gate.noteCwd("a", work);
		gate.noteCwd("b", elsewhere);
		expect(gate.verdict("a")).toBe("send");
		writeRules([work]);
		expect(gate.verdict("a")).toBe("excluded");
		expect(gate.verdict("b")).toBe("send");
		expect(gate.verdict("unknown")).toBe("excluded");
		expect(gate.verdict(null)).toBe("excluded");
		writeRules(["relative"]);
		expect(gate.verdict("b")).toBe("blocked");
		expect(gate.rulesState()).toBe("invalid");
		removeRules();
		expect(gate.rulesState()).toBe("none");
		expect(gate.verdict("unknown")).toBe("send");
	});
});

describe("the stamp the CLI reads", () => {
	const stampPath = () => join(home, SUPERVISOR_EXCLUDE_STATE_STAMP_RELATIVE_PATH);

	test("each scan writes version, rules state and time, private, and follows the rules", async () => {
		const { gate } = makeGate({ version: "1.2.3" });
		await gate.scan();
		let stamp = JSON.parse(readFileSync(stampPath(), "utf-8")) as Record<string, unknown>;
		expect(stamp).toEqual({
			version: "1.2.3",
			rulesState: "none",
			at: new Date(clock).toISOString(),
		});
		expect(statSync(stampPath()).mode & 0o777).toBe(0o600);

		clock += 5_000;
		writeRules([work]);
		await gate.scan();
		stamp = JSON.parse(readFileSync(stampPath(), "utf-8"));
		expect(stamp).toMatchObject({ rulesState: "ok", at: new Date(clock).toISOString() });

		writeRules(["relative"]);
		await gate.scan();
		expect(JSON.parse(readFileSync(stampPath(), "utf-8"))).toMatchObject({ rulesState: "invalid" });
		expect(readdirSync(join(home, ".agentpulse")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
	});

	test("a missing ~/.agentpulse is not created for the stamp, and the scan still works", async () => {
		rmSync(join(home, ".agentpulse"), { recursive: true });
		const { gate } = makeGate();
		await gate.scan();
		expect(existsSync(join(home, ".agentpulse"))).toBe(false);
	});
});

describe("what a report costs the filesystem", () => {
	test("each report is one signature check (a stat of the directory and an lstat of the file) and the rules are read once", async () => {
		writeRules([work]);
		let stats = 0;
		let lstats = 0;
		const probeFs = {
			statSync: (p: string) => {
				stats++;
				return statSync(p);
			},
			lstatSync: (p: string) => {
				lstats++;
				return statSync(p, { bigint: false }) as never;
			},
		};
		const rules = createRulesWatch({ home, probeFs });
		const { request } = recorder();
		const gate = createReportGate({
			request,
			supervisorId: SUPERVISOR_ID,
			home,
			rules,
			now: () => clock,
			log: () => {},
		});
		gate.noteCwd("cost-1", elsewhere);
		stats = 0;
		lstats = 0;
		const probesBefore = rules.counters().probes;
		for (let i = 0; i < 20; i++) await gate.reportState(stateBody("cost-1", elsewhere));
		expect(stats).toBe(20);
		expect(lstats).toBe(20);
		expect(rules.counters()).toEqual({ probes: probesBefore + 20, loads: 1 });
	});

	test("a changed rules file is read once more, not once per report", async () => {
		const rules = createRulesWatch({ home });
		rules.current();
		rules.current();
		writeRules([work]);
		rules.current();
		rules.current();
		rules.current();
		expect(rules.counters().loads).toBe(2);
	});

	test("a symlink in a rule that moved is followed by the periodic rescan, without reading the file again", async () => {
		const target = join(home, "link-target");
		mkdirSync(target);
		const link = join(home, "movable");
		symlinkSync(elsewhere, link);
		writeRules([link]);
		const rules = createRulesWatch({ home });
		expect(rules.current().rules[0]?.resolved).toBe(elsewhere);
		rmSync(link);
		symlinkSync(work, link);
		expect(rules.current().rules[0]?.resolved).toBe(elsewhere);
		expect(rules.rescan().rules[0]?.resolved).toBe(work);
		expect(rules.counters().loads).toBe(1);
	});
});

describe("what became of a report (outcome), delivery ids and the replay marker (AGEN-83)", () => {
	const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

	/** Puts the gate in each of the three situations: no rules (send), a rule over `work` (excluded), an invalid rules file (blocked). */
	function situation(kind: "send" | "excluded" | "blocked") {
		const made = makeGate();
		made.gate.noteCwd("sess-1", work);
		if (kind === "excluded") writeRules([work]);
		if (kind === "blocked") writeRules(["not/an/absolute/path"]);
		return made;
	}

	for (const kind of ["send", "excluded", "blocked"] as const) {
		const outcome = kind === "send" ? "sent" : kind;
		test(`reportEvents resolves "${outcome}" when the verdict is ${kind}`, async () => {
			const { gate } = situation(kind);
			expect(await gate.reportEvents("sess-1", eventsFor())).toBe(outcome);
		});

		test(`reportState resolves outcome "${outcome}" when the verdict is ${kind}, and a send keeps the server's answer`, async () => {
			const { gate } = situation(kind);
			const result = await gate.reportState(stateBody("sess-1", work));
			expect(result.outcome).toBe(outcome);
			if (kind === "send") expect(result.session.displayName).toBe("from-server");
			else expect(result.session.displayName).toBe("");
		});
	}

	test("a dropped state report is a fresh object each time: the shared dropped result is never written to", async () => {
		const excluded = situation("excluded");
		const first = await excluded.gate.reportState(stateBody("sess-1", work));
		const again = await excluded.gate.reportState(stateBody("sess-1", work));
		expect(first).not.toBe(again);
		expect(first.outcome).toBe("excluded");
		// the same gate later judging by an invalid file: the earlier "excluded" must not leak into it
		const blocked = situation("blocked");
		const dropped = await blocked.gate.reportState(stateBody("sess-1", work));
		expect(dropped.outcome).toBe("blocked");
		expect(first.outcome).toBe("excluded");
		first.outcome = "sent";
		const later = await blocked.gate.reportState(stateBody("sess-2", work));
		expect(later.outcome).toBe("blocked");
	});

	test("events carry a UUID delivery id, distinct per send, and a given deliveryId is kept", async () => {
		const { gate, headers } = makeGate();
		await gate.reportEvents("sess-1", eventsFor());
		await gate.reportEvents("sess-1", eventsFor("another"));
		await gate.reportEvents("sess-1", eventsFor("third"), { deliveryId: "fixed-id-12345" });
		const ids = headers.map((h) => h?.["X-AgentPulse-Delivery-Id"]);
		expect(ids[0]).toMatch(UUID);
		expect(ids[1]).toMatch(UUID);
		expect(ids[0]).not.toBe(ids[1]);
		expect(ids[2]).toBe("fixed-id-12345");
		expect(headers.every((h) => h?.["X-AgentPulse-Replay"] === undefined)).toBe(true);
	});

	test("replay sets the replay header on events and on state, and only then", async () => {
		const { gate, headers, calls } = makeGate();
		await gate.reportEvents("sess-1", eventsFor(), { replay: true });
		await gate.reportState(stateBody("sess-1", work), { replay: true });
		await gate.reportState(stateBody("sess-1", work));
		expect(calls.map((c) => c.path)).toEqual([
			`${BASE}/managed-sessions/sess-1/events`,
			`${BASE}/managed-session-state`,
			`${BASE}/managed-session-state`,
		]);
		expect(headers[0]?.["X-AgentPulse-Replay"]).toBe("1");
		expect(headers[1]).toEqual({ "X-AgentPulse-Replay": "1" });
		expect(headers[2]).toBeUndefined();
	});

	test("occurredAt is stamped with the gate's clock on events that have none, and a preset one is kept", async () => {
		const { gate, calls } = makeGate();
		await gate.reportEvents("sess-1", [
			...eventsFor("plain"),
			{ ...eventsFor("old")[0], occurredAt: "2025-12-31T23:00:00.000Z" } as never,
			{ ...eventsFor("nulled")[0], occurredAt: null } as never,
		]);
		const sent = (calls[0]?.body as { events: Array<{ content: string; occurredAt: string }> })
			.events;
		const at = new Date(clock).toISOString();
		expect(sent.map((e) => [e.content, e.occurredAt])).toEqual([
			["plain", at],
			["old", "2025-12-31T23:00:00.000Z"],
			["nulled", at],
		]);
	});

	test("no other kind of request carries the delivery id or the replay marker", async () => {
		const { gate, headers } = makeGate();
		gate.noteCwd("launch-1", work);
		gate.noteCwd("sess-1", work);
		await gate.reportLaunchStatus("launch-1", { status: "running" });
		await gate.reportState(stateBody("sess-1", work));
		await gate.reportControlStatus("act-1", "sess-1", { status: "succeeded" });
		await gate.refuseLaunch("launch-2");
		await gate.refuseControlAction("act-2");
		// the closing report of a newly excluded session
		writeRules([work]);
		await gate.scan();
		expect(headers.length).toBeGreaterThanOrEqual(6);
		expect(headers.every((h) => h === undefined || Object.keys(h).length === 0)).toBe(true);
	});
});

/** The endpoint paths that carry session data; none may appear under src/supervisor outside the gate. */
const SESSION_DATA_FRAGMENTS: [string, RegExp][] = [
	["managed-session-state", /managed-session-state/],
	["managed-sessions/<id>/events", /managed-sessions\/[^\n"'`]*events/],
	["managed-sessions/<id>/approvals", /managed-sessions\/[^\n"'`]*approvals/],
	["approvals/sync", /approvals\/sync/],
	// AGEN-123
	["managed-sessions/<id>/tool-calls", /managed-sessions\/[^\n"'`]*tool-calls/],
	["control-actions/<id>/status", /control-actions\/[^\n"'`]*status/],
	["launches/<id>/status", /launches\/[^\n"'`]*status/],
];

describe("nothing else sends session data (drift guards)", () => {
	test("the two approval endpoint paths are in the drift list, beside the four that were there", () => {
		const names = SESSION_DATA_FRAGMENTS.map(([name]) => name);
		expect(names).toContain("managed-sessions/<id>/approvals");
		expect(names).toContain("approvals/sync");
		expect(names.length).toBeGreaterThanOrEqual(6);
	});

	function sourceFiles(dir: string): string[] {
		const out: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) out.push(...sourceFiles(full));
			else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
		}
		return out;
	}
	const SUPERVISOR_DIR = join(import.meta.dir, "..");

	test("the four session-data endpoint paths appear under src/supervisor only inside report-gate.ts", () => {
		const fragments = SESSION_DATA_FRAGMENTS;
		const offenders: string[] = [];
		for (const file of sourceFiles(SUPERVISOR_DIR)) {
			if (file.endsWith("report-gate.ts")) continue;
			const text = readFileSync(file, "utf-8");
			for (const [name, re] of fragments) {
				if (re.test(text)) offenders.push(`${file.slice(SUPERVISOR_DIR.length)}: ${name}`);
			}
		}
		expect(offenders).toEqual([]);
		const gateText = readFileSync(join(import.meta.dir, "report-gate.ts"), "utf-8");
		for (const [name, re] of fragments) expect(re.test(gateText), name).toBe(true);
	});

	/** The supervisor's raw `request` function is session data's way out. Nothing but index.ts (which owns it) and the gate may hold it; index.ts may call it only for these endpoints, none of which carries session data. */
	const SANCTIONED_REQUEST_CALLS = [
		'"/supervisors/register"',
		"`/supervisors/${registration.supervisor.id}/launches/claim`",
		"`/supervisors/${registration.supervisor.id}/heartbeat`",
		"`/supervisors/${registration.supervisor.id}/provider-sync`",
		"`/supervisors/${registration.supervisor.id}/control-actions/claim`",
	];

	function stripComments(text: string): string {
		return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	}

	/** Every way `files` (path -> source) hold or call the raw request function other than the sanctioned ones. */
	function unsanctionedRequestUses(files: Record<string, string>): string[] {
		const offenders: string[] = [];
		for (const [file, raw] of Object.entries(files)) {
			if (file.endsWith("report-gate.ts")) continue;
			const text = stripComments(raw);
			// The identifier used as code: followed by a call, a separator, an assignment or a cast, not by a word (as in a message).
			const uses = [
				...text.matchAll(/(?<![.\w])request\b(?!<)(?=\s*(?:[(,;)}\]:=.]|as\b|satisfies\b|$))/gm),
			];
			if (!file.endsWith("index.ts")) {
				for (const use of uses) offenders.push(`${file}: holds request at ${use.index}`);
				continue;
			}
			for (const use of uses) {
				const after = text.slice((use.index ?? 0) + "request".length);
				const declaration = /^\s*\(path: string, options\?: RequestInit\)/.test(after);
				const handedToGate = /^,\s*supervisorId/.test(after);
				const argument = /^\(\s*([^,)]*(?:\$\{[^}]*\}[^,)]*)*)/.exec(after)?.[1]?.trim();
				const sanctionedCall =
					argument !== undefined && SANCTIONED_REQUEST_CALLS.includes(argument);
				if (!declaration && !handedToGate && !sanctionedCall) {
					offenders.push(`${file}: unsanctioned use of request near: ${after.slice(0, 60).trim()}`);
				}
			}
		}
		return offenders;
	}

	function supervisorSources(): Record<string, string> {
		return Object.fromEntries(
			sourceFiles(SUPERVISOR_DIR).map((file) => [
				file.slice(SUPERVISOR_DIR.length),
				readFileSync(file, "utf-8"),
			]),
		);
	}

	test("only the gate sends session data: no file under src/supervisor but the gate and index.ts holds the raw request function, and index.ts calls it only for endpoints that carry none", () => {
		expect(unsanctionedRequestUses(supervisorSources())).toEqual([]);
		// the checker saw the sanctioned uses it is meant to allow, so an empty answer is not an empty scan
		const indexText = supervisorSources()["/index.ts"] ?? "";
		for (const call of SANCTIONED_REQUEST_CALLS) expect(indexText, call).toContain(call);
	});

	test("the checker refuses what the path-fragment guard cannot see: a concatenated path, an aliased or passed-along request, a request held by another file", () => {
		const real = supervisorSources();
		const plant = (file: string, add: string) => ({
			...real,
			[file]: `${real[file] ?? ""}\n${add}\n`,
		});
		const cases: [string, Record<string, string>][] = [
			[
				"concatenated path in index.ts",
				plant(
					"/index.ts",
					'await request("/supervisors/x" + "/managed-" + "session-state", { method: "POST" });',
				),
			],
			[
				"a template path built from parts in index.ts",
				plant("/index.ts", "await request(`/supervisors/x/${part}`, { method: 'POST' });"),
			],
			["request aliased in index.ts", plant("/index.ts", "const send = request;")],
			[
				"request handed to a provider",
				plant(
					"/index.ts",
					"startProvider({ request, supervisorId: 'x' });".replace(
						"request, supervisorId",
						"request }",
					),
				),
			],
			[
				"another file receiving request",
				plant(
					"/providers/claude-shared.ts",
					"export function leak(request: unknown) { return request; }",
				),
			],
		];
		for (const [label, files] of cases) {
			expect(unsanctionedRequestUses(files).length, label).toBeGreaterThan(0);
		}
	});

	/**
	 * Only two places under src/supervisor may send an HTTP request: the one transport function in
	 * index.ts (which every report passes through after the gate) and the Codex observer's own post of
	 * hook events (which asks the rules itself). A tripwire on source text, not a proof: it reads names,
	 * so a send hidden behind a name this scan does not know is not seen.
	 */
	function strayFetchUses(files: Record<string, string>): string[] {
		const offenders: string[] = [];
		const enclosing = (code: string, at: number) =>
			[...code.slice(0, at).matchAll(/(?<![\w.])function\s+(\w+)\s*\(/g)].at(-1)?.[1] ??
			"<top level>";
		const near = (code: string, at: number) =>
			code.slice(Math.max(0, at - 20), at + 40).replace(/\s+/g, " ");
		for (const [file, raw] of Object.entries(files)) {
			const code = stripComments(raw);
			const isTransport = file === "/index.ts";
			const isObserver = file === "/services/codex-observer.ts";

			// a call of fetch: the one in the transport function, and nowhere else
			let transportCalls = 0;
			for (const m of code.matchAll(/(?<![\w$.])fetch\s*\(/g)) {
				const at = m.index ?? 0;
				if (isTransport && enclosing(code, at) === "request" && ++transportCalls === 1) continue;
				offenders.push(`${file}: a fetch call in ${enclosing(code, at)}: ${near(code, at)}`);
			}
			// fetch used as a value (stored, passed on, read from the global object): only the observer's default parameter
			let observerDefaults = 0;
			for (const m of code.matchAll(/(?<![\w$.])fetch\b(?!\s*\()/g)) {
				const at = m.index ?? 0;
				if (
					isObserver &&
					/=\s*$/.test(code.slice(Math.max(0, at - 4), at)) &&
					++observerDefaults === 1
				)
					continue;
				offenders.push(`${file}: fetch used as a value: ${near(code, at)}`);
			}
			for (const m of code.matchAll(/\.\s*fetch\b|\[\s*["'`]fetch["'`]\s*\]/g)) {
				offenders.push(`${file}: a fetch property: ${near(code, m.index ?? 0)}`);
			}
			// the observer's own post: one call of its fetch parameter, inside postHook
			let observerPosts = 0;
			for (const m of code.matchAll(/\bfetchImpl\b(?=\s*\()/g)) {
				const at = m.index ?? 0;
				if (isObserver && enclosing(code, at) === "postHook" && ++observerPosts === 1) continue;
				offenders.push(`${file}: a call of fetchImpl in ${enclosing(code, at)}: ${near(code, at)}`);
			}
			if (!isObserver) {
				for (const m of code.matchAll(/\bfetchImpl\b/g)) {
					offenders.push(`${file}: fetchImpl outside the observer: ${near(code, m.index ?? 0)}`);
				}
			}
			// other ways to open an HTTP connection
			for (const m of code.matchAll(
				/from\s+["'](?:node:)?(?:https?|http2|tls|dgram|dns)["']|\bimport\s*\(\s*["'](?:node:)?(?:https?|http2|tls|dgram|dns)["']\s*\)|\bXMLHttpRequest\b/g,
			)) {
				offenders.push(`${file}: a network module: ${near(code, m.index ?? 0)}`);
			}
		}
		return offenders;
	}

	test("nothing under src/supervisor can send a request but the transport function and the observer's own post", () => {
		const real = supervisorSources();
		expect(strayFetchUses(real)).toEqual([]);
		// the scan covers the tree and finds the two sanctioned sends it is meant to allow, so an empty answer is not an empty scan
		expect(Object.keys(real).length).toBeGreaterThanOrEqual(15);
		expect(real["/index.ts"]).toMatch(/\bfetch\(/);
		expect(real["/services/codex-observer.ts"]).toMatch(/\bfetchImpl\(/);
	});

	test("the scan sees a fetch anywhere else: another file, a second call in the transport function, a concatenated URL, a global or a stored fetch, a network module", () => {
		const real = supervisorSources();
		const plant = (file: string, add: string) => ({
			...real,
			[file]: `${real[file] ?? ""}\n${add}\n`,
		});
		const inside = (file: string, header: string, add: string) => {
			expect(real[file], `${header} is in ${file}`).toContain(header);
			return { ...real, [file]: (real[file] ?? "").replace(header, `${header}${add}`) };
		};
		const cases: [string, Record<string, string>][] = [
			["another file", plant("/services/leak.ts", 'await fetch("https://x.example/");')],
			[
				"a second call inside the transport function",
				inside(
					"/index.ts",
					"async function request(path: string, options?: RequestInit) {",
					'\n\tvoid fetch("https://x.example/");',
				),
			],
			[
				"a second call inside the observer's post",
				inside(
					"/services/codex-observer.ts",
					"const res = await fetchImpl(",
					'"https://x.example/", {});\n\tawait fetchImpl(',
				),
			],
			["a fetch property", plant("/services/leak.ts", "void ctx.fetch(url);")],
			[
				"the transport call moved out of the transport function",
				{
					...real,
					"/index.ts": (real["/index.ts"] ?? "").replace(
						"async function request(path: string, options?: RequestInit) {",
						"async function send(path: string, options?: RequestInit) {",
					),
				},
			],
			[
				"the observer's post call moved out of its post function",
				{
					...real,
					"/services/codex-observer.ts": (real["/services/codex-observer.ts"] ?? "").replace(
						"async function postHook(",
						"async function relayHook(",
					),
				},
			],
			[
				"the observer's fetch parameter in another file",
				plant("/providers/claude.ts", "const kept = fetchImpl;"),
			],
			[
				"a second default of fetch in the observer",
				plant("/services/codex-observer.ts", "const grab = fetch;"),
			],
			[
				"a concatenated URL in another file",
				plant("/services/leak.ts", 'await fetch(base + "/api/v1/" + "hooks", { method: "POST" });'),
			],
			[
				"a second call in index.ts, outside the transport",
				plant("/index.ts", 'void fetch("https://x.example/");'),
			],
			["globalThis.fetch", plant("/providers/claude.ts", "void globalThis.fetch(url);")],
			["a stored fetch", plant("/providers/claude.ts", "const send = fetch;")],
			[
				"a second post in the observer",
				plant("/services/codex-observer.ts", "await fetchImpl(url, {});"),
			],
			[
				"a network module",
				plant("/providers/claude.ts", 'const https = await import("node:https");'),
			],
			[
				"a static import of a network module",
				plant("/providers/claude.ts", 'import { request } from "node:http";'),
			],
		];
		for (const [label, files] of cases) {
			expect(strayFetchUses(files).length, label).toBeGreaterThan(0);
		}
	});

	test("nothing under src/web can import the evaluator or anything in the supervisor", () => {
		const webDir = join(import.meta.dir, "..", "..", "web");
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (/\.(ts|tsx)$/.test(entry.name)) {
					const text = readFileSync(full, "utf-8");
					if (/from\s+["'][^"']*(exclude-rules|\/supervisor\/)/.test(text)) offenders.push(full);
				}
			}
		};
		walk(webDir);
		expect(offenders).toEqual([]);
	});
});

describe("the terminal bridge script has no way to the network (drift guard)", () => {
	const BRIDGE_PATH = join(
		import.meta.dir,
		"..",
		"..",
		"..",
		"scripts",
		"claude_terminal_bridge.py",
	);

	/** Every ban the script must satisfy: no HTTP library, no inet socket, no endpoint, no URL, no credential name. */
	const BANS: Array<[string, RegExp]> = [
		["urllib", /urllib/],
		["http.client", /http\.client/],
		["requests", /\brequests\b/],
		["httpx", /httpx/],
		["curl", /\bcurl\b/],
		["subprocess curl", /subprocess\.run\(\s*\[\s*["']curl/],
		["AF_INET", /AF_INET/],
		["AF_INET6", /AF_INET6/],
		["socket.create_connection", /socket\.create_connection/],
		["an API path", /\/api\/v1/],
		["a URL", /https?:\/\//],
		["supervisor_token", /supervisor_token/],
		["api_key", /api_key/],
	];

	const violations = (text: string) =>
		BANS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);

	test("the real script contains none of them", () => {
		const text = readFileSync(BRIDGE_PATH, "utf-8");
		expect(violations(text)).toEqual([]);
		// the scan read the real file and it is the bridge: a local socket and its one child are what it uses
		expect(text).toContain("AF_UNIX");
		expect(text).toContain("subprocess.Popen");
		expect(text).toContain("class ReportSpool");
	});

	test("each ban fires on a planted copy: the check is not vacuous", () => {
		const real = readFileSync(BRIDGE_PATH, "utf-8");
		const plants: Array<[string, string]> = [
			["urllib", "import urllib.request"],
			["http.client", "import http.client"],
			["requests", "import requests"],
			["httpx", "import httpx"],
			["curl", "os.system('curl example')"],
			["subprocess curl", 'subprocess.run(["curl", "x"])'],
			["AF_INET", "socket.socket(socket.AF_INET, socket.SOCK_STREAM)"],
			["AF_INET6", "socket.socket(socket.AF_INET6)"],
			["socket.create_connection", "socket.create_connection(('x', 1))"],
			["an API path", 'path = "/api/v1/supervisors"'],
			["a URL", 'url = "https://example.invalid/"'],
			["supervisor_token", 'config.get("supervisor_token")'],
			["api_key", 'config["api_key"]'],
		];
		expect(plants.length).toBe(BANS.length);
		for (const [name, line] of plants) {
			expect(violations(`${real}\n${line}\n`), name).toContain(name);
		}
	});

	/** What the script may import: files, processes, terminals, its own local socket, time. Nothing that speaks a network protocol, loads code by name or reaches native code. */
	const ALLOWED_IMPORTS = new Set([
		"argparse",
		"datetime",
		"json",
		"os",
		"pty",
		"selectors",
		"signal",
		"socket",
		"stat",
		"subprocess",
		"sys",
		"termios",
		"threading",
		"time",
		"tty",
		"uuid",
		"pathlib",
	]);

	/** The only names the script may take from the socket module directly: constants, never a constructor. */
	const ALLOWED_FROM_SOCKET = new Set(["AF_UNIX", "SOCK_STREAM"]);
	const ALLOWED_FROM_OS_SUBPROCESS: Record<string, Set<string>> = {
		os: new Set<string>(),
		subprocess: new Set<string>(["Popen", "PIPE", "DEVNULL"]),
	};

	/** Imports outside the allowlist, calls to `socket.socket` that don't name AF_UNIX, and dynamic loading. */
	const structuralViolations = (text: string): string[] => {
		const found: string[] = [];
		// statements, not lines: `import os; import ftplib` is two imports on one line
		for (const statement of text.split(/[\n;]/)) {
			const from = /^\s*from\s+([\w.]+)\s+import\s+(.*)$/.exec(statement);
			const plain = /^\s*import\s+(.+)$/.exec(statement);
			if (from) {
				const root = (from[1] as string).split(".")[0] as string;
				if (!ALLOWED_IMPORTS.has(root)) found.push(`import of ${from[1]}`);
				if (root === "os" || root === "subprocess") {
					// `from os import system` dodges the `os.system` pattern: only the names the script uses are allowed
					for (const name of (from[2] as string)
						.split(",")
						.map((x) => x.trim().split(/\s+as\s+/)[0])) {
						if (!(ALLOWED_FROM_OS_SUBPROCESS[root] as Set<string>).has(name as string)) {
							found.push(`from ${root} import ${name}`);
						}
					}
				}
				if (root === "socket") {
					for (const name of (from[2] as string)
						.split(",")
						.map((x) => x.trim().split(/\s+as\s+/)[0])) {
						if (!ALLOWED_FROM_SOCKET.has(name as string)) found.push(`from socket import ${name}`);
					}
				}
			} else if (plain) {
				for (const part of (plain[1] as string).split(",")) {
					const module = part.trim().split(/\s+as\s+/)[0] as string;
					const root = module.split(".")[0] as string;
					if (!ALLOWED_IMPORTS.has(root)) found.push(`import of ${module}`);
				}
			}
		}
		for (const m of text.matchAll(/\bos\.(system|popen|exec\w*|spawn\w*|posix_spawn\w*)\b/g)) {
			found.push(`os.${m[1]}`);
		}
		for (const m of text.matchAll(/\bsubprocess\.(?!Popen\b)(\w+)/g)) {
			found.push(`subprocess.${m[1]}`);
		}
		// `import socket as s` would make every later `s.socket(...)` invisible to the checks below
		if (/^\s*import\s+(?:[\w., ]*,\s*)?socket\s+as\s+\w+/m.test(text))
			found.push("import socket as an alias");
		// an alias of the constructor would dodge the AF_UNIX check below
		if (/\bsocket\.socket\b(?!\()/.test(text)) found.push("socket.socket used without a call");
		for (const m of text.matchAll(/\bsocket\.socket\(([^)]*)\)/g)) {
			if (!/\bAF_UNIX\b/.test(m[1] ?? ""))
				found.push(`socket.socket(${m[1]}) does not name AF_UNIX`);
		}
		for (const [name, pattern] of [
			["__import__", /__import__\s*\(/],
			["importlib", /\bimportlib\b/],
			["exec", /\bexec\s*\(/],
			["eval", /\beval\s*\(/],
			["ctypes", /\bctypes\b/],
			["socket.create_server", /socket\.create_server/],
			["getaddrinfo", /getaddrinfo|gethostbyname/],
			["socket.fromfd", /socket\.fromfd/],
		] as const) {
			if (pattern.test(text)) found.push(name);
		}
		return found;
	};

	test("the real script's imports are all on the allowlist and every socket it makes is a Unix socket", () => {
		const text = readFileSync(BRIDGE_PATH, "utf-8");
		expect(structuralViolations(text)).toEqual([]);
		// the check saw what it is meant to: the script does import socket and does make a socket
		expect(text).toMatch(/^import socket$/m);
		expect(text).toMatch(/socket\.socket\(socket\.AF_UNIX/);
	});

	test("each structural rule fires on a planted copy", () => {
		const real = readFileSync(BRIDGE_PATH, "utf-8");
		const plants: Array<[string, string]> = [
			["import of http.server", "import http.server"],
			["import of asyncio", "import asyncio"],
			["import of ssl", "import json, ssl"],
			["import of urllib", "from urllib import parse"],
			["import of ftplib", "import ftplib as f"],
			["import of ftplib", "import os, ftplib"],
			["import of ftplib", "import os; import ftplib"],
			["from socket import socket", "from socket import socket"],
			["from socket import create_connection", "from socket import AF_UNIX, create_connection"],
			["socket.socket used without a call", "make = socket.socket"],
			["from os import system", "from os import system"],
			["from os import popen", "from os import path, popen"],
			["from subprocess import run", "from subprocess import run"],
			["from subprocess import check_output", "from subprocess import Popen, check_output"],
			["import socket as an alias", "import socket as s"],
			["os.system", "os.system('curl x')"],
			["os.popen", "os.popen('curl x')"],
			["os.execvp", "os.execvp('curl', ['curl'])"],
			["os.spawnl", "os.spawnl(os.P_WAIT, 'curl')"],
			["subprocess.run", "subprocess.run(['curl', 'x'])"],
			["subprocess.check_output", "subprocess.check_output(['curl'])"],
			["subprocess.getoutput", "subprocess.getoutput('curl x')"],
			["import of ctypes", "import ctypes"],
			["socket.socket() does not name AF_UNIX", "s = socket.socket()"],
			[
				"socket.socket(socket.AF_INET, socket.SOCK_STREAM) does not name AF_UNIX",
				"s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
			],
			[
				"socket.socket(socket.SOCK_STREAM) does not name AF_UNIX",
				"s = socket.socket(socket.SOCK_STREAM)",
			],
			["__import__", "m = __import__('urllib.request')"],
			["importlib", "x = importlib.import_module('http')"],
			["exec", "exec('import urllib')"],
			["eval", "eval('1')"],
			["socket.create_server", "socket.create_server(('', 1))"],
			["getaddrinfo", "socket.getaddrinfo('x', 1)"],
			["socket.fromfd", "socket.fromfd(3, 1, 1)"],
		];
		for (const [expected, line] of plants) {
			expect(structuralViolations(`${real}\n${line}\n`), line).toContain(expected);
		}
	});

	test("the TypeScript that drains the spool is inside the scanned set and holds no request or fetch", () => {
		const files = Object.keys(
			Object.fromEntries(
				readdirSync(join(import.meta.dir, ".."), {
					recursive: true,
					withFileTypes: false,
				} as never).map((name) => [String(name), true]),
			),
		);
		for (const named of [
			"services/bridge-spool.ts",
			"services/report-outbox.ts",
			"services/fatal-exit.ts",
			"services/keep-alive.ts",
		]) {
			expect(files, named).toContain(named);
			const code = readFileSync(join(import.meta.dir, "..", named), "utf-8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^\s*\/\/.*$/gm, "");
			expect(code, named).not.toMatch(/\bfetch\b|(?<![.\w])request\b/);
			expect(code, named).not.toMatch(
				/managed-session-state|managed-sessions\/|control-actions|launches\//,
			);
		}
	});
});

describe("approvals through the gate", () => {
	const reportBody = (over: Record<string, unknown> = {}) =>
		({
			v: 1,
			runtimeEpoch: "epoch-1",
			rpcId: "0",
			requestKind: "command",
			threadId: "t",
			turnId: "u",
			itemId: "i",
			providerApprovalId: null,
			ageMs: 0,
			revision: 1,
			command: "ls",
			cwd: work,
			reason: null,
			grantRoot: null,
			truncated: false,
			declineOnly: [],
			...over,
		}) as never;

	const SERVER_OK_STATE = {
		session: { displayName: "from-server" },
		managedSession: {},
		events: [],
	};
	const answerBody = { v: 1 as const, approvalId: "ap-1", revision: 1, expiresInMs: 5 };
	const syncAnswer = { v: 1, answers: [], closed: [], ack: [] };

	function approvalGate(respond: (call: Call) => unknown, withOutbox = false) {
		const calls: Call[] = [];
		const headers: Array<Record<string, string> | undefined> = [];
		const request = async (path: string, options?: RequestInit) => {
			const call: Call = {
				path,
				method: options?.method ?? "GET",
				body: options?.body ? JSON.parse(String(options.body)) : undefined,
			};
			calls.push(call);
			headers.push(options?.headers as Record<string, string> | undefined);
			return respond(call);
		};
		const outbox = withOutbox
			? createReportOutbox({ home, supervisorId: SUPERVISOR_ID, now: () => clock })
			: undefined;
		const gate = createReportGate({
			request,
			supervisorId: SUPERVISOR_ID,
			home,
			version: "9.9.9",
			now: () => clock,
			outbox,
		});
		return { gate, calls, headers, outbox };
	}

	test("approval report never queues: with the server unreachable it throws, latches offline and keeps nothing", async () => {
		let down = false;
		const { gate, outbox } = approvalGate(() => {
			if (down) throw new SupervisorNetworkError();
			return SERVER_OK_STATE;
		}, true);
		await startSession(gate, "sess-1", work);
		down = true;
		const before = outbox?.summary().pending ?? 0;

		await expect(gate.reportApproval("sess-1", reportBody())).rejects.toBeInstanceOf(
			SupervisorNetworkError,
		);

		expect(gate.isOffline()).toBe(true);
		await expect(gate.reportApproval("sess-1", reportBody({ rpcId: "1" }))).rejects.toBeDefined();
		await expect(
			gate.syncApprovals({
				live: [{ sessionId: "sess-1", approvalId: "a", revision: 1 }],
				resolved: [],
			}),
		).rejects.toBeDefined();
		expect(outbox?.summary().pending ?? 0).toBe(before);
	});

	test("approval report never queues: a report goes to its own path, is never a replay, and returns the server's answer", async () => {
		const { gate, calls, headers } = approvalGate(() => answerBody);
		gate.noteCwd("sess-1", work);

		const result = await gate.reportApproval("sess-1", reportBody());

		expect(result).toEqual({ outcome: "sent", response: answerBody });
		expect(paths(calls)).toEqual([`POST ${BASE}/managed-sessions/sess-1/approvals`]);
		expect(headers[0]).toBeUndefined();
	});

	test("approval report never queues: an excluded or blocked session sends nothing", async () => {
		const { gate, calls } = approvalGate(() => answerBody);
		gate.noteCwd("sess-1", work);
		writeRules([work]);
		expect(await gate.reportApproval("sess-1", reportBody())).toEqual({ outcome: "excluded" });
		writeRules(["not a rule line ~~~ [invalid"]);
		const blocked = await gate.reportApproval("sess-1", reportBody());
		// Rules that can't be read are not "no match": the session is held, not judged covered.
		expect(blocked).toEqual({ outcome: "blocked" });
		expect(calls).toEqual([]);
	});

	test("approval report never queues: an answer that isn't the contract is a server fault, not a delivery", async () => {
		const { gate } = approvalGate(() => ({ v: 2, approvalId: "x" }));
		gate.noteCwd("sess-1", work);

		const error = await gate.reportApproval("sess-1", reportBody()).catch((e) => e);

		expect(error).toBeInstanceOf(SupervisorRequestError);
		expect((error as SupervisorRequestError).status).toBe(502);
		expect(gate.isOffline()).toBe(false);
	});

	test("the poll drops excluded sessions from its body and sends nothing when nothing is left", async () => {
		const { gate, calls } = approvalGate(() => syncAnswer);
		gate.noteCwd("open", elsewhere);
		gate.noteCwd("secret", work);
		writeRules([work]);

		const sent = await gate.syncApprovals({
			live: [
				{ sessionId: "open", approvalId: "a", revision: 1 },
				{ sessionId: "secret", approvalId: "b", revision: 1 },
			],
			resolved: [
				{
					sessionId: "secret",
					approvalId: "b",
					outcome: "declined_local",
					sentDecision: "decline",
				},
				{ sessionId: "open", approvalId: "a", outcome: "respond_sent", sentDecision: "accept" },
			],
		});

		expect(sent.outcome).toBe("sent");
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe(`${BASE}/approvals/sync`);
		expect(calls[0].body).toEqual({
			v: 1,
			live: [{ approvalId: "a", revision: 1 }],
			resolved: [{ approvalId: "a", outcome: "respond_sent", sentDecision: "accept" }],
		});
		const none = await gate.syncApprovals({
			live: [{ sessionId: "secret", approvalId: "b", revision: 1 }],
			resolved: [],
		});
		expect(none).toEqual({ outcome: "empty" });
		expect(calls).toHaveLength(1);
	});

	test("the poll gives up on a server that doesn't answer within its limit, as a network failure", async () => {
		const { gate } = approvalGate(() => new Promise(() => {}));
		gate.noteCwd("open", elsewhere);
		const realSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
			realSetTimeout(fn, ms === 10_000 ? 5 : ms, ...rest)) as typeof setTimeout;
		try {
			const error = await gate
				.syncApprovals({
					live: [{ sessionId: "open", approvalId: "a", revision: 1 }],
					resolved: [],
				})
				.catch((e) => e);
			expect(error).toBeInstanceOf(SupervisorNetworkError);
			expect(gate.isOffline()).toBe(true);
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
	});

	test("a path is judged against the local rules: excluded when covered or when the rules can't be trusted", () => {
		const { gate } = approvalGate(() => answerBody);
		expect(gate.excludesPath(work)).toBe(false);
		writeRules([work]);
		expect(gate.excludesPath(join(work, "sub", "file.txt"))).toBe(true);
		expect(gate.excludesPath(elsewhere)).toBe(false);
	});
});

describe("tool-call detail through the gate (AGEN-123)", () => {
	const body = {
		v: 1 as const,
		calls: [
			{
				toolUseId: "toolu_1",
				turnActionId: "act-1",
				tool: "Bash",
				outcome: "unasked",
				fromSubagent: false,
				input: "{}",
				inputTruncated: false,
				output: "ok",
				outputTruncated: false,
			},
		],
	};

	function toolGate(respond: (call: Call) => unknown = () => ({ stored: 1, dropped: 0 })) {
		const calls: Call[] = [];
		const headers: Array<Record<string, string> | undefined> = [];
		const outbox = createReportOutbox({ home, supervisorId: SUPERVISOR_ID, now: () => clock });
		const gate = createReportGate({
			request: async (path: string, options?: RequestInit) => {
				const call: Call = {
					path,
					method: options?.method ?? "GET",
					body: options?.body ? JSON.parse(String(options.body)) : undefined,
				};
				calls.push(call);
				headers.push(options?.headers as Record<string, string> | undefined);
				return respond(call);
			},
			supervisorId: SUPERVISOR_ID,
			home,
			version: "9.9.9",
			now: () => clock,
			outbox,
		});
		return { gate, calls, headers, outbox };
	}

	test("a session no rule covers goes to its own path, as itself: no replay header, nothing queued", async () => {
		const { gate, calls, headers, outbox } = toolGate();
		gate.noteCwd("sess-1", work);
		expect(await gate.reportToolCalls("sess-1", body)).toEqual({ outcome: "sent" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe(`${BASE}/managed-sessions/sess-1/tool-calls`);
		expect(calls[0]?.body).toEqual(body);
		expect(headers[0]).toBeUndefined();
		expect(outbox.summary().pending).toBe(0);
	});

	test("a rule added mid-turn that now covers the session withholds everything; invalid rules send nothing", async () => {
		const { gate, calls } = toolGate();
		gate.noteCwd("sess-1", work);
		expect(await gate.reportToolCalls("sess-1", body)).toEqual({ outcome: "sent" });
		writeRules([work]);
		expect(await gate.reportToolCalls("sess-1", body)).toEqual({ outcome: "excluded" });
		writeRules(["not a rule line ~~~ [invalid"]);
		expect(await gate.reportToolCalls("sess-1", body)).toEqual({ outcome: "blocked" });
		expect(calls).toHaveLength(1);
	});

	test("with the server unreachable it throws, latches offline and keeps nothing", async () => {
		const { gate, outbox } = toolGate(() => {
			throw new SupervisorNetworkError();
		});
		gate.noteCwd("sess-1", work);
		await expect(gate.reportToolCalls("sess-1", body)).rejects.toBeInstanceOf(
			SupervisorNetworkError,
		);
		expect(gate.isOffline()).toBe(true);
		expect(outbox.summary().pending).toBe(0);
	});

	test("the endpoint path is in the gate and appears nowhere else under src/supervisor (the drift list has it)", () => {
		expect(SESSION_DATA_FRAGMENTS.map(([name]) => name)).toContain(
			"managed-sessions/<id>/tool-calls",
		);
	});
});
