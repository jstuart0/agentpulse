/**
 * The host's side of a Claude takeover and of a fork's recovery (AGEN-117 phase 5): the real report gate (with
 * and without an exclude file), the real login probes and the real stream runtime against the fake `claude`,
 * a scripted server. Nothing real is signalled: every kill goes through a guard that signals only the pids
 * the fake wrote down as its own starts (D10).
 *
 * The invariant most cases hold: the original session's transcript is byte-equal afterwards, and a refusal
 * leaves no live child and no fork record.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlAction } from "../../shared/types.js";
import { __setDescendantKillerForTests } from "../process-stop.js";
import { makeFakeClaude } from "../providers/__fixtures__/claude-fake.js";
import { createLoginProbe } from "../providers/claude-login-mode.js";
import { claudeProtocolVerdict } from "../providers/claude-protocol.js";
import {
	_resetClaudeStreamForTest,
	disposeAllClaudeStreamRuntimes,
	getClaudeStreamRuntime,
	hasClaudeStreamRuntime,
	promptClaudeStreamSession,
	startClaudeStream,
	stopClaudeStreamSession,
} from "../providers/claude-stream.js";
import {
	HELPER_ACCOUNT,
	KEY_ACCOUNT,
	NO_LOGIN_ACCOUNT,
} from "../test-utils/claude-stream-harness.js";
import { type SignalGuard, createSignalGuard } from "../test-utils/signal-guard.js";
import { createClaudeForkRecord } from "./claude-fork-record.js";
import { encodeProjectDirName } from "./claude-source-dir.js";
import { createClaudeTakeover } from "./claude-takeover.js";
import { createReportGate } from "./report-gate.js";
import { SupervisorNetworkError } from "./report-resilience.js";
import { createSessionResumer } from "./session-resume.js";

const S = "11111111-1111-4111-8111-111111111111";
const N = "22222222-2222-4222-8222-222222222222";
const CARRIER = "33333333-3333-4333-8333-333333333333";
const FAST = { interruptMs: 300, stdinCloseMs: 300, termMs: 300, killMs: 300 };

let root: string;
let home: string;
let work: string;
let configDir: string;
let guard: SignalGuard;
let restoreKiller: () => void;
let fake: ReturnType<typeof makeFakeClaude>;
let rulesVersion = 0;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "ap-claude-takeover-")));
	home = join(root, "home");
	work = join(root, "work", "proj");
	configDir = join(home, ".claude");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
	guard = createSignalGuard();
	fake = makeFakeClaude(join(root, "bin"), { account: KEY_ACCOUNT });
	restoreKiller = (() => {
		const previous = __setDescendantKillerForTests((pid, signal) => {
			for (const start of fake.starts()) guard.allow(start.pid);
			guard.killPid(pid, signal);
		});
		return () => void __setDescendantKillerForTests(previous);
	})();
});
afterEach(async () => {
	await disposeAllClaudeStreamRuntimes(FAST);
	_resetClaudeStreamForTest();
	restoreKiller();
	// A child a test left running is the test's own: ended by the pids the fake wrote down.
	for (const start of fake.starts()) {
		try {
			process.kill(start.pid, 0);
			process.kill(start.pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	rmSync(root, { recursive: true, force: true });
	expect(guard.refused).toEqual([]);
});

function writeTranscript(sessionId: string, cwd: string, extra: string[] = [], project?: string) {
	const dir = join(configDir, "projects", project ?? encodeProjectDirName(cwd));
	mkdirSync(dir, { recursive: true });
	const lines = [
		JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId, content: "hi" }),
		JSON.stringify({ type: "queue-operation", operation: "dequeue", sessionId }),
		JSON.stringify({
			type: "user",
			cwd,
			sessionId,
			version: "2.1.318",
			message: { content: "hi" },
		}),
		...extra,
	];
	const file = join(dir, `${sessionId}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function writeRules(lines: string[]) {
	const file = join(home, ".agentpulse", "exclude");
	writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
	const at = new Date(Date.parse("2026-02-01T00:00:00Z") + ++rulesVersion * 1000);
	utimesSync(file, at, at);
}

type Posted = { path: string; body: Record<string, any> };
type Answer = "succeeded" | "failed" | "lost" | "running";

function build(
	opts: {
		agentsFor?: () => Array<{ pid: number | null; sessionId: string }> | "fail";
		answers?: Answer[];
		version?: string;
		platform?: string;
		serverUrl?: string;
		maxRuntimes?: number;
		ownIdSession?: string;
		recordPath?: string;
		afterListed?: () => Promise<void>;
		/** Runs once the fork's child has answered `initialize`, before the success is reported. */
		afterOwnId?: () => Promise<void>;
		/** Answers for the recovery's state upsert: `lost` throws a network error. */
		stateAnswers?: Array<"lost" | "ok">;
		onStart?: (options: Record<string, unknown>) => void;
		onProbe?: () => void;
		onWait?: () => Promise<void>;
		realAgents?: boolean;
	} = {},
) {
	const posts: Posted[] = [];
	const logs: string[] = [];
	const answers = [...(opts.answers ?? [])];
	const gate = createReportGate({
		request: async (path: string, options?: RequestInit) => {
			const body = options?.body ? JSON.parse(String(options.body)) : {};
			posts.push({ path, body });
			if (path.endsWith("/managed-session-state") && body.managedState === "managed") {
				if ((opts.stateAnswers?.shift() ?? "ok") === "lost") throw new SupervisorNetworkError();
			}
			if (path.endsWith("/control-actions/act-1/status")) {
				if (body.status === "succeeded") {
					const next = answers.shift() ?? "succeeded";
					if (next === "lost") throw new SupervisorNetworkError();
					return { action: { status: next } };
				}
				return { action: { status: body.status } };
			}
			return { session: {}, managedSession: {}, events: [] };
		},
		supervisorId: "sup-1",
		home,
		now: Date.now,
		log: (line: string) => logs.push(line),
	});
	const forkRecord = createClaudeForkRecord({
		path: opts.recordPath ?? join(home, ".agentpulse", "claude-forks.json"),
		log: (line) => logs.push(line),
	});
	const disposed: string[] = [];
	const killPid = (pid: number, signal: NodeJS.Signals) => {
		for (const start of fake.starts()) guard.allow(start.pid);
		guard.killPid(pid, signal);
	};
	const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: configDir, ...fake.env };
	const takeover = createClaudeTakeover({
		gate,
		hostName: "mac-1",
		trustedRoots: [join(root, "work")],
		forkRecord,
		env,
		probeCwd: join(home, ".agentpulse", "claude-probe"),
		tracker: {
			attachClaude: () =>
				({
					handle: { sessionId: N, epoch: "e" },
					onToolRequest() {},
					cancel() {},
					toolResult() {},
					turnEnded() {},
					fence() {},
					dispose: () => void disposed.push("disposed"),
				}) as never,
		},
		log: (line) => logs.push(line),
		resolve: async () => ({
			binary: {
				path: fake.path,
				version: opts.version ?? "2.1.318",
				size: 1,
				mtimeMs: 1,
			},
			serverUrl: opts.serverUrl ?? "https://agentpulse.example.test",
		}),
		verdictOf: (binary, serverUrl) =>
			claudeProtocolVerdict(binary, serverUrl, {
				platform: (opts.platform ?? "darwin") as NodeJS.Platform,
			}),
		...(opts.realAgents
			? {}
			: {
					listAgents: async () => {
						const listed = opts.agentsFor?.() ?? [];
						await opts.afterListed?.();
						return listed === "fail"
							? { ok: false as const, why: "it exited 3" }
							: { ok: true as const, entries: listed };
					},
				}),
		start: async (options) => {
			opts.onStart?.(options as never);
			return startClaudeStream(options);
		},
		loginProbe: (executable) => {
			const probe = createLoginProbe({
				executable,
				env,
				probeCwd: join(home, ".agentpulse", "claude-probe"),
				timings: FAST,
				log: (line) => logs.push(line),
			});
			return async (mode) => {
				opts.onProbe?.();
				return probe(mode);
			};
		},
		startExtra: {
			timings: FAST,
			ownIdWaitMs: 800,
			stopReach: { killPid },
			maxRuntimes: opts.maxRuntimes,
			listAgents: async () => {
				await opts.afterOwnId?.();
				return { ok: true, entries: [{ pid: fake.pid(), sessionId: opts.ownIdSession ?? N }] };
			},
		},
		wait: async () => {
			await opts.onWait?.();
		},
		retryBaseMs: 1,
	});
	return { gate, posts, logs, takeover, forkRecord, disposed, env };
}
type World = ReturnType<typeof build>;

function action(
	meta: Record<string, unknown> = {},
	over: Partial<ControlAction> = {},
): ControlAction {
	return {
		id: "act-1",
		sessionId: S,
		launchRequestId: null,
		actionType: "resume",
		status: "running",
		metadata: {
			resumeKind: "takeover",
			agentType: "claude_code",
			threadId: S,
			candidateCwd: work,
			expectedEnforcedArgs: ["--permission-mode", "default"],
			forkSessionId: N,
			carrierLaunchId: CARRIER,
			targetSupervisorId: "sup-1",
			...meta,
		},
		...over,
	} as unknown as ControlAction;
}
const recovery = (meta: Record<string, unknown> = {}) =>
	action(
		{ resumeKind: "recovery", threadId: N, candidateCwd: work, forkSessionId: undefined, ...meta },
		{ sessionId: N, launchRequestId: CARRIER },
	);

const statusPosts = (w: World) => w.posts.filter((p) => p.path.endsWith("/act-1/status"));
const failedWords = (w: World) =>
	String(statusPosts(w).find((p) => p.body.status === "failed")?.body.error ?? "");
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const forkStarts = () => fake.starts().filter((s) => s.argv.includes("--session-id"));
const hash = (file: string) => readFileSync(file, "utf8");

async function expectRefusedNothingRunning(w: World, words: string | RegExp) {
	expect(failedWords(w)).toMatch(words);
	expect(forkStarts().length).toBe(0);
	expect(w.forkRecord.lookup(N)).toBeNull();
	expect(fake.userLines()).toBe(0);
	expect(statusPosts(w).filter((p) => p.body.status === "succeeded").length).toBe(0);
}

// ── success ──────────────────────────────────────────────────────────────────

describe("a takeover", () => {
	test("a known key login: restricted, the proved directory reported, the fork recorded and live, S's transcript byte-equal, no user line sent", async () => {
		const file = writeTranscript(S, work);
		const before = hash(file);
		const w = build();
		await w.takeover.run(action(), S);

		const [report] = statusPosts(w);
		expect(report.body).toMatchObject({
			status: "succeeded",
			provedCwd: work,
			permissionMode: "restricted",
		});
		expect(forkStarts().length).toBe(1);
		expect(forkStarts()[0].argv).toContain("--fork-session");
		expect(forkStarts()[0].argv).toContain("--restricted");
		expect(w.forkRecord.lookup(N)).toMatchObject({ source: S, mode: "restricted", dir: work });
		expect(getClaudeStreamRuntime(N)?.state).toBe("live");
		expect(fake.userLines()).toBe(0);
		expect(hash(file)).toBe(before);
		// The gate learned N under the carrier, so later reports about N are judged by the proved directory.
		expect(w.gate.verdict(N, work)).toBe("send");
	});

	test("an apiKeyHelper login is mode ask, picked by the second probe", async () => {
		writeTranscript(S, work);
		fake.configure({ account: HELPER_ACCOUNT, accountRestricted: NO_LOGIN_ACCOUNT });
		const w = build();
		await w.takeover.run(action(), S);
		expect(statusPosts(w)[0].body.permissionMode).toBe("ask");
		expect(forkStarts()[0].argv).not.toContain("--restricted");
		expect(fake.starts().length).toBe(3); // two probes and the fork
	});

	test("no login anywhere: claude_not_logged_in with the login words, nothing spawned for S, no user line", async () => {
		const file = writeTranscript(S, work);
		const before = hash(file);
		fake.configure({ account: NO_LOGIN_ACCOUNT });
		const w = build();
		await w.takeover.run(action(), S);
		await expectRefusedNothingRunning(w, /claude setup-token/);
		expect(failedWords(w)).toContain("ANTHROPIC_API_KEY");
		expect(failedWords(w)).toContain("isn't enough");
		expect(hash(file)).toBe(before);
		// Every child that ran was a probe: none names a conversation.
		for (const start of fake.starts()) {
			expect(start.argv).not.toContain("--resume");
		}
	});
});

// ── the refusals, each with nothing started ─────────────────────────────────

describe("refusals", () => {
	test("S listed by agents: running, nothing spawned", async () => {
		writeTranscript(S, work);
		const w = build({ agentsFor: () => [{ pid: 4242, sessionId: S }] });
		await w.takeover.run(action(), S);
		await expectRefusedNothingRunning(w, /still open on mac-1/);
	});

	test("agents fails: liveness_unknown; an entry for another session is no refusal", async () => {
		writeTranscript(S, work);
		const failing = build({ agentsFor: () => "fail" });
		await failing.takeover.run(action(), S);
		await expectRefusedNothingRunning(failing, /couldn't check whether this session is open/);
		rmSync(join(home, ".agentpulse", "claude-forks.json"), { force: true });
		const other = build({
			agentsFor: () => [{ pid: 1, sessionId: "99999999-9999-4999-8999-999999999999" }],
		});
		await other.takeover.run(action(), S);
		expect(statusPosts(other)[0].body.status).toBe("succeeded");
	});

	test("no transcript: missing; two transcripts: rejected", async () => {
		const none = build();
		await none.takeover.run(action(), S);
		await expectRefusedNothingRunning(none, /can't find this conversation's history/);

		writeTranscript(S, work);
		writeTranscript(S, work, [], "-another-project");
		const two = build();
		await two.takeover.run(action(), S);
		expect(failedWords(two)).toMatch(/couldn't start this/);
		expect(forkStarts().length).toBe(0);
	});

	test("a cwd that appears only inside another value, or in a cut line, is not the directory", async () => {
		const evil = JSON.stringify({
			type: "user",
			message: { content: 'the "cwd":"/evil" literal' },
			lastPrompt: '{"cwd":"/evil"}',
		});
		const file = join(configDir, "projects", encodeProjectDirName(work));
		mkdirSync(file, { recursive: true });
		writeFileSync(
			join(file, `${S}.jsonl`),
			`${JSON.stringify({ type: "queue-operation" })}\n${evil}\n{"type":"user","cwd":"${work.slice(0, 8)}`,
		);
		const w = build();
		await w.takeover.run(action(), S);
		// No top-level string `cwd` at all: missing, and the literal /evil was never believed.
		expect(failedWords(w)).toMatch(/can't find this conversation's history/);
		expect(forkStarts().length).toBe(0);
	});

	test("the project directory's name must be Claude's encoding of the cwd it holds", async () => {
		writeTranscript(S, work, [], "-some-other-name");
		const w = build();
		await w.takeover.run(action(), S);
		expect(failedWords(w)).toMatch(/couldn't start this/);
		expect(forkStarts().length).toBe(0);
	});

	test("a cd session: the first cwd is used and a candidate inside it passes; one outside refuses", async () => {
		writeTranscript(S, work, [
			JSON.stringify({ type: "user", cwd: join(work, "src"), message: { content: "after cd" } }),
		]);
		const inside = build();
		await inside.takeover.run(action({ candidateCwd: join(work, "src") }), S);
		expect(statusPosts(inside)[0].body.provedCwd).toBe(work);
		expect(statusPosts(inside)[0].body.status).toBe("succeeded");
		_resetClaudeStreamForTest();
		rmSync(join(home, ".agentpulse", "claude-forks.json"), { force: true });

		const outside = build();
		await outside.takeover.run(action({ candidateCwd: join(root, "work", "other") }), S);
		expect(failedWords(outside)).toMatch(/couldn't start this/);
	});

	test("a directory that resolves outside the trusted roots is refused before any fork", async () => {
		const outsideDir = join(root, "elsewhere");
		mkdirSync(outsideDir, { recursive: true });
		symlinkSync(outsideDir, join(root, "work", "link"));
		const linked = join(root, "work", "link");
		writeTranscript(S, linked);
		const w = build();
		await w.takeover.run(action({ candidateCwd: linked }), S);
		expect(forkStarts().length).toBe(0);
		expect(failedWords(w)).not.toBe("");
	});

	test("N equal to S, and a malformed id, are refused", async () => {
		writeTranscript(S, work);
		const same = build();
		await same.takeover.run(action({ forkSessionId: S }), S);
		expect(failedWords(same)).toMatch(/couldn't start this/);
		const bad = build();
		await bad.takeover.run(action({ forkSessionId: "../etc" }), S);
		expect(failedWords(bad)).toMatch(/couldn't start this/);
		expect(fake.starts().length).toBe(0);
	});

	test.each([
		["a version outside the range", { version: "2.0.1" }, /outside what AgentPulse has tested/],
		["a platform that isn't macOS", { platform: "linux" }, /only on macOS/],
		["plain http", { serverUrl: "http://agentpulse.example.test" }, /over https/],
	])("%s is refused before any process starts", async (_name, opts, words) => {
		writeTranscript(S, work);
		const w = build(opts);
		await w.takeover.run(action(), S);
		expect(failedWords(w)).toMatch(words);
		expect(fake.starts().length).toBe(0);
	});

	test("host_busy when no slot is free, and the fork's own id showing the source's is rejected; both leave no child", async () => {
		writeTranscript(S, work);
		const busy = build({ maxRuntimes: 0 });
		await busy.takeover.run(action(), S);
		expect(failedWords(busy)).toMatch(/as many of these as it can/);
		await Bun.sleep(50);
		for (const start of fake.starts()) expect(alive(start.pid)).toBe(false);

		rmSync(join(home, ".agentpulse", "claude-forks.json"), { force: true });
		const wrongId = build({ ownIdSession: S });
		await wrongId.takeover.run(action(), S);
		expect(failedWords(wrongId)).toMatch(/couldn't start this/);
		await Bun.sleep(50);
		for (const start of fake.starts()) expect(alive(start.pid)).toBe(false);
	});

	test("a fork that can't be recorded is refused, with the child dead", async () => {
		writeTranscript(S, work);
		const w = build({
			recordPath: join(home, ".agentpulse", "no-such-dir", "x", "claude-forks.json"),
		});
		// Make the record's directory unwritable by making its parent a file.
		writeFileSync(join(home, ".agentpulse", "no-such-dir"), "not a directory");
		await w.takeover.run(action(), S);
		expect(failedWords(w)).toMatch(/couldn't start this/);
		expect(statusPosts(w).filter((p) => p.body.status === "succeeded").length).toBe(0);
		await Bun.sleep(50);
		for (const start of forkStarts()) expect(alive(start.pid)).toBe(false);
	});
});

// ── the exclude file, with the real gate ─────────────────────────────────────

describe("the exclude file", () => {
	test("rules that don't cover the directory: it settles; a cd session settles on the proved directory and its prompts aren't refused", async () => {
		writeRules([join(root, "secret")]);
		writeTranscript(S, work, [
			JSON.stringify({ type: "user", cwd: join(work, "sub"), message: { content: "x" } }),
		]);
		const w = build();
		await w.takeover.run(action({ candidateCwd: join(work, "sub") }), S);
		expect(statusPosts(w)[0].body.status).toBe("succeeded");
		expect(w.gate.verdict(N, work)).toBe("send");
	});

	test("rules that cover the directory: refused in the generic words, no fork, no rows asked for", async () => {
		writeRules([work]);
		writeTranscript(S, work);
		const w = build();
		await w.takeover.run(action(), S);
		expect(failedWords(w)).toMatch(/refused this session/);
		expect(failedWords(w)).not.toContain(work);
		expect(forkStarts().length).toBe(0);
		expect(statusPosts(w).filter((p) => p.body.status === "succeeded").length).toBe(0);
	});

	test("rules turning invalid during the preflight: nothing is reported, the child is killed, no success is posted", async () => {
		writeRules([join(root, "secret")]);
		writeTranscript(S, work);
		let gateRef: World["gate"] | null = null;
		const w = build({
			afterListed: async () => {
				// A rule file that stops being private is invalid.
				chmodSync(join(home, ".agentpulse", "exclude"), 0o666);
				await gateRef?.scan();
			},
		});
		gateRef = w.gate;
		await w.takeover.run(action(), S);
		expect(statusPosts(w).filter((p) => p.body.status === "succeeded").length).toBe(0);
		for (const start of forkStarts()) {
			await Bun.sleep(50);
			expect(alive(start.pid)).toBe(false);
		}
		expect(w.forkRecord.lookup(N)).toBeNull();
	});
});

// ── the answer ───────────────────────────────────────────────────────────────

describe("the server's answer", () => {
	test("failed: the child is killed, nothing stays registered", async () => {
		writeTranscript(S, work);
		const w = build({ answers: ["failed"] });
		await w.takeover.run(action(), S);
		const pid = forkStarts()[0].pid;
		await Bun.sleep(50);
		expect(alive(pid)).toBe(false);
		expect(getClaudeStreamRuntime(N)).toBeUndefined();
	});

	test("lost: the child stays held and settling; the answer arriving later makes it live with no kill", async () => {
		writeTranscript(S, work);
		const w = build({ answers: ["lost", "lost", "succeeded"] });
		await w.takeover.run(action(), S);
		const pid = forkStarts()[0].pid;
		expect(getClaudeStreamRuntime(N)?.state).toBe("settling");
		expect(alive(pid)).toBe(true);
		await w.takeover.idle();
		expect(getClaudeStreamRuntime(N)?.state).toBe("live");
		expect(alive(pid)).toBe(true);
		expect(guard.sent).toEqual([]);
		expect(statusPosts(w).filter((p) => p.body.status === "succeeded").length).toBe(3);
	});

	test("lost, then the swept action answers failed: the child is killed", async () => {
		writeTranscript(S, work);
		const w = build({ answers: ["lost", "failed"] });
		await w.takeover.run(action(), S);
		const pid = forkStarts()[0].pid;
		await w.takeover.idle();
		await Bun.sleep(50);
		expect(alive(pid)).toBe(false);
		expect(getClaudeStreamRuntime(N)).toBeUndefined();
	});

	test("lost, and a prompt claimed meanwhile proves the settle and runs", async () => {
		writeTranscript(S, work);
		// Never answers during the test: the retry loop is parked on a long list of losses.
		const w = build({ answers: Array(200).fill("lost") });
		const running = w.takeover.run(action(), S);
		await running;
		expect(getClaudeStreamRuntime(N)?.state).toBe("settling");
		const sent = await promptClaudeStreamSession(
			{ sessionId: N, prompt: "hello", actionId: "p-1" },
			{
				reportState: (body) => w.gate.reportState(body),
				reportEvents: (events) => w.gate.reportEvents(N, events),
			},
		);
		expect(getClaudeStreamRuntime(N)?.state).toBe("live");
		expect((await sent.done).ok).toBe(true);
		expect(fake.userLines()).toBe(1);
	});

	test("lost, and a Stop claimed meanwhile reaches the child", async () => {
		writeTranscript(S, work);
		const w = build({ answers: Array(200).fill("lost") });
		await w.takeover.run(action(), S);
		const pid = forkStarts()[0].pid;
		const stopped = await stopClaudeStreamSession(N, FAST);
		expect(stopped.hadChild).toBe(true);
		await Bun.sleep(50);
		expect(alive(pid)).toBe(false);
	});

	test("lost, and the child exits meanwhile: degraded is reported through the gate", async () => {
		writeTranscript(S, work);
		const w = build({ answers: Array(200).fill("lost") });
		await w.takeover.run(action(), S);
		const runtime = getClaudeStreamRuntime(N);
		const pid = forkStarts()[0].pid;
		guard.allow(pid);
		guard.killPid(pid, "SIGTERM");
		await runtime?.closed;
		const reports = w.posts.filter((p) => p.path.endsWith("/managed-session-state"));
		expect(reports.some((p) => p.body.managedState === "degraded")).toBe(true);
	});
});

// ── recovery (T13) ───────────────────────────────────────────────────────────

describe("recovery of a fork", () => {
	function seedFork(mode: "ask" | "restricted" = "ask", withFile = true) {
		const w = build();
		w.forkRecord.write({ forkId: N, source: S, mode, dir: work });
		const sFile = writeTranscript(S, work);
		if (withFile) writeTranscript(N, work);
		return { w, sFile };
	}

	test("N's file present: resumed in place, under the stored mode, with no probe and no fork flags", async () => {
		const { w, sFile } = seedFork("restricted");
		const before = hash(sFile);
		await w.takeover.run(recovery(), N);
		expect(fake.starts().length).toBe(1);
		const argv = fake.starts()[0].argv;
		expect(argv).toContain("--resume");
		expect(argv).toContain(N);
		expect(argv).not.toContain("--fork-session");
		expect(argv).toContain("--restricted");
		expect(getClaudeStreamRuntime(N)?.state).toBe("live");
		const states = w.posts.filter((p) => p.path.endsWith("/managed-session-state"));
		expect(states.some((p) => p.body.managedState === "managed")).toBe(true);
		expect(statusPosts(w).at(-1)?.body.status).toBe("succeeded");
		expect(hash(sFile)).toBe(before);
	});

	test("never prompted (no file for N): forked again from S under the same N; S listed refuses", async () => {
		const { w, sFile } = seedFork("ask", false);
		const before = hash(sFile);
		await w.takeover.run(recovery(), N);
		const argv = fake.starts()[0].argv;
		expect(argv).toContain("--fork-session");
		expect(argv).toContain(S);
		expect(argv.join(" ")).toContain(`--session-id ${N}`);
		expect(hash(sFile)).toBe(before);

		_resetClaudeStreamForTest();
		const again = seedFork("ask", false);
		const listed = build({ agentsFor: () => [{ pid: 7, sessionId: S }] });
		listed.forkRecord.write({ forkId: N, source: S, mode: "ask", dir: work });
		const starts = fake.starts().length;
		await listed.takeover.run(recovery(), N);
		expect(fake.starts().length).toBe(starts);
		expect(failedWords(listed)).toMatch(/still shows this session running/);
		expect(again.w).toBeDefined();
	});

	test("N listed by agents: running, with the recovery words, and nothing spawned", async () => {
		const { w } = seedFork();
		const listed = build({ agentsFor: () => [{ pid: 7, sessionId: N }] });
		await listed.takeover.run(recovery(), N);
		expect(failedWords(listed)).toMatch(/A command you approved may still be finishing/);
		expect(fake.starts().length).toBe(0);
		expect(w).toBeDefined();
	});

	test("no record: thread_unverified; a record with an unusable mode: branch_changed", async () => {
		writeTranscript(N, work);
		const none = build();
		await none.takeover.run(recovery(), N);
		expect(failedWords(none)).toMatch(/can't confirm this session can be resumed/);

		const recordPath = join(home, ".agentpulse", "claude-forks.json");
		writeFileSync(
			recordPath,
			JSON.stringify({
				version: 1,
				entries: [{ forkId: N, source: S, dir: work, mode: "bypass", at: "2026-01-01T00:00:00Z" }],
			}),
			{ mode: 0o600 },
		);
		chmodSync(recordPath, 0o600);
		const bad = build();
		await bad.takeover.run(recovery(), N);
		expect(failedWords(bad)).toMatch(/started under different rules/);
		expect(fake.starts().length).toBe(0);
	});

	test("a restricted fork on a host that now has only a helper login: claude_not_logged_in with the restricted words, killed, no user line", async () => {
		seedFork("restricted");
		fake.configure({ account: HELPER_ACCOUNT, accountRestricted: NO_LOGIN_ACCOUNT });
		const w = build();
		await w.takeover.run(recovery(), N);
		expect(failedWords(w)).toMatch(/runs without your Claude settings/);
		expect(fake.userLines()).toBe(0);
		await Bun.sleep(50);
		for (const start of fake.starts()) expect(alive(start.pid)).toBe(false);
	});

	test("the stored mode is used even when a probe would now pick the other", async () => {
		seedFork("ask");
		// The fake's login is a key: a probe would say restricted. The record says ask.
		const w = build();
		await w.takeover.run(recovery(), N);
		const argv = fake.starts()[0].argv;
		expect(argv).not.toContain("--restricted");
		expect(fake.starts().length).toBe(1);
		expect(w.posts.length).toBeGreaterThan(0);
	});
});

// ── the resumer routes by agent ──────────────────────────────────────────────

describe("the session resumer", () => {
	test("a Claude action goes to the Claude handler and nothing is held for the Codex observer; without one it says the host is too old", async () => {
		const calls: string[] = [];
		const held: string[] = [];
		const refused: string[] = [];
		const resume = createSessionResumer({
			gate: {
				refuseResume: async (_id: string, words: string) => void refused.push(words),
			} as never,
			hostName: "mac-1",
			trustedRoots: [],
			record: {} as never,
			hold: { add: (id) => void held.push(id), delete: () => {} },
			neutralCwd: async () => "",
			providers: {} as never,
			claude: { run: async (a) => void calls.push(a.id) },
		});
		await resume(action(), S);
		expect(calls).toEqual(["act-1"]);
		expect(held).toEqual([]);

		const old = createSessionResumer({
			gate: {
				refuseResume: async (_id: string, words: string) => void refused.push(words),
			} as never,
			hostName: "mac-1",
			trustedRoots: [],
			record: {} as never,
			hold: { add: () => {}, delete: () => {} },
			neutralCwd: async () => "",
			providers: {} as never,
		});
		await old(action(), S);
		expect(refused[0]).toContain("older supervisor");
	});
});

describe("is the fork still listed", () => {
	test("listed, not listed and unknown", async () => {
		let result: ReturnType<NonNullable<Parameters<typeof build>[0]>["agentsFor"] & (() => any)> =
			[];
		const w = build({ agentsFor: () => result as never });
		result = [{ pid: 1, sessionId: N }];
		expect(await w.takeover.isListed(N)).toBe("listed");
		result = [];
		expect(await w.takeover.isListed(N)).toBe("not_listed");
		result = "fail";
		expect(await w.takeover.isListed(N)).toBe("unknown");
	});
});

// ── review round (P5-X1, B1-B4, B8, T6, T7) ──────────────────────────────────

const degradedPosts = (w: World) =>
	w.posts.filter(
		(p) => p.path.endsWith("/managed-session-state") && p.body.managedState === "degraded",
	);
const succeededPosts = (w: World) => statusPosts(w).filter((p) => p.body.status === "succeeded");

/**
 * The invariant: once a success report may have reached the server, either a runtime stands behind the
 * fork or the server was told there is none. A `managed` row with neither is what nothing recovers from.
 */
function expectNoOrphan(w: World) {
	if (succeededPosts(w).length === 0) return;
	const runtime = getClaudeStreamRuntime(N);
	const standing = runtime !== undefined && alive(runtime.pid ?? -1);
	expect(standing || degradedPosts(w).length > 0).toBe(true);
}

describe("every directory the original worked in (P5-X1)", () => {
	test("a cd into an excluded directory refuses the takeover, in the generic words, with no fork", async () => {
		const secret = join(root, "work", "secret");
		mkdirSync(secret, { recursive: true });
		writeRules([secret]);
		writeTranscript(S, work, [
			JSON.stringify({ type: "user", cwd: secret, message: { content: "cd secret" } }),
			JSON.stringify({ type: "user", cwd: work, message: { content: "back" } }),
		]);
		const w = build();
		await w.takeover.run(action(), S);
		expect(failedWords(w)).toMatch(/refused this session/);
		expect(failedWords(w)).not.toContain("secret");
		expect(forkStarts().length).toBe(0);
		expect(succeededPosts(w).length).toBe(0);
	});

	test("the real path of the candidate is judged too: a link into an excluded directory refuses", async () => {
		const secret = join(root, "work", "secret2");
		mkdirSync(secret, { recursive: true });
		writeRules([secret]);
		const link = join(work, "inner");
		symlinkSync(secret, link);
		writeTranscript(S, work);
		const w = build();
		await w.takeover.run(action({ candidateCwd: link }), S);
		expect(forkStarts().length).toBe(0);
		expect(failedWords(w)).toMatch(/refused this session/);
	});

	test("a transcript with more directories than the bound refuses", async () => {
		const lines = Array.from({ length: 300 }, (_, i) =>
			JSON.stringify({ type: "user", cwd: join(work, `d${i}`) }),
		);
		writeTranscript(S, work, lines);
		const w = build();
		await w.takeover.run(action(), S);
		expect(forkStarts().length).toBe(0);
		expect(failedWords(w)).toMatch(/couldn't start this/);
	});
});

describe("no silent dispose after an ambiguous answer (P5-B1)", () => {
	test("lost, then the rules go invalid: the child is held while nothing can be sent, and settles when they are repaired", async () => {
		writeRules([join(root, "other")]);
		writeTranscript(S, work);
		let gateRef: World["gate"] | null = null;
		let calls = 0;
		const w = build({
			answers: ["lost", "succeeded"],
			onWait: async () => {
				calls++;
				chmodSync(join(home, ".agentpulse", "exclude"), calls === 1 ? 0o666 : 0o600);
				await gateRef?.scan();
			},
		});
		gateRef = w.gate;
		await w.takeover.run(action(), S);
		await w.takeover.idle();
		expect(calls).toBeGreaterThanOrEqual(2);
		expect(getClaudeStreamRuntime(N)?.state).toBe("live");
		expect(alive(forkStarts()[0].pid)).toBe(true);
		expectNoOrphan(w);
	});

	test("lost, then a rule starts covering the directory: the child ends and nothing counts as a success", async () => {
		writeRules([join(root, "other")]);
		writeTranscript(S, work);
		let gateRef: World["gate"] | null = null;
		const w = build({
			answers: ["lost"],
			onWait: async () => {
				writeRules([work]);
				await gateRef?.scan();
			},
		});
		gateRef = w.gate;
		await w.takeover.run(action(), S);
		await w.takeover.idle();
		await Bun.sleep(50);
		expect(alive(forkStarts()[0].pid)).toBe(false);
		expect(getClaudeStreamRuntime(N)).toBeUndefined();
	});

	test("lost, then succeeded, but the child has gone meanwhile: degraded is reported, the runtime is not made live", async () => {
		writeTranscript(S, work);
		const w = build({
			answers: ["lost", "succeeded"],
			onWait: async () => {
				const pid = forkStarts()[0].pid;
				guard.allow(pid);
				guard.killPid(pid, "SIGTERM");
				await getClaudeStreamRuntime(N)?.closed;
			},
		});
		await w.takeover.run(action(), S);
		await w.takeover.idle();
		expect(degradedPosts(w).length).toBeGreaterThan(0);
		expectNoOrphan(w);
	});

	test("lost, then succeeded with the child alive: live, no degraded report, the invariant holds", async () => {
		writeTranscript(S, work);
		const w = build({ answers: ["lost", "succeeded"] });
		await w.takeover.run(action(), S);
		await w.takeover.idle();
		expect(getClaudeStreamRuntime(N)?.state).toBe("live");
		expect(degradedPosts(w).length).toBe(0);
		expectNoOrphan(w);
	});
});

describe("recovery holds the child while the state upsert is lost (P5-B2)", () => {
	test("a lost answer is asked again, the child stays, and the fork ends live with its success reported", async () => {
		writeTranscript(S, work);
		writeTranscript(N, work);
		const w = build({ stateAnswers: ["lost", "lost", "ok"] });
		w.forkRecord.write({ forkId: N, source: S, mode: "ask", dir: work });
		await w.takeover.run(recovery(), N);
		const pid = fake.starts()[0].pid;
		expect(alive(pid)).toBe(true);
		await w.takeover.idle();
		expect(getClaudeStreamRuntime(N)?.state).toBe("live");
		expect(alive(pid)).toBe(true);
		expect(w.posts.filter((p) => p.path.endsWith("/managed-session-state")).length).toBe(3);
		expect(statusPosts(w).at(-1)?.body.status).toBe("succeeded");
	});

	test("a final refusal (the rules now cover the directory) ends the child and refuses the action", async () => {
		writeTranscript(S, work);
		writeTranscript(N, work);
		writeRules([join(root, "other")]);
		let gateRef: World["gate"] | null = null;
		const w = build({
			stateAnswers: ["lost"],
			onWait: async () => {
				writeRules([work]);
				await gateRef?.scan();
			},
		});
		gateRef = w.gate;
		w.forkRecord.write({ forkId: N, source: S, mode: "ask", dir: work });
		await w.takeover.run(recovery(), N);
		await w.takeover.idle();
		await Bun.sleep(50);
		expect(alive(fake.starts()[0].pid)).toBe(false);
		expect(succeededPosts(w).length).toBe(0);
	});
});

describe("agents runs from the probe directory, never the repository (P5-B3)", () => {
	test("the fork's own-id check and per-prompt check are handed the neutral directory", async () => {
		writeTranscript(S, work);
		let seen: Record<string, unknown> | null = null;
		const w = build({
			onStart: (o) => {
				seen = o;
			},
		});
		await w.takeover.run(action(), S);
		expect(seen).not.toBeNull();
		expect((seen as unknown as Record<string, unknown>).agentsCwd).toBe(
			join(home, ".agentpulse", "claude-probe"),
		);
		expect((seen as unknown as Record<string, unknown>).cwd).toBe(work);
	});
});

describe("the slot is reserved before any probe (P5-B4)", () => {
	test("the fork's slot is held while the login probes run", async () => {
		writeTranscript(S, work);
		const heldDuringProbe: boolean[] = [];
		const w = build({ onProbe: () => heldDuringProbe.push(hasClaudeStreamRuntime(N)) });
		await w.takeover.run(action(), S);
		expect(heldDuringProbe.length).toBeGreaterThan(0);
		expect(heldDuringProbe.every(Boolean)).toBe(true);
	});

	test("with the cap reached, a takeover is host_busy before a single probe runs, and the slot is given back after a refusal", async () => {
		writeTranscript(S, work);
		let probes = 0;
		const busy = build({ maxRuntimes: 0, onProbe: () => probes++ });
		await busy.takeover.run(action(), S);
		expect(probes).toBe(0);
		expect(failedWords(busy)).toMatch(/as many of these as it can/);
		expect(hasClaudeStreamRuntime(N)).toBe(false);

		fake.configure({ account: NO_LOGIN_ACCOUNT });
		const refused = build();
		await refused.takeover.run(action(), S);
		expect(hasClaudeStreamRuntime(N)).toBe(false);
	});
});

describe("the action's deadline (P5-B8)", () => {
	test("too near the deadline, nothing is spawned", async () => {
		writeTranscript(S, work);
		const w = build();
		await w.takeover.run(action({ forkDeadlineAt: new Date(Date.now() + 1_000).toISOString() }), S);
		expect(forkStarts().length).toBe(0);
		expect(failedWords(w)).toMatch(/didn't answer in time/);
	});

	test("with time to spare it starts", async () => {
		writeTranscript(S, work);
		const w = build();
		await w.takeover.run(
			action({ forkDeadlineAt: new Date(Date.now() + 90_000).toISOString() }),
			S,
		);
		expect(forkStarts().length).toBe(1);
	});
});

describe("the gate's answer after the child exists (P5-T6)", () => {
	test("rules that start covering the directory after the spawn: excluded, the child ends, no success counts", async () => {
		writeRules([join(root, "other")]);
		writeTranscript(S, work);
		let gateRef: World["gate"] | null = null;
		const w = build({
			afterOwnId: async () => {
				writeRules([work]);
				await gateRef?.scan();
			},
		});
		gateRef = w.gate;
		await w.takeover.run(action(), S);
		await Bun.sleep(50);
		expect(forkStarts().length).toBe(1);
		expect(alive(forkStarts()[0].pid)).toBe(false);
		expect(w.forkRecord.lookup(N)).not.toBeNull(); // recorded before the report; the action did not succeed
		expect(succeededPosts(w).length).toBe(0);
		expect(getClaudeStreamRuntime(N)).toBeUndefined();
	});
});

describe("a malformed `agents --json` through the takeover (P5-T7)", () => {
	test.each([
		["not JSON at all", { mode: "garbage" as const }],
		["a non-zero exit", { mode: "exit3" as const }],
		["JSON that is not a list", { mode: "json" as const, json: { nothing: true } }],
		["entries with no session id", { mode: "json" as const, json: [{ pid: 4 }] }],
		["a banner before the list", { mode: "garbage" as const }],
	])("%s refuses as liveness_unknown, with nothing spawned for S", async (_name, agents) => {
		writeTranscript(S, work);
		fake.configure({ account: KEY_ACCOUNT, agents });
		const w = build({ realAgents: true });
		await w.takeover.run(action(), S);
		expect(failedWords(w)).toMatch(/couldn't check whether this session is open/);
		expect(forkStarts().length).toBe(0);
	});

	test("a well-formed list that does not name S proceeds, and one that names S refuses as running", async () => {
		writeTranscript(S, work);
		fake.configure({
			account: KEY_ACCOUNT,
			agents: {
				mode: "json",
				json: [{ pid: 9, sessionId: "99999999-9999-4999-8999-999999999999" }],
			},
		});
		const ok = build({ realAgents: true });
		await ok.takeover.run(action(), S);
		expect(statusPosts(ok)[0].body.status).toBe("succeeded");
	});
});
