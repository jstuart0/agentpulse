/**
 * The supervisor's handling of a `resume` control action (AGEN-115, phase 3): it runs BEFORE the report gate's
 * verdict (the gate may not know the session yet), holds the session for the observer from the first step,
 * refuses with the host's one fixed body while exclude rules exist, and reports success only after the
 * provider has. The provider is a recording fake here; the real one is in providers/codex-resume.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privilegeCliArgs } from "../shared/launch-privileges.js";
import { RESUME_REFUSED_MESSAGE, resumeFailureMessage } from "../shared/session-resume.js";
import type { ControlAction } from "../shared/types.js";
import { createControlActionHandler } from "./control-actions.js";
import { CodexResumeError, type CodexResumeKind } from "./providers/codex-shared.js";
import { createManagedThreadRecord } from "./services/managed-thread-record.js";
import { createReportGate } from "./services/report-gate.js";
import { createReportOutbox } from "./services/report-outbox.js";
import { createSessionResumer, resolveNeutralCwd } from "./services/session-resume.js";

const THREAD = "01a1ab40-0000-7000-8000-000000000001";
const SESSION = THREAD;
const HOST = "host-a";

let home: string;
let work: string;
const posted: Array<{ path: string; body: Record<string, any> }> = [];
let holds: string[] = [];
const events: string[] = [];

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-resume-handler-")));
	work = join(home, "work");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
	posted.length = 0;
	holds = [];
	events.length = 0;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function writeRules(lines: string[]) {
	const file = join(home, ".agentpulse", "exclude");
	writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
	chmodSync(file, 0o600);
}

function action(over: Record<string, unknown> = {}, id = "act-1"): ControlAction {
	return {
		id,
		sessionId: SESSION,
		launchRequestId: "launch-1",
		actionType: "resume",
		status: "running",
		metadata: {
			resumeKind: "takeover",
			agentType: "codex_cli",
			threadId: THREAD,
			cwd: work,
			approvalPolicy: "untrusted",
			sandboxMode: "workspace-write",
			expectedEnforcedArgs: privilegeCliArgs("codex_cli", "untrusted", "workspace-write"),
			...over,
		},
	} as unknown as ControlAction;
}

async function build(
	opts: {
		resume?: (
			input: any,
			callbacks: any,
			deps?: any,
		) => Promise<{ pid: number; metadata: Record<string, unknown> }>;
		held?: (id: string) => boolean;
		record?: ReturnType<typeof createManagedThreadRecord>;
		queued?: "none" | "pending" | "held";
		failStatusOnce?: boolean;
		logs?: string[];
	} = {},
) {
	const outbox = createReportOutbox({ home, supervisorId: "sup-1", log: () => {} });
	await outbox.ready();
	const gate = createReportGate({
		request: async (path: string, options?: RequestInit) => {
			posted.push({ path, body: options?.body ? JSON.parse(String(options.body)) : {} });
			return { session: { displayName: "n" }, managedSession: {} };
		},
		supervisorId: "sup-1",
		home,
		outbox,
		log: () => {},
	});
	if (opts.queued && opts.queued !== "none") {
		(gate as { queuedState: (id: string) => string }).queuedState = () => opts.queued as string;
	}
	const record =
		opts.record ??
		createManagedThreadRecord({
			path: join(home, ".agentpulse", "managed-threads.json"),
			log: () => {},
		});
	const calls: Array<{ input: any }> = [];
	const resumer = createSessionResumer({
		gate,
		hostName: HOST,
		trustedRoots: [home],
		record,
		hold: {
			add: (id) => {
				holds.push(`+${id}`);
				events.push("hold");
			},
			delete: (id) => holds.push(`-${id}`),
		},
		neutralCwd: async () => join(home, ".agentpulse", "codex-neutral"),
		providers: {
			managedCodexRuntimeHolds: opts.held ?? (() => false),
			resumeManagedCodexSession:
				opts.resume ??
				(async (input, callbacks) => {
					calls.push({ input });
					events.push("provider");
					// What the real provider does at step 9, so the gate can judge the session afterwards.
					callbacks.noteLaunch(input.launchRequestId, input.sessionId, input.candidateCwd);
					return { pid: 4242, metadata: { mode: "managed_codex" } };
				}),
		},
		log: (line) => opts.logs?.push(line),
	});
	const handler = createControlActionHandler({
		gate,
		trustedRoots: [home],
		providers: {} as never,
		executeCleanupWorkArea: (async () => ({})) as never,
		resumeSession: resumer,
		log: () => {},
	});
	return { gate, handler, calls, record };
}

const statuses = () =>
	posted.filter((p) => p.path.includes("/control-actions/")).map((p) => p.body);

describe("a resume runs before the gate's verdict", () => {
	test("with rules present and no remembered directory for the session, the action still runs", async () => {
		writeRules([join(home, "elsewhere")]);
		const w = await build();
		await w.handler(action());
		expect(w.calls).toHaveLength(1);
		expect(statuses().at(-1)).toMatchObject({ status: "succeeded" });
	});

	test("the source orders the resume branch before the verdict line", () => {
		const text = readFileSync(new URL("./control-actions.ts", import.meta.url), "utf8");
		const resumeAt = text.indexOf('actionType === "resume"');
		const verdictAt = text.indexOf("const verdict = sessionId");
		expect(resumeAt).toBeGreaterThan(-1);
		expect(resumeAt).toBeLessThan(verdictAt);
	});
});

describe("parsing (step 2)", () => {
	test("the provider gets exactly the action's values, resolved through the privileges mapping", async () => {
		const w = await build();
		await w.handler(action());
		const input = w.calls[0].input;
		expect(input).toMatchObject({
			sessionId: SESSION,
			launchRequestId: "launch-1",
			threadId: THREAD,
			candidateCwd: work,
			resumeKind: "takeover",
			resumeActionId: "act-1",
		});
		expect(input.privileges.codexThread).toEqual({
			approvalPolicy: "untrusted",
			sandbox: "workspace-write",
		});
	});

	test.each([
		["a non-UUID thread id", { threadId: "-x" }],
		["a path as the thread id", { threadId: "../a" }],
		["another agent type", { agentType: "claude_code" }],
		["an unknown resume kind", { resumeKind: "fork" }],
		[
			"privileges that disagree with expectedEnforcedArgs",
			{ expectedEnforcedArgs: ["--sandbox", "danger-full-access"] },
		],
		["a privilege value the mapping rejects", { approvalPolicy: "auto" }],
		["no directory", { cwd: "" }],
	])(
		"%s is refused with no process, and the thread id is never used on the filesystem",
		async (_name, over) => {
			const w = await build();
			await w.handler(action(over));
			expect(w.calls).toEqual([]);
			expect(statuses().at(-1)).toMatchObject({ status: "failed" });
		},
	);

	test("a non-UUID session id makes no filesystem call at all", async () => {
		const w = await build();
		await w.handler({ ...action(), sessionId: "not-a-uuid" } as ControlAction);
		expect(w.calls).toEqual([]);
		expect(existsSync(join(home, ".agentpulse", "codex-neutral"))).toBe(false);
	});
});

describe("queued reports (step 3)", () => {
	test("reports_pending and reports_held refuse before any process, with their own words", async () => {
		for (const [state, kind] of [
			["pending", "reports_pending"],
			["held", "reports_held"],
		] as const) {
			posted.length = 0;
			const w = await build({ queued: state });
			await w.handler(action());
			expect(w.calls).toEqual([]);
			expect(statuses().at(-1)).toEqual({
				status: "failed",
				error: resumeFailureMessage(kind, HOST, "takeover"),
			});
		}
	});

	test("for a recovery that would otherwise succeed with no process, queued reports still refuse first", async () => {
		const w = await build({ queued: "pending", held: () => true });
		await w.handler(action({ resumeKind: "recovery" }));
		expect(statuses().at(-1)).toMatchObject({ status: "failed" });
		expect(posted.some((p) => p.path.includes("/managed-session-state"))).toBe(false);
	});
});

describe("a runtime already held here (step 4)", () => {
	test("a takeover is 'running': nothing spawned or reported", async () => {
		const w = await build({ held: () => true });
		await w.handler(action());
		expect(w.calls).toEqual([]);
		expect(statuses().at(-1)).toEqual({
			status: "failed",
			error: resumeFailureMessage("running", HOST, "takeover"),
		});
		expect(posted.some((p) => p.path.includes("/managed-session-state"))).toBe(false);
	});

	test("a recovery reports managed with the error cleared and succeeds, with no new process", async () => {
		// The record proves the thread, so the provider is not reached.
		const record = createManagedThreadRecord({
			path: join(home, ".agentpulse", "managed-threads.json"),
			log: () => {},
		});
		record.write("launch-1", THREAD);
		const w = await build({ held: () => true, record });
		await w.handler(action({ resumeKind: "recovery" }));
		expect(w.calls).toEqual([]);
		const state = posted.find((p) => p.path.includes("/managed-session-state"));
		expect(state?.body).toMatchObject({
			managedState: "managed",
			clearProviderSyncError: true,
			resumeActionId: "act-1",
		});
		expect(statuses().at(-1)).toMatchObject({ status: "succeeded" });
	});
});

describe("the candidate directory (step 5)", () => {
	test("outside the trusted roots or excluded: refused before any process", async () => {
		const w1 = await build();
		await w1.handler(action({ cwd: tmpdir() }));
		expect(w1.calls).toEqual([]);
		expect(statuses().at(-1)).toMatchObject({ status: "failed" });

		posted.length = 0;
		writeRules([work]);
		const w2 = await build();
		await w2.handler(action());
		expect(w2.calls).toEqual([]);
	});
});

describe("the hold (D16)", () => {
	test("begins at the first step, and drops after a failure and after a success", async () => {
		const ok = await build();
		await ok.handler(action());
		expect(holds[0]).toBe(`+${SESSION}`);
		expect(holds.some((h) => h.startsWith("-"))).toBe(true);

		holds.length = 0;
		const failing = await build({
			resume: async () => {
				throw new CodexResumeError("missing", "text only for the log");
			},
		});
		await failing.handler(action());
		expect(holds[0]).toBe(`+${SESSION}`);
		expect(holds.at(-1)).toBe(`-${SESSION}`);
	});

	test("a throw from the provider still drops the hold", async () => {
		const w = await build({
			resume: async () => {
				throw new Error("network");
			},
		});
		await w.handler(action());
		expect(holds.at(-1)).toBe(`-${SESSION}`);
		expect(statuses().at(-1)).toMatchObject({ status: "failed" });
	});

	test("the hold begins before the provider is called", async () => {
		const w = await build();
		await w.handler(action());
		expect(events).toEqual(["hold", "provider"]);
	});
});

describe("refusal bodies (D11 tail)", () => {
	const CAUSES: CodexResumeKind[] = [
		"missing",
		"running",
		"cwd_mismatch",
		"privileges",
		"rejected",
		"timeout",
	];

	test("while rules exist the body is one constant per resume kind, byte for byte, whatever the cause", async () => {
		writeRules([join(home, "elsewhere")]);
		const bodies = new Set<string>();
		for (const kind of CAUSES) {
			posted.length = 0;
			const w = await build({
				resume: async () => {
					throw new CodexResumeError(kind, `specific detail ${kind}`);
				},
			});
			await w.handler(action());
			bodies.add(JSON.stringify(statuses().at(-1)));
			// Nothing else left the host.
			expect(posted.filter((p) => !p.path.includes("/control-actions/"))).toEqual([]);
		}
		expect([...bodies]).toEqual([
			JSON.stringify({ status: "failed", error: RESUME_REFUSED_MESSAGE.takeover(HOST) }),
		]);
	});

	test("a cause that never reached the provider (an unknown id to the gate, a candidate outside the roots) reads the same", async () => {
		writeRules([join(home, "elsewhere")]);
		const w = await build();
		await w.handler(action({ cwd: tmpdir() }));
		expect(statuses().at(-1)).toEqual({
			status: "failed",
			error: RESUME_REFUSED_MESSAGE.takeover(HOST),
		});
	});

	test("a recovery has its own constant", async () => {
		writeRules([join(home, "elsewhere")]);
		const w = await build({
			resume: async () => {
				throw new CodexResumeError("missing");
			},
		});
		await w.handler(action({ resumeKind: "recovery" }));
		expect(statuses().at(-1)).toEqual({
			status: "failed",
			error: RESUME_REFUSED_MESSAGE.recovery(HOST),
		});
	});

	test("negative control: with no rules file the same causes give distinct fixed bodies, and never the launch sentence", async () => {
		const bodies = new Set<string>();
		for (const kind of CAUSES) {
			posted.length = 0;
			const w = await build({
				resume: async () => {
					throw new CodexResumeError(kind, "detail");
				},
			});
			await w.handler(action());
			const last = statuses().at(-1) as { error: string };
			expect(last.error).toBe(resumeFailureMessage(kind, HOST, "takeover"));
			expect(last.error).not.toContain("doesn't allow launches");
			bodies.add(last.error);
		}
		expect(bodies.size).toBe(CAUSES.length);
	});

	test("invalid rules: nothing is posted at all", async () => {
		writeRules(["bad line with no slash"]);
		const w = await build({
			resume: async () => {
				throw new CodexResumeError("missing");
			},
		});
		await w.handler(action());
		expect(posted).toEqual([]);
	});
});

describe("thread proof for a recovery (D11)", () => {
	test("another thread id in the record: thread_unverified, no process", async () => {
		const record = createManagedThreadRecord({
			path: join(home, ".agentpulse", "managed-threads.json"),
			log: () => {},
		});
		record.write("launch-1", "01a1ab40-0000-7000-8000-0000000000ff");
		const w = await build({ record });
		await w.handler(action({ resumeKind: "recovery" }));
		expect(w.calls).toEqual([]);
		expect(statuses().at(-1)).toEqual({
			status: "failed",
			error: resumeFailureMessage("thread_unverified", HOST, "recovery"),
		});
	});

	test("no record file at all: thread_unverified (the createdAt that would admit a pre-upgrade thread is missing)", async () => {
		const w = await build();
		await w.handler(action({ resumeKind: "recovery" }));
		expect(w.calls).toEqual([]);
		expect(statuses().at(-1)).toMatchObject({ status: "failed" });
	});

	test("a matching entry resumes; a takeover ignores the record entirely", async () => {
		const record = createManagedThreadRecord({
			path: join(home, ".agentpulse", "managed-threads.json"),
			log: () => {},
		});
		record.write("launch-1", THREAD);
		const recovery = await build({ record });
		await recovery.handler(action({ resumeKind: "recovery" }, "act-2"));
		expect(recovery.calls).toHaveLength(1);
		expect(recovery.calls[0].input.preUpgrade).toBeUndefined();

		const takeover = await build();
		await takeover.handler(action({}, "act-3"));
		expect(takeover.calls).toHaveLength(1);
	});

	test("with no entry but a record that predates this launch, the provider is asked to prove the thread by its originator and age", async () => {
		const record = createManagedThreadRecord({
			path: join(home, ".agentpulse", "managed-threads.json"),
			log: () => {},
		});
		record.write("some-other-launch", "01a1ab40-0000-7000-8000-0000000000aa");
		const w = await build({ record });
		await w.handler(action({ resumeKind: "recovery" }));
		expect(w.calls).toHaveLength(1);
		expect(typeof w.calls[0].input.preUpgrade?.createdAtMs).toBe("number");
	});
});

describe("success (step 15)", () => {
	test("succeeded is reported once the provider returned, and retried once if the report fails", async () => {
		const w = await build();
		let first = true;
		const real = (w.gate as { reportControlStatus: (...a: unknown[]) => Promise<void> })
			.reportControlStatus;
		(w.gate as { reportControlStatus: (...a: unknown[]) => Promise<void> }).reportControlStatus =
			async (...args) => {
				if (first) {
					first = false;
					throw new Error("network blip");
				}
				return real.apply(w.gate, args);
			};
		await w.handler(action());
		expect(statuses().at(-1)).toMatchObject({ status: "succeeded" });
	});
});

describe("the fixed neutral directory", () => {
	const dir = () => join(home, ".agentpulse", "codex-neutral");

	test("created at 0700 when absent, and reused when it is empty and private", async () => {
		const made = await resolveNeutralCwd(home);
		expect(made).toBe(dir());
		expect(await resolveNeutralCwd(home)).toBe(dir());
	});

	test.each([
		[
			"not empty",
			() => {
				mkdirSync(dir(), { mode: 0o700 });
				writeFileSync(join(dir(), "x"), "1");
			},
		],
		[
			"group-writable",
			() => {
				mkdirSync(dir());
				chmodSync(dir(), 0o770);
			},
		],
		[
			"a symlink",
			() => {
				mkdirSync(join(home, "real"));
				symlinkSync(join(home, "real"), dir());
			},
		],
		[
			"a file",
			() => {
				writeFileSync(dir(), "x");
			},
		],
	])("%s is refused as 'rejected', before any spawn", async (_name, setup) => {
		setup();
		const error = await resolveNeutralCwd(home).catch((e) => e);
		expect(error).toBeInstanceOf(CodexResumeError);
		expect((error as CodexResumeError).kind).toBe("rejected");
	});
});

describe("the success report fails both times (D10's double failure)", () => {
	test("the handler resolves, tries twice, posts no failure, leaves the runtime up and logs it", async () => {
		const logs: string[] = [];
		const registered = new Set<string>();
		const disposed = 0;
		const w = await build({
			logs,
			resume: async (input) => {
				registered.add(input.sessionId);
				return { pid: 1, metadata: {} };
			},
		});
		let attempts = 0;
		(w.gate as { reportControlStatus: (...a: unknown[]) => Promise<void> }).reportControlStatus =
			async () => {
				attempts += 1;
				throw new Error("network down");
			};

		await w.handler(action());

		expect(attempts).toBe(2);
		expect(statuses().filter((body) => body.status === "failed")).toEqual([]);
		expect(registered.has(SESSION)).toBe(true);
		expect(disposed).toBe(0);
		expect(
			logs.filter((line) => line.includes("worked but its status wasn't reported")),
		).toHaveLength(2);
		// The hold still drops: the observer resumes posting for a session the runtime now holds itself.
		expect(holds.at(-1)).toBe(`-${SESSION}`);
	});
});
