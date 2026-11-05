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
import { installFakeCodex, readFakeLog } from "./__fixtures__/fake-codex.js";
import {
	hasManagedCodexRuntime,
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
	"FAKE_CODEX_RESUME_CWD",
	"FAKE_CODEX_READ_ERROR",
	"FAKE_CODEX_RESUME_ERROR",
	"FAKE_CODEX_READ_SILENT",
	"FAKE_CODEX_RESUME_SILENT",
	"FAKE_CODEX_RESUME_FORCE_APPROVAL",
	"FAKE_CODEX_RESUME_FORCE_SANDBOX",
	"FAKE_CODEX_SANDBOX_EXTRAS",
	"FAKE_CODEX_LOCK_FILE",
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
	states: Array<Record<string, unknown>>;
	runtimeAtReport: boolean[];
	callbacks: Parameters<typeof resumeManagedCodexSession>[1];
}

function world(over: Partial<Record<string, unknown>> = {}): World {
	const calls: string[] = [];
	const states: Array<Record<string, unknown>> = [];
	const runtimeAtReport: boolean[] = [];
	const callbacks = {
		reportState: async () => ({ session: { displayName: "n" }, managedSession: {} }),
		reportEvents: async () => "sent",
		neutralCwd: async () => {
			calls.push("neutralCwd");
			return neutral;
		},
		noteLaunch: (_l: string, _s: string, _c: string) => {
			calls.push("noteLaunch");
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
			states.push(body);
			runtimeAtReport.push(hasManagedCodexRuntime(SESSION));
			return "sent";
		},
		recordThread: () => {
			calls.push("recordThread");
		},
		trustedRoots: [root],
		...over,
	};
	return { calls, states, runtimeAtReport, callbacks: callbacks as never };
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

describe("D9's branch: a project's own .codex/config.toml", () => {
	function projectConfig() {
		mkdirSync(join(work, ".codex"), { recursive: true });
		writeFileSync(join(work, ".codex", "config.toml"), 'sandbox_mode = "workspace-write"\n');
	}
	const trust = () =>
		writeFileSync(
			join(codexHome, "config.toml"),
			`[projects."${work}"]\ntrust_level = "trusted"\n`,
		);

	test("a takeover into a directory with a project config the user hasn't trusted is project_config, before thread/resume", async () => {
		projectConfig();
		const w = world();
		expect(await kindOf(resumeManagedCodexSession(input(), w.callbacks))).toBe("project_config");
		expect(methods()).not.toContain("thread/resume");
		await processGone(fakePid());
	});

	test("passes when the user's own config marks the directory trusted", async () => {
		projectConfig();
		trust();
		expect(await kindOf(resumeManagedCodexSession(input(), world().callbacks))).toBe("ok");
	});

	test("passes with no project config", async () => {
		expect(await kindOf(resumeManagedCodexSession(input(), world().callbacks))).toBe("ok");
	});

	test("a recovery is never refused for it", async () => {
		projectConfig();
		expect(
			await kindOf(resumeManagedCodexSession(input({ resumeKind: "recovery" }), world().callbacks)),
		).toBe("ok");
	});
});
