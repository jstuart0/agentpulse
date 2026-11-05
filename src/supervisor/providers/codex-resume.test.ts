/**
 * Resuming a Codex thread on this host (AGEN-115, phase 3): the wire sequence, the order of every check, what
 * each failure kind leaves behind, and what the resumed runtime does afterwards. A fake `codex app-server`
 * over real stdio, built from answers recorded from Codex 0.163.0, with its default answer (never +
 * dangerFullAccess, the thread's recorded policy) deliberately different from every value under test.
 *
 * D9's branch (measured in codex-resume.real.test.ts, 2026-11-05, Codex 0.163.0): a project's
 * `.codex/config.toml` APPLIES only when the user's own config marks the directory trusted, and then its
 * MCP servers start at `thread/resume` and its sandbox extras show in the answer. So the branch is ON: a
 * takeover refuses `project_config` for an untrusted directory that has the file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireLaunchPrivileges } from "../../shared/launch-privileges.js";
import type { ReportOutcome } from "../services/report-gate.js";
import { isObserverHeld } from "../services/session-resume.js";
import { installFakeCodex, readFakeLog } from "./__fixtures__/fake-codex.js";
import { assertCodexThreadPrivileges } from "./codex-managed.js";
import {
	hasManagedCodexRuntime,
	launchManagedCodexRequest,
	promptManagedCodexSession,
	reconcileManagedCodexTitles,
	resumeManagedCodexSession,
	stopManagedCodexSession,
} from "./codex-managed.js";
import { CodexResumeError, type CodexResumeKind } from "./codex-shared.js";

const THREAD = "01a1ab40-0000-7000-8000-000000000001";
const SESSION = THREAD;
const LAUNCH = "launch-1";

let root: string;
let work: string;
let neutral: string;
let codexHome: string;
let logPath: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
	"HOME",
	"CODEX_HOME",
	"AGENTPULSE_CODEX_COMMAND",
	"AGENTPULSE_SUPERVISOR_DRY_RUN",
	"FAKE_CODEX_LOG",
	"FAKE_CODEX_VERSION",
	"FAKE_CODEX_THREAD_ID",
	"FAKE_CODEX_THREAD_CWD",
	"FAKE_CODEX_THREAD_ORIGINATOR",
	"FAKE_CODEX_RESUME_CWD",
	"FAKE_CODEX_READ_ERROR",
	"FAKE_CODEX_RESUME_ERROR",
	"FAKE_CODEX_READ_SILENT",
	"FAKE_CODEX_RESUME_SILENT",
	"FAKE_CODEX_RESUME_FORCE_APPROVAL",
	"FAKE_CODEX_RESUME_FORCE_SANDBOX",
	"FAKE_CODEX_SANDBOX_EXTRAS",
	"FAKE_CODEX_LOCK_FILE",
	"FAKE_CODEX_REQUESTS_ON_READ",
	"FAKE_CODEX_REQUESTS_ON_RESUME",
	"FAKE_CODEX_SANDBOX_OMIT",
	"FAKE_CODEX_EARLY_EXIT",
	"FAKE_CODEX_IGNORE_STDIN_CLOSE",
	"FAKE_CODEX_IGNORE_TERM",
];

beforeAll(() => {
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	root = realpathSync(mkdtempSync(join(tmpdir(), "ap-resume-")));
	work = join(root, "work");
	neutral = join(root, "neutral");
	codexHome = join(root, "codex-home");
	for (const dir of [work, neutral, codexHome]) mkdirSync(dir, { recursive: true });
	logPath = join(root, "fake.log");
	process.env.HOME = root;
	process.env.CODEX_HOME = codexHome;
	process.env.AGENTPULSE_CODEX_COMMAND = installFakeCodex(root);
	process.env.AGENTPULSE_SUPERVISOR_DRY_RUN = "false";
	process.env.FAKE_CODEX_LOG = logPath;
});
afterAll(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
	rmSync(logPath, { force: true });
	for (const key of ENV_KEYS.filter((k) => k.startsWith("FAKE_CODEX_") && k !== "FAKE_CODEX_LOG")) {
		delete process.env[key];
	}
	process.env.FAKE_CODEX_VERSION = "0.163.0";
	process.env.FAKE_CODEX_THREAD_ID = THREAD;
	process.env.FAKE_CODEX_THREAD_CWD = work;
	rmSync(join(work, ".codex"), { recursive: true, force: true });
	rmSync(join(codexHome, "config.toml"), { force: true });
});
afterEach(async () => {
	await stopManagedCodexSession(SESSION).catch(() => undefined);
});

interface World {
	calls: string[];
	/** The fake's received methods, snapshotted as each callback ran. */
	seen: Record<string, string[]>;
	states: Array<Record<string, unknown>>;
	runtimeAtReport: boolean[];
	callbacks: Parameters<typeof resumeManagedCodexSession>[1];
}

function world(over: Partial<Record<string, unknown>> = {}): World {
	const calls: string[] = [];
	const states: Array<Record<string, unknown>> = [];
	const runtimeAtReport: boolean[] = [];
	const seen: Record<string, string[]> = {};
	const snap = (name: string) => {
		seen[name] = methods();
	};
	const callbacks = {
		reportState: async () => ({ session: { displayName: "n" }, managedSession: {} }),
		reportEvents: async () => "sent",
		neutralCwd: async () => {
			calls.push("neutralCwd");
			return neutral;
		},
		noteLaunch: (_l: string, _s: string, _c: string) => {
			calls.push("noteLaunch");
			snap("noteLaunch");
			return true;
		},
		verdict: () => {
			calls.push("verdict");
			return "send";
		},
		verdictForDirectory: () => {
			calls.push("verdictForDirectory");
			return "send";
		},
		forgetLaunch: () => {
			calls.push("forgetLaunch");
		},
		reportResumeState: async (body: Record<string, unknown>): Promise<ReportOutcome> => {
			calls.push("reportResumeState");
			snap("reportResumeState");
			states.push(body);
			runtimeAtReport.push(hasManagedCodexRuntime(SESSION));
			return "sent";
		},
		recordThread: () => {
			calls.push("recordThread");
			snap("recordThread");
		},
		trustedRoots: [root],
		...over,
	};
	return { calls, seen, states, runtimeAtReport, callbacks: callbacks as never };
}

function input(over: Partial<Parameters<typeof resumeManagedCodexSession>[0]> = {}) {
	return {
		sessionId: SESSION,
		launchRequestId: LAUNCH,
		threadId: THREAD,
		candidateCwd: work,
		privileges: requireLaunchPrivileges("codex_cli", "untrusted", "workspace-write"),
		resumeKind: "takeover" as const,
		resumeActionId: "act-1",
		sessionName: "refactor the parser",
		...over,
	};
}

async function kindOf(promise: Promise<unknown>): Promise<CodexResumeKind | "ok"> {
	try {
		await promise;
		return "ok";
	} catch (error) {
		if (error instanceof CodexResumeError) return error.kind;
		throw error;
	}
}

function methods() {
	return readFakeLog(logPath)
		.filter((entry) => entry.method)
		.map((entry) => entry.method as string);
}
function fakePid(): number | undefined {
	return readFakeLog(logPath).find((entry) => entry.pid)?.pid;
}
async function processGone(pid: number | undefined) {
	if (pid === undefined) return;
	for (let i = 0; i < 100; i++) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await Bun.sleep(25);
	}
	throw new Error(`process ${pid} is still alive`);
}

describe("the wire sequence and the success path", () => {
	test("thread/read then thread/resume, params exactly those, never a cwd; the fake's recorded policy is not what comes back", async () => {
		const w = world();
		const result = await resumeManagedCodexSession(input(), w.callbacks);

		const log = readFakeLog(logPath);
		const read = log.find((e) => e.method === "thread/read");
		const resume = log.find((e) => e.method === "thread/resume");
		expect(methods().filter((m) => m.startsWith("thread/"))).toEqual([
			"thread/read",
			"thread/resume",
		]);
		expect(Object.keys(read?.params).sort()).toEqual(["includeTurns", "threadId"]);
		expect(read?.params).toEqual({ threadId: THREAD, includeTurns: false });
		expect(Object.keys(resume?.params).sort()).toEqual([
			"approvalPolicy",
			"excludeTurns",
			"sandbox",
			"threadId",
		]);
		expect(resume?.params).toEqual({
			threadId: THREAD,
			excludeTurns: true,
			approvalPolicy: "untrusted",
			sandbox: "workspace-write",
		});
		expect(result.pid).toBeGreaterThan(0);
		expect(hasManagedCodexRuntime(SESSION)).toBe(true);
	});

	test("the app-server starts in the fixed empty directory, not the project's or the supervisor's", async () => {
		await resumeManagedCodexSession(input(), world().callbacks);
		const started = readFakeLog(logPath).find((entry) => entry.argv);
		expect(started?.cwd).toBe(neutral);
		expect(started?.cwd).not.toBe(work);
		expect(started?.cwd).not.toBe(process.cwd());
	});

	test("the order: neutral directory, note the launch, judge the session, resume, report, then record", async () => {
		const w = world();
		await resumeManagedCodexSession(input(), w.callbacks);
		const order = w.calls.filter((c) => c !== "verdictForDirectory");
		expect(order.indexOf("neutralCwd")).toBeLessThan(order.indexOf("noteLaunch"));
		expect(order.indexOf("noteLaunch")).toBeLessThan(order.indexOf("verdict"));
		expect(order.indexOf("verdict")).toBeLessThan(order.indexOf("reportResumeState"));
		expect(order.indexOf("reportResumeState")).toBeLessThan(order.indexOf("recordThread"));
		expect(w.calls).not.toContain("forgetLaunch");
	});

	test("the state report: managed, idle, synced, both ids, the flag and the action id; the runtime joins only after it was sent", async () => {
		const w = world();
		await resumeManagedCodexSession(input(), w.callbacks);
		expect(w.states).toHaveLength(1);
		expect(w.states[0]).toMatchObject({
			sessionId: SESSION,
			launchRequestId: LAUNCH,
			managedState: "managed",
			status: "idle",
			providerSyncState: "synced",
			providerThreadId: THREAD,
			clearProviderSyncError: true,
			resumeActionId: "act-1",
		});
		expect(w.states[0].providerCapabilitySnapshot).toBeDefined();
		expect(w.runtimeAtReport).toEqual([false]);
		expect(hasManagedCodexRuntime(SESSION)).toBe(true);
	});

	test("a takeover's first report doesn't rename the person's thread: no thread/name/set, even when reconcile runs", async () => {
		const w = world();
		await resumeManagedCodexSession(input({ sessionName: "refactor the parser" }), w.callbacks);
		// listManagedSessionsNeedingSync hands reconcile the server's row: its desired title is the session's name.
		await reconcileManagedCodexTitles(
			[
				{
					sessionId: SESSION,
					launchRequestId: LAUNCH,
					desiredThreadTitle: "refactor the parser",
				} as never,
			],
			(async () => ({})) as never,
		);
		expect(methods()).not.toContain("thread/name/set");
		expect(w.states[0].desiredThreadTitle).toBeUndefined();
		expect(w.states[0].providerThreadTitle).toBeUndefined();
	});

	test("afterwards a prompt starts a turn with exactly {threadId, input}, and Stop disposes the process", async () => {
		const w = world();
		const { pid } = await resumeManagedCodexSession(input(), w.callbacks);
		await promptManagedCodexSession({ sessionId: SESSION, prompt: "hello" }, {
			reportState: w.callbacks.reportState,
			reportEvents: w.callbacks.reportEvents,
		} as never);
		const turn = readFakeLog(logPath).find((e) => e.method === "turn/start");
		expect(Object.keys(turn?.params).sort()).toEqual(["input", "threadId"]);
		await stopManagedCodexSession(SESSION);
		await processGone(pid);
		expect(hasManagedCodexRuntime(SESSION)).toBe(false);
	});
});

describe("the directory", () => {
	test("a thread whose current directory is not the candidate: cwd_mismatch, thread/resume never sent, process gone, nothing reported or forgotten", async () => {
		const other = join(root, "other");
		mkdirSync(other, { recursive: true });
		process.env.FAKE_CODEX_THREAD_CWD = other;
		const w = world();
		expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks))).toBe("cwd_mismatch");
		expect(methods()).not.toContain("thread/resume");
		await processGone(fakePid());
		expect(w.states).toEqual([]);
		expect(w.calls).not.toContain("noteLaunch");
		expect(w.calls).not.toContain("forgetLaunch");
		expect(hasManagedCodexRuntime(SESSION)).toBe(false);
	});

	test("a symlink resolving to the candidate passes", async () => {
		const link = join(root, "link-to-work");
		try {
			rmSync(link, { force: true });
			require("node:fs").symlinkSync(work, link);
		} catch {}
		process.env.FAKE_CODEX_THREAD_CWD = link;
		expect(await kindOf(resumeManagedCodexSession(input(), world().callbacks))).toBe("ok");
	});

	test.each([
		["is excluded", "excluded"],
		["is blocked by invalid rules", "blocked"],
	])(
		"a real directory that %s is refused with no resume, even when the candidate was allowed",
		async (_name, verdict) => {
			const w = world({ verdictForDirectory: () => verdict });
			expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks))).toBe("cwd_mismatch");
			expect(methods()).not.toContain("thread/resume");
		},
	);

	test("a real directory outside the trusted roots or missing is refused with no resume", async () => {
		for (const dir of [tmpdir(), join(root, "does-not-exist")]) {
			process.env.FAKE_CODEX_THREAD_CWD = dir;
			rmSync(logPath, { force: true });
			const w = world({ trustedRoots: [join(root, "elsewhere")] });
			expect(
				await kindOf(resumeManagedCodexSession(input({ candidateCwd: dir }), w.callbacks)),
			).toBe("cwd_mismatch");
			expect(methods()).not.toContain("thread/resume");
		}
	});

	test("the answered directory is compared again after the resume: a differing answer fails and disposes", async () => {
		const other = join(root, "other");
		mkdirSync(other, { recursive: true });
		process.env.FAKE_CODEX_RESUME_CWD = other;
		const w = world();
		expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks))).toBe("cwd_mismatch");
		await processGone(fakePid());
		expect(w.states).toEqual([]);
		expect(w.calls).toContain("forgetLaunch");
	});

	test("noteLaunch false refuses before anything attaches; a verdict that isn't send refuses too", async () => {
		const w1 = world({ noteLaunch: () => false });
		expect(await kindOf(resumeManagedCodexSession(input(), w1.callbacks))).toBe("rejected");
		expect(methods()).not.toContain("thread/resume");
		rmSync(logPath, { force: true });
		const w2 = world({ verdict: () => "excluded" });
		expect(await kindOf(resumeManagedCodexSession(input(), w2.callbacks))).toBe("rejected");
		expect(methods()).not.toContain("thread/resume");
		expect(w2.calls).toContain("forgetLaunch");
	});

	test("a neutral directory that can't be used refuses before any spawn", async () => {
		const w = world({
			neutralCwd: async () => {
				throw new CodexResumeError("rejected", "not empty");
			},
		});
		expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks))).toBe("rejected");
		expect(readFakeLog(logPath)).toEqual([]);
	});
});

describe("failures from Codex", () => {
	test.each([["thread not loaded: x"], ["something else entirely, reworded"]])(
		"thread/read failing is 'missing' whatever the words (%s)",
		async (message) => {
			process.env.FAKE_CODEX_READ_ERROR = JSON.stringify({ code: -32600, message });
			const w = world();
			expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks))).toBe("missing");
			expect(methods()).not.toContain("thread/resume");
			await processGone(fakePid());
			expect(w.states).toEqual([]);
		},
	);

	test("an id Codex doesn't know is 'missing'", async () => {
		const w = world();
		expect(
			await kindOf(
				resumeManagedCodexSession(
					input({ threadId: "01a1aaff-0000-7000-8000-000000000000" }),
					w.callbacks,
				),
			),
		).toBe("missing");
	});

	test("a thread/read that never answers is 'timeout', not 'missing'", async () => {
		process.env.FAKE_CODEX_READ_SILENT = "1";
		const w = world();
		expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks, { timeoutMs: 250 }))).toBe(
			"timeout",
		);
		await processGone(fakePid());
	});

	test.each([
		["thread 01a1 already has an active writer", -32600, "running"],
		["Codex says: the thread already has an active writer (reworded)", -32600, "running"],
		["thread already has an active writer", -32000, "rejected"],
		["failed to load configuration", -32600, "rejected"],
		["no rollout found for thread id x", -32600, "rejected"],
	])("thread/resume answering %p (code %i) is %s", async (message, code, kind) => {
		process.env.FAKE_CODEX_RESUME_ERROR = JSON.stringify({ code, message });
		const w = world();
		expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks))).toBe(
			kind as CodexResumeKind,
		);
		await processGone(fakePid());
		expect(w.states).toEqual([]);
		expect(w.calls).toContain("forgetLaunch");
	});

	test("a thread/resume that never answers is 'timeout'", async () => {
		process.env.FAKE_CODEX_RESUME_SILENT = "1";
		const w = world();
		expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks, { timeoutMs: 250 }))).toBe(
			"timeout",
		);
		await processGone(fakePid());
	});

	test("neither text ever leads to a resume: one thread/resume sent, nothing reported, the process disposed", async () => {
		process.env.FAKE_CODEX_RESUME_ERROR = JSON.stringify({
			code: -32600,
			message: "thread x already has an active writer",
		});
		const w = world();
		await kindOf(resumeManagedCodexSession(input(), w.callbacks));
		expect(methods().filter((m) => m === "thread/resume")).toHaveLength(1);
		expect(w.states).toEqual([]);
		await processGone(fakePid());
	});

	test("two supervisors, one account: the second finds the thread held and reports nothing; the first is unaffected", async () => {
		process.env.FAKE_CODEX_LOCK_FILE = join(root, "writer.lock");
		rmSync(process.env.FAKE_CODEX_LOCK_FILE, { force: true });
		const first = world();
		await resumeManagedCodexSession(input(), first.callbacks);
		// A second process (its own fake, sharing the lock file) is another supervisor on the same account.
		const second = world();
		expect(
			await kindOf(
				resumeManagedCodexSession(
					input({ sessionId: "other-session", launchRequestId: "launch-2" }),
					second.callbacks,
				),
			),
		).toBe("running");
		expect(second.states).toEqual([]);
		expect(hasManagedCodexRuntime(SESSION)).toBe(true);
	});
});

describe("privileges", () => {
	test.each([
		["a different approval policy", { FAKE_CODEX_RESUME_FORCE_APPROVAL: "on-request" }],
		["no approvals at all", { FAKE_CODEX_RESUME_FORCE_APPROVAL: "never" }],
		["the wrong sandbox", { FAKE_CODEX_RESUME_FORCE_SANDBOX: "read-only" }],
		["no sandbox", { FAKE_CODEX_RESUME_FORCE_SANDBOX: "danger-full-access" }],
		["an extra key", { FAKE_CODEX_SANDBOX_EXTRAS: JSON.stringify({ extra: true }) }],
		[
			"an extra writable root",
			{ FAKE_CODEX_SANDBOX_EXTRAS: JSON.stringify({ writableRoots: ["/etc"] }) },
		],
		["network access", { FAKE_CODEX_SANDBOX_EXTRAS: JSON.stringify({ networkAccess: true }) }],
		[
			"the tmp directory writable",
			{ FAKE_CODEX_SANDBOX_EXTRAS: JSON.stringify({ excludeSlashTmp: true }) },
		],
	])(
		"an answer with %s is refused 'privileges', the process is disposed and nothing is reported",
		async (_name, env) => {
			Object.assign(process.env, env);
			const w = world();
			expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks))).toBe("privileges");
			await processGone(fakePid());
			expect(w.states).toEqual([]);
			expect(w.calls).toContain("forgetLaunch");
			expect(hasManagedCodexRuntime(SESSION)).toBe(false);
		},
	);

	test("the policy the thread recorded is not the policy asked for (the control for the cases above)", async () => {
		// With no override passed the fake answers never + dangerFullAccess; a provider that passed nothing would fail the assertion.
		const w = world();
		await resumeManagedCodexSession(input(), w.callbacks);
		const resume = readFakeLog(logPath).find((e) => e.method === "thread/resume");
		expect(resume?.params.approvalPolicy).toBe("untrusted");
		expect(resume?.params.approvalPolicy).not.toBe("never");
	});

	test("a recovery with the launch's own read-only policy resumes with those values", async () => {
		const w = world();
		await resumeManagedCodexSession(
			input({
				resumeKind: "recovery",
				privileges: requireLaunchPrivileges("codex_cli", "default", "read-only"),
			}),
			w.callbacks,
		);
		const resume = readFakeLog(logPath).find((e) => e.method === "thread/resume");
		expect(resume?.params).toEqual({ threadId: THREAD, excludeTurns: true, sandbox: "read-only" });
	});
});

describe("reports", () => {
	test.each<ReportOutcome>(["queued", "excluded", "blocked"])(
		"a state report that comes back %s disposes and registers nothing",
		async (outcome) => {
			const w = world({ reportResumeState: async () => outcome });
			expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks))).toBe("rejected");
			await processGone(fakePid());
			expect(hasManagedCodexRuntime(SESSION)).toBe(false);
			expect(w.calls).toContain("forgetLaunch");
		},
	);

	test("a throwing report (the network, session_not_owned) disposes, registers nothing, and is rethrown, not retried", async () => {
		let sends = 0;
		const w = world({
			reportResumeState: async () => {
				sends += 1;
				throw new Error("session_not_owned");
			},
		});
		await expect(resumeManagedCodexSession(input(), w.callbacks)).rejects.toThrow(
			"session_not_owned",
		);
		expect(sends).toBe(1);
		await processGone(fakePid());
		expect(hasManagedCodexRuntime(SESSION)).toBe(false);
	});

	test("the thread record is written only after the report went through, and a throwing record doesn't fail the resume", async () => {
		const w = world({
			recordThread: () => {
				throw new Error("disk full");
			},
		});
		expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks))).toBe("ok");
		const failed = world({ reportResumeState: async () => "blocked" as ReportOutcome });
		const recorded: string[] = [];
		failed.callbacks.recordThread = (() => recorded.push("x")) as never;
		await kindOf(resumeManagedCodexSession(input({ sessionId: "s2" }), failed.callbacks));
		expect(recorded).toEqual([]);
	});
});

describe("the protocol check", () => {
	test("a takeover on a Codex whose shape isn't known is refused before any process starts", async () => {
		process.env.FAKE_CODEX_VERSION = "0.1.0";
		const w = world();
		expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks))).toBe("unsupported_codex");
		expect(
			readFakeLog(logPath).filter(
				(e) => e.argv && !e.argv.includes("--version") && !e.argv.includes("generate-json-schema"),
			),
		).toEqual([]);
	});

	test("a recovery on that Codex proceeds (it declines approvals locally)", async () => {
		process.env.FAKE_CODEX_VERSION = "0.1.0";
		const w = world();
		expect(
			await kindOf(resumeManagedCodexSession(input({ resumeKind: "recovery" }), w.callbacks)),
		).toBe("ok");
	});
});

describe("a recovery with no record of the thread (the pre-upgrade path, P3.11)", () => {
	// Measured on Codex 0.163.0: thread/read answers `originator` as the client's name at thread start;
	// "agentpulse-supervisor" for this supervisor's own client, "codex-tui" / "codex_exec" for others.
	const FAR_FUTURE = Date.parse("2100-01-01T00:00:00Z");
	const asRecovery = (over: Record<string, unknown> = {}) =>
		input({ resumeKind: "recovery", preUpgrade: { createdAtMs: FAR_FUTURE }, ...over });

	test("the supervisor's own originator and a thread older than the record: resumes", async () => {
		process.env.FAKE_CODEX_THREAD_ORIGINATOR = "agentpulse-supervisor";
		expect(await kindOf(resumeManagedCodexSession(asRecovery(), world().callbacks))).toBe("ok");
	});

	test.each([
		["a TUI's originator", { FAKE_CODEX_THREAD_ORIGINATOR: "codex-tui" }, FAR_FUTURE],
		[
			"a thread newer than the record",
			{ FAKE_CODEX_THREAD_ORIGINATOR: "agentpulse-supervisor" },
			1_000,
		],
	])("%s is thread_unverified, with no resume sent", async (_name, env, createdAtMs) => {
		Object.assign(process.env, env);
		const w = world();
		expect(
			await kindOf(
				resumeManagedCodexSession(asRecovery({ preUpgrade: { createdAtMs } }), w.callbacks),
			),
		).toBe("thread_unverified");
		expect(methods()).not.toContain("thread/resume");
		expect(w.states).toEqual([]);
	});

	test("another directory than the launch's is refused by the ordinary directory check", async () => {
		process.env.FAKE_CODEX_THREAD_ORIGINATOR = "agentpulse-supervisor";
		const other = join(root, "other");
		mkdirSync(other, { recursive: true });
		process.env.FAKE_CODEX_THREAD_CWD = other;
		expect(await kindOf(resumeManagedCodexSession(asRecovery(), world().callbacks))).toBe(
			"cwd_mismatch",
		);
	});
});

describe("D7: a project's own .codex/config.toml refuses the resume, trusted or not", () => {
	// Measured (codex-resume.real.test.ts): an untrusted project's file is ignored, a trusted one is applied AND
	// its MCP servers start at thread/resume, before any sandbox comparison could act. Trust is therefore not an
	// allow signal: the file's presence is the refusal, for a takeover and a recovery alike.
	function projectConfig(dir = work) {
		mkdirSync(join(dir, ".codex"), { recursive: true });
		writeFileSync(join(dir, ".codex", "config.toml"), 'sandbox_mode = "workspace-write"\n');
	}
	const trust = () =>
		writeFileSync(
			join(codexHome, "config.toml"),
			`[projects."${work}"]\ntrust_level = "trusted"\n`,
		);

	test.each(["takeover", "recovery"] as const)(
		"a %s into a directory with a project config is project_config, before thread/resume",
		async (resumeKind) => {
			projectConfig();
			const w = world();
			expect(await kindOf(resumeManagedCodexSession(input({ resumeKind }), w.callbacks))).toBe(
				"project_config",
			);
			expect(methods()).not.toContain("thread/resume");
			await processGone(fakePid());
			expect(w.states).toEqual([]);
		},
	);

	test("the user's own trust of the directory changes nothing", async () => {
		projectConfig();
		trust();
		expect(await kindOf(resumeManagedCodexSession(input(), world().callbacks))).toBe(
			"project_config",
		);
		expect(
			await kindOf(resumeManagedCodexSession(input({ resumeKind: "recovery" }), world().callbacks)),
		).toBe("project_config");
	});

	test("passes with no project config", async () => {
		expect(await kindOf(resumeManagedCodexSession(input(), world().callbacks))).toBe("ok");
	});

	test("a dangling symlink, a directory and a FIFO named config.toml all count, and are never read or opened", async () => {
		const { symlinkSync } = require("node:fs");
		const { spawnSync } = require("node:child_process");
		const cases: Array<[string, (path: string) => void]> = [
			["a dangling symlink", (path) => symlinkSync(join(root, "nowhere"), path)],
			["a directory", (path) => mkdirSync(path)],
			["a FIFO", (path) => void spawnSync("mkfifo", [path])],
		];
		for (const [, make] of cases) {
			rmSync(join(work, ".codex"), { recursive: true, force: true });
			mkdirSync(join(work, ".codex"), { recursive: true });
			make(join(work, ".codex", "config.toml"));
			rmSync(logPath, { force: true });
			const began = Date.now();
			expect(await kindOf(resumeManagedCodexSession(input(), world().callbacks))).toBe(
				"project_config",
			);
			// A FIFO opened for reading would block until a writer appears: the refusal is prompt.
			expect(Date.now() - began).toBeLessThan(10_000);
			expect(methods()).not.toContain("thread/resume");
		}
	});

	test("a parent's config counts up to the git root, or the trusted root when there is none; above that it doesn't", async () => {
		// No git root: the trusted root (root) is inclusive.
		projectConfig(root);
		expect(await kindOf(resumeManagedCodexSession(input(), world().callbacks))).toBe(
			"project_config",
		);
		rmSync(join(root, ".codex"), { recursive: true, force: true });

		// A git root at the project: a config above it is not this project's.
		mkdirSync(join(work, ".git"), { recursive: true });
		projectConfig(root);
		expect(await kindOf(resumeManagedCodexSession(input(), world().callbacks))).toBe("ok");
		await stopManagedCodexSession(SESSION).catch(() => undefined);
		rmSync(join(root, ".codex"), { recursive: true, force: true });

		// A git root above the project: a config between them counts.
		rmSync(join(work, ".git"), { recursive: true, force: true });
		const nested = join(work, "pkg");
		mkdirSync(nested, { recursive: true });
		mkdirSync(join(work, ".git"), { recursive: true });
		projectConfig(work);
		process.env.FAKE_CODEX_THREAD_CWD = nested;
		expect(
			await kindOf(resumeManagedCodexSession(input({ candidateCwd: nested }), world().callbacks)),
		).toBe("project_config");
		rmSync(join(work, ".git"), { recursive: true, force: true });
		rmSync(nested, { recursive: true, force: true });
	});
});

describe("the app-server's environment on a resume", () => {
	test("every AGENTPULSE_* name is stripped; everything else (a proxy, a provider key) is kept", async () => {
		process.env.AGENTPULSE_RESUME_TEST_SECRET = "x";
		process.env.RESUME_TEST_HTTPS_PROXY = "http://proxy.invalid";
		try {
			await resumeManagedCodexSession(input(), world().callbacks);
		} finally {
			Reflect.deleteProperty(process.env, "AGENTPULSE_RESUME_TEST_SECRET");
			Reflect.deleteProperty(process.env, "RESUME_TEST_HTTPS_PROXY");
		}
		const names = readFakeLog(logPath).find((e) => e.envNames)?.envNames as string[];
		expect(names.filter((n) => n.startsWith("AGENTPULSE_"))).toEqual([]);
		expect(names).toContain("RESUME_TEST_HTTPS_PROXY");
		expect(names).toContain("PATH");
	});
});

describe("a launch records its thread before its first report (recovery's proof)", () => {
	const launch = () =>
		({
			id: "launch-rec-1",
			launchCorrelationId: crypto.randomUUID(),
			agentType: "codex_cli",
			cwd: work,
			baseInstructions: "",
			taskPrompt: "go",
			model: null,
			approvalPolicy: null,
			sandboxMode: null,
			requestedLaunchMode: "managed_codex",
			env: {},
			launchSpec: {},
			status: "claimed",
		}) as never;

	test("recordThread runs before the first reportState, with the launch id and the thread id", async () => {
		const order: string[] = [];
		const request = launch() as { launchCorrelationId: string };
		await launchManagedCodexRequest(
			request as never,
			{
				recordThread: (launchId: string, threadId: string) =>
					order.push(`record ${launchId} ${threadId}`),
				reportState: async () => {
					order.push("reportState");
					return { session: { displayName: "n" }, managedSession: {} };
				},
				reportEvents: async () => "sent",
			} as never,
		);
		expect(order[0]).toBe("record launch-rec-1 thr-1");
		expect(order.indexOf("reportState")).toBeGreaterThan(0);
		await stopManagedCodexSession(request.launchCorrelationId);
	});

	test("a record that throws doesn't fail the launch", async () => {
		const request = launch() as { launchCorrelationId: string };
		const result = await launchManagedCodexRequest(
			request as never,
			{
				recordThread: () => {
					throw new Error("disk full");
				},
				reportState: async () => ({ session: { displayName: "n" }, managedSession: {} }),
				reportEvents: async () => "sent",
			} as never,
		);
		expect(result.pid).toBeGreaterThan(0);
		await stopManagedCodexSession(request.launchCorrelationId);
	});
});

describe("what the observer holds (D16)", () => {
	test("a launched session's runtime holds its session id and NOT its thread id, so the shadow row's lines still post; a resumed runtime (session = thread) holds both", async () => {
		const launched = {
			id: "launch-hold-1",
			launchCorrelationId: crypto.randomUUID(),
			agentType: "codex_cli",
			cwd: work,
			baseInstructions: "",
			taskPrompt: "go",
			model: null,
			approvalPolicy: null,
			sandboxMode: null,
			requestedLaunchMode: "managed_codex",
			env: {},
			launchSpec: {},
			status: "claimed",
		} as never;
		const sessionId = (launched as { launchCorrelationId: string }).launchCorrelationId;
		await launchManagedCodexRequest(launched, world().callbacks as never);
		const held = (id: string) => isObserverHeld(new Set(), hasManagedCodexRuntime, id);
		expect(held(sessionId)).toBe(true);
		expect(held("thr-1")).toBe(false);
		await stopManagedCodexSession(sessionId);

		await resumeManagedCodexSession(input(), world().callbacks);
		expect(held(SESSION)).toBe(true);
		expect(held(THREAD)).toBe(true);
	});

	test("an id being resumed is held until the resumer lets it go, runtime or not", () => {
		const resuming = new Set([THREAD]);
		expect(isObserverHeld(resuming, () => false, THREAD)).toBe(true);
		expect(isObserverHeld(resuming, () => false, "another")).toBe(false);
	});
});

describe("the order of the steps (D11), observed from inside the callbacks", () => {
	test("at noteLaunch thread/read has been sent and thread/resume has not; at the report thread/resume has", async () => {
		const w = world();
		await resumeManagedCodexSession(input(), w.callbacks);
		expect(w.seen.noteLaunch).toContain("thread/read");
		expect(w.seen.noteLaunch).not.toContain("thread/resume");
		expect(w.seen.reportResumeState).toContain("thread/resume");
		expect(w.seen.recordThread).toContain("thread/resume");
	});

	// Each row: what makes the sequence stop there, and everything that must NOT have happened as a result.
	const STEPS: Array<{
		name: string;
		arrange: (w: World) => World | undefined;
		env?: Record<string, string>;
		kind: CodexResumeKind;
		calls: string[];
		methods: string[];
	}> = [
		{
			name: "the neutral directory",
			arrange: () =>
				world({
					neutralCwd: async () => {
						throw new CodexResumeError("rejected");
					},
				}),
			kind: "rejected",
			calls: [],
			methods: [],
		},
		{
			name: "the protocol check",
			arrange: () => undefined,
			env: { FAKE_CODEX_VERSION: "0.1.0" },
			kind: "unsupported_codex",
			calls: ["neutralCwd"].slice(1),
			methods: [],
		},
		{
			name: "thread/read",
			arrange: () => undefined,
			env: {
				FAKE_CODEX_READ_ERROR: JSON.stringify({ code: -32600, message: "thread not loaded: x" }),
			},
			kind: "missing",
			calls: ["neutralCwd"],
			methods: ["initialize", "thread/read"],
		},
		{
			name: "the real directory",
			arrange: () => world({ verdictForDirectory: () => "excluded" }),
			kind: "cwd_mismatch",
			calls: ["neutralCwd", "verdictForDirectory"],
			methods: ["initialize", "thread/read"],
		},
		{
			name: "noting the launch",
			arrange: () => world({ noteLaunch: () => false }),
			kind: "rejected",
			calls: ["neutralCwd", "verdictForDirectory"],
			methods: ["initialize", "thread/read"],
		},
		{
			name: "the gate's verdict",
			arrange: () => world({ verdict: () => "excluded" }),
			kind: "rejected",
			calls: ["neutralCwd", "verdictForDirectory", "noteLaunch", "forgetLaunch"],
			methods: ["initialize", "thread/read"],
		},
		{
			name: "thread/resume",
			arrange: () => undefined,
			env: {
				FAKE_CODEX_RESUME_ERROR: JSON.stringify({ code: -32600, message: "no rollout found" }),
			},
			kind: "rejected",
			calls: ["neutralCwd", "verdictForDirectory", "noteLaunch", "verdict", "forgetLaunch"],
			methods: ["initialize", "thread/read", "thread/resume"],
		},
		{
			name: "the answer's privileges",
			arrange: () => undefined,
			env: { FAKE_CODEX_RESUME_FORCE_APPROVAL: "never" },
			kind: "privileges",
			calls: ["neutralCwd", "verdictForDirectory", "noteLaunch", "verdict", "forgetLaunch"],
			methods: ["initialize", "thread/read", "thread/resume"],
		},
		{
			name: "the state report",
			arrange: () => world({ reportResumeState: async () => "blocked" }),
			kind: "rejected",
			calls: ["neutralCwd", "verdictForDirectory", "noteLaunch", "verdict", "forgetLaunch"],
			methods: ["initialize", "thread/read", "thread/resume"],
		},
	];

	test.each(STEPS.map((step) => [step.name, step] as const))(
		"a failure at %s leaves nothing later observed",
		async (_name, step) => {
			Object.assign(process.env, step.env ?? {});
			const w = step.arrange(world()) ?? world();
			expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks))).toBe(step.kind);
			const wanted = step.calls.filter((c) => c !== "verdictForDirectory");
			const seenCalls = w.calls.filter((c) => c !== "verdictForDirectory");
			expect(seenCalls).toEqual(wanted);
			expect(
				readFakeLog(logPath)
					.filter((e) => e.method)
					.map((e) => e.method),
			).toEqual(step.methods);
			expect(w.states).toEqual([]);
			expect(w.calls).not.toContain("recordThread");
			expect(hasManagedCodexRuntime(SESSION)).toBe(false);
		},
	);
});

describe("requests Codex raises", () => {
	const REQUEST = [
		{
			method: "item/commandExecution/requestApproval",
			params: { command: "touch x", cwd: "/tmp" },
			id: 77,
		},
	];
	const answerOf = (id: number) => readFakeLog(logPath).find((e) => e.answer?.id === id)?.answer;

	test("one raised during thread/read is default-denied: nothing has claimed it yet", async () => {
		process.env.FAKE_CODEX_REQUESTS_ON_READ = JSON.stringify(REQUEST);
		await resumeManagedCodexSession(input(), world().callbacks);
		for (let i = 0; i < 100 && !answerOf(77); i++) await Bun.sleep(20);
		const answer = answerOf(77);
		expect(answer?.error?.code).toBe(-32601);
		expect(answer?.result).toBeUndefined();
	});

	test("one raised after the resume reaches the tracker, which answers it as a decline (not the default-deny)", async () => {
		process.env.FAKE_CODEX_REQUESTS_ON_RESUME = JSON.stringify(REQUEST);
		await resumeManagedCodexSession(input(), world().callbacks);
		for (let i = 0; i < 100 && !answerOf(77); i++) await Bun.sleep(20);
		const answer = answerOf(77);
		expect(answer?.result?.decision).toBe("decline");
		expect(answer?.error).toBeUndefined();
	});

	test("a recovery on a Codex it can't answer approvals for declines locally, with exactly one warning", async () => {
		process.env.FAKE_CODEX_VERSION = "0.1.0";
		process.env.FAKE_CODEX_REQUESTS_ON_RESUME = JSON.stringify(REQUEST);
		const warnings: unknown[] = [];
		const w = world({
			reportEvents: async (events: Array<{ eventType: string }>) => {
				for (const e of events) if (e.eventType === "ManagedWarning") warnings.push(e);
				return "sent";
			},
		});
		await resumeManagedCodexSession(input({ resumeKind: "recovery" }), w.callbacks);
		for (let i = 0; i < 100 && !answerOf(77); i++) await Bun.sleep(20);
		expect(answerOf(77)?.result?.decision).toBe("decline");
		await Bun.sleep(150);
		expect(warnings).toHaveLength(1);
	});
});

describe("privileges, more", () => {
	test("a missing sandbox key is refused", async () => {
		process.env.FAKE_CODEX_SANDBOX_OMIT = "excludeSlashTmp";
		const w = world();
		expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks))).toBe("privileges");
		expect(w.states).toEqual([]);
	});

	test("non-empty writableRoots are refused", async () => {
		process.env.FAKE_CODEX_SANDBOX_EXTRAS = JSON.stringify({ writableRoots: ["/somewhere"] });
		expect(await kindOf(resumeManagedCodexSession(input(), world().callbacks))).toBe("privileges");
	});

	test.each([
		["a plain read-only answer", {}],
		["network access on", { networkAccess: true }],
		["a writable root", { writableRoots: ["/etc"] }],
	])(
		"a recovery with read-only: the provider's verdict equals assertCodexThreadPrivileges on the same answer (%s)",
		async (_name, extras) => {
			process.env.FAKE_CODEX_SANDBOX_EXTRAS = JSON.stringify(extras);
			const privileges = requireLaunchPrivileges("codex_cli", "default", "read-only");
			let direct: "ok" | "privileges" = "ok";
			try {
				assertCodexThreadPrivileges(
					{
						approvalPolicy: "never",
						sandbox: { type: "readOnly", networkAccess: false, ...extras } as never,
					},
					privileges,
				);
			} catch {
				direct = "privileges";
			}
			const viaProvider = await kindOf(
				resumeManagedCodexSession(input({ resumeKind: "recovery", privileges }), world().callbacks),
			);
			expect(viaProvider).toBe(direct);
		},
	);
});

describe("shutdown: every way out ends the process, checked by the OS", () => {
	test("a spawn error (the neutral directory can't be entered) rejects, with no tracker and no report", async () => {
		const w = world({ neutralCwd: async () => join(root, "no-such-dir") });
		await expect(resumeManagedCodexSession(input(), w.callbacks)).rejects.toThrow();
		expect(w.states).toEqual([]);
		expect(hasManagedCodexRuntime(SESSION)).toBe(false);
	});

	test("a child that exits before initialize rejects, and its process is gone", async () => {
		process.env.FAKE_CODEX_EARLY_EXIT = "3";
		const w = world();
		await expect(resumeManagedCodexSession(input(), w.callbacks)).rejects.toThrow();
		await processGone(fakePid());
		expect(w.states).toEqual([]);
	});

	test("a child that ignores the stdin close is ended by SIGTERM", async () => {
		process.env.FAKE_CODEX_IGNORE_STDIN_CLOSE = "1";
		process.env.FAKE_CODEX_READ_ERROR = JSON.stringify({
			code: -32600,
			message: "thread not loaded: x",
		});
		expect(await kindOf(resumeManagedCodexSession(input(), world().callbacks))).toBe("missing");
		await processGone(fakePid());
		expect(readFakeLog(logPath).some((e) => e.signal === "SIGTERM")).toBe(true);
	}, 30_000);

	test("a child that also ignores SIGTERM is ended by SIGKILL", async () => {
		process.env.FAKE_CODEX_IGNORE_STDIN_CLOSE = "1";
		process.env.FAKE_CODEX_IGNORE_TERM = "1";
		process.env.FAKE_CODEX_READ_ERROR = JSON.stringify({
			code: -32600,
			message: "thread not loaded: x",
		});
		expect(await kindOf(resumeManagedCodexSession(input(), world().callbacks))).toBe("missing");
		await processGone(fakePid());
		expect(readFakeLog(logPath).some((e) => e.signal === "SIGTERM")).toBe(true);
	}, 30_000);
});
