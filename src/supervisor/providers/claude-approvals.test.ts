/**
 * AGEN-117 P4: a takeover fork's tool requests through the one approval tracker (T9, T10). The Codex tests
 * are not edited; this file holds what is new: how a Claude request is read, what is written back, what a
 * cancel or a `tool_result` means, and that Codex keeps working beside it.
 *
 * The tracker is driven with a stub gate, a fake clock and fake timers, and a context that records what it is
 * asked to write (so "one write on the wire" is a count). A few tests run a real fake `claude` child through
 * the stream runtime with the real tracker's port.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLAUDE_HOST_DECLINE_MESSAGE,
	CLAUDE_PERSON_DECLINE_MESSAGE,
	CLAUDE_PERSON_STOP_MESSAGE,
	commandNamesAgentMemory,
	isAgentMemoryPath,
} from "../../shared/claude-approvals.js";
import {
	CLAUDE_DECLINE_EVIDENCE_WAIT_MS,
	type CodexApprovalReportRequest,
	type ParsedApprovalSyncResponse,
} from "../../shared/codex-approvals.js";
import { SupervisorRequestError } from "../services/report-resilience.js";
import {
	AWAIT,
	INIT,
	assistantToolUse,
	canUseTool,
	createHarness,
	resultOk,
	toolResult,
	until,
} from "../test-utils/claude-stream-harness.js";
import {
	type ClaudeFsPort,
	REAL_FS,
	editDiff,
	parseClaudeRequest,
	resolveThroughLinks,
} from "./claude-approval-params.js";
import type { ClaudeApprovalContext, ClaudeToolResultInfo } from "./claude-stream.js";
import { ClaudeLink, allowResponse, denyResponse } from "./claude-wire.js";
import { type ApprovalGatePort, createCodexApprovalTracker } from "./codex-approvals.js";
import type { Verdict } from "./codex-protocol.js";
import { RpcClient, type RpcTimers } from "./codex-rpc.js";

const SUPPORTED: Verdict = { verdict: "supported", reason: "ok" };
const BOTH = ["codex_approvals", "claude_approvals"];
const CWD = "/work/project";
/** An absolute path that is not a link: a Write to it needs no directory to be read against. */
const ABS_TARGET = join(realpathSync(tmpdir()), "ap-p4-a.txt");
const SESSION = "fork-1";
const TURN = "act-1";

// ---- fixtures: the recorded requests ----

const FIXTURES = join(import.meta.dir, "__fixtures__", "claude-2.1.318");
function recordedRequests(): Array<{ id: string; body: Record<string, any> }> {
	const out: Array<{ id: string; body: Record<string, any> }> = [];
	for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"))) {
		for (const line of readFileSync(join(FIXTURES, name), "utf8").split("\n")) {
			if (!line.trim()) continue;
			const frame = JSON.parse(line).frame;
			if (frame?.type === "control_request" && frame.request?.subtype === "can_use_tool") {
				out.push({ id: frame.request_id, body: frame.request });
			}
		}
	}
	return out;
}

// ---- clocks, timers, a stub gate (as the Codex suite builds them) ----

function clockPair() {
	const state = { wall: 1_800_000_000_000, mono: 5_000 };
	return {
		now: () => state.wall,
		monotonic: () => state.mono,
		advance: (ms: number) => {
			state.wall += ms;
			state.mono += ms;
		},
	};
}

function fakeTimers() {
	const entries: Array<{ callback: () => void; ms: number; cleared: boolean; at: number }> = [];
	let clock = 0;
	const timers: RpcTimers = {
		set: (callback, ms) => {
			const entry = { callback, ms, cleared: false, at: clock + ms };
			entries.push(entry);
			return entry;
		},
		clear: (handle) => {
			(handle as { cleared: boolean }).cleared = true;
		},
	};
	return {
		entries,
		timers,
		/** Moves time forward and fires what is due and not cleared. */
		advance(ms: number) {
			clock += ms;
			for (const entry of [...entries]) {
				if (!entry.cleared && entry.at <= clock) {
					entry.cleared = true;
					entry.callback();
				}
			}
		},
	};
}

type SyncEntries = Parameters<ApprovalGatePort["syncApprovals"]>[0];

function stubGate() {
	const script = {
		verdict: "send" as "send" | "excluded" | "blocked",
		excluded: new Set<string>(),
		report: async (
			sessionId: string,
			body: CodexApprovalReportRequest,
		): Promise<{ approvalId: string }> => {
			const key = `${sessionId}|${body.runtimeEpoch}|${body.rpcId}`;
			const known = script.ids.get(key);
			if (known) return { approvalId: known };
			const approvalId = `ap-${++script.counter}`;
			script.ids.set(key, approvalId);
			return { approvalId };
		},
		sync: async (_entries: SyncEntries): Promise<Partial<ParsedApprovalSyncResponse>> => ({}),
		offline: false,
		counter: 0,
		ids: new Map<string, string>(),
	};
	const reports: Array<{ sessionId: string; body: CodexApprovalReportRequest }> = [];
	const syncs: SyncEntries[] = [];
	const gate: ApprovalGatePort = {
		verdict: () => script.verdict,
		excludesPath: (path) => script.excluded.has(path),
		isOffline: () => script.offline,
		reportApproval: async (sessionId, body) => {
			if (script.verdict !== "send") {
				return { outcome: script.verdict === "excluded" ? "excluded" : "blocked" };
			}
			reports.push({ sessionId, body });
			const { approvalId } = await script.report(sessionId, body);
			return {
				outcome: "sent",
				response: { v: 1, approvalId, revision: body.revision, expiresInMs: 1 },
			};
		},
		syncApprovals: async (entries) => {
			if (script.verdict !== "send") return { outcome: "empty" };
			syncs.push(JSON.parse(JSON.stringify(entries)));
			const partial = await script.sync(entries);
			// Acknowledges what it is told, as the server does, so an outcome is counted once.
			const ack = entries.resolved.map((r) => ({ approvalId: r.approvalId, outcome: r.outcome }));
			return {
				outcome: "sent",
				response: { v: 1, answers: [], closed: [], ack, ...partial } as ParsedApprovalSyncResponse,
			};
		},
	};
	return { gate, script, reports, syncs };
}

const settle = () => Bun.sleep(5);

type Written = { id: string; body: any };

/** A tracker with one fork attached, and a context per request that records what is written for it. */
function armed(options: { features?: string[]; mode?: "ask" | "restricted" } = {}) {
	const clock = clockPair();
	const stub = stubGate();
	const timers = fakeTimers();
	const tracker = createCodexApprovalTracker({
		gate: stub.gate,
		now: clock.now,
		monotonic: clock.monotonic,
		timers: timers.timers,
	});
	tracker.setServerFeatures(options.features ?? BOTH);
	const warnings: Array<{ content: string; detail: { method: string; reason: string } }> = [];
	const port = tracker.attachClaude(
		{
			sessionId: SESSION,
			cwd: CWD,
			warn: async (content, detail) => {
				warnings.push({ content, detail });
			},
		},
		{ mode: options.mode ?? "ask", configDir: "/cfg", verdict: SUPPORTED },
	);
	const written: Written[] = [];
	const answered = new Set<string>();
	const elsewhere: string[] = [];
	const ctx = (over: Partial<ClaudeApprovalContext> = {}): ClaudeApprovalContext => ({
		answer: (id, body) => {
			if (answered.has(id)) return false;
			answered.add(id);
			written.push({ id, body });
			return true;
		},
		markDecidedElsewhere: (id) => elsewhere.push(id),
		turnId: TURN,
		inputStable: true,
		...over,
	});
	let opened = 0;
	const request = (
		requestId: string,
		tool: string,
		input: Record<string, unknown>,
		extra: Record<string, unknown> = {},
		contextOver: Partial<ClaudeApprovalContext> = {},
	) => {
		const toolUseId = `toolu_${++opened}`;
		port.onToolRequest(
			{
				id: requestId,
				method: "claude/can_use_tool",
				params: {
					subtype: "can_use_tool",
					tool_name: tool,
					input,
					tool_use_id: toolUseId,
					...extra,
				},
			},
			ctx(contextOver),
		);
		return toolUseId;
	};
	const answerOf = (approvalId: string, decision: string, revision = 1) => ({
		approvalId,
		decision,
		revision,
	});
	return {
		tracker,
		port,
		clock,
		timers,
		warnings,
		written,
		elsewhere,
		request,
		answerOf,
		...stub,
	};
}
type Armed = ReturnType<typeof armed>;

const outcomesSent = (a: Armed) =>
	a.syncs.flatMap((s) => s.resolved.map((r) => `${r.approvalId}:${r.outcome}:${r.sentDecision}`));

/** Opens a Bash request and waits for its report. */
async function openBash(a: Armed, id = "r1", command = "npm test") {
	const toolUseId = a.request(id, "Bash", { command, description: "run the tests" });
	await settle();
	return toolUseId;
}

// ======================================================================================================
describe("reading a request", () => {
	const ctx = (over: Partial<Parameters<typeof parseClaudeRequest>[1]> = {}) => ({
		threadId: SESSION,
		turnId: TURN,
		cwd: CWD,
		configDir: "/cfg",
		inputStable: true,
		...over,
	});
	const body = (
		tool: string,
		input: Record<string, unknown>,
		extra: Record<string, unknown> = {},
	) => ({
		subtype: "can_use_tool",
		tool_name: tool,
		input,
		tool_use_id: "toolu_1",
		...extra,
	});
	const fsPort = (existing: Record<string, "yes" | "no" | "error">): ClaudeFsPort => ({
		realpath: (path) => path,
		exists: (path) => existing[path] ?? "no",
		isSymlink: () => false,
	});

	test("every recorded request of the six tools reads whole: nothing unknown, nothing decline-only", () => {
		const requests = recordedRequests().filter((r) =>
			["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "Read"].includes(r.body.tool_name),
		);
		expect(requests.length).toBeGreaterThanOrEqual(20);
		for (const { id, body: recorded } of requests) {
			const parsed = parseClaudeRequest(recorded, ctx({ fs: fsPort({}) }));
			expect(parsed, id).not.toBeNull();
			// Only what the host can know is judged here: a recorded `requires_user_interaction` or memory path would
			// show; none of the six tools' recorded requests carries one.
			expect(
				parsed?.declineOnly.filter((r) => r !== "requires_interaction"),
				id,
			).toEqual([]);
		}
	});

	test("Bash: command, description as the reason, the spawn directory as cwd, blocked_path as given", () => {
		const parsed = parseClaudeRequest(
			body(
				"Bash",
				{ command: "echo a > a.txt", description: "Write a" },
				{ blocked_path: "/work/project/a.txt" },
			),
			ctx(),
		);
		expect(parsed).toMatchObject({
			kind: "command",
			command: "echo a > a.txt",
			cwd: CWD,
			reason: "Write a",
			claude: { tool: "Bash", blockedPath: "/work/project/a.txt" },
		});
		expect(parsed?.claude?.excludePaths).toEqual([CWD, "/work/project/a.txt"]);
	});

	test("Write over an existing file, a new file, and a failed check read as three different kinds", () => {
		const kindFor = (state: "yes" | "no" | "error") =>
			parseClaudeRequest(
				body("Write", { file_path: "/work/project/a.txt", content: "x" }),
				ctx({ fs: fsPort({ "/work/project/a.txt": state }) }),
			)?.claude?.changes[0]?.kind;
		expect(kindFor("yes")).toBe("write");
		expect(kindFor("no")).toBe("add");
		expect(kindFor("error")).toBe("write_unchecked");
	});

	test("Edit carries old and new text under a header that says where it applies; replace_all says so", () => {
		const one = parseClaudeRequest(
			body("Edit", {
				file_path: "/work/project/a.txt",
				old_string: "foo",
				new_string: "bar",
				replace_all: false,
			}),
			ctx({ fs: fsPort({}) }),
		);
		expect(one?.claude?.changes[0]).toMatchObject({ kind: "update" });
		expect(one?.claude?.changes[0]?.diff).toBe(
			"@@ replaces this text where it matches; positions aren't known @@\n-foo\n+bar",
		);
		expect(editDiff("a\nb", "c", true)).toBe("@@ replaces every match in the file @@\n-a\n-b\n+c");
	});

	test("NotebookEdit shows the cell and the new source", () => {
		const parsed = parseClaudeRequest(
			body("NotebookEdit", {
				notebook_path: "/work/project/n.ipynb",
				cell_id: "c0",
				new_source: "print(1)",
			}),
			ctx({ fs: fsPort({}) }),
		);
		expect(parsed?.claude?.changes[0]?.diff).toBe("@@ replace cell c0 @@\n+print(1)");
	});

	test("WebFetch and an outside Read are claude_tool requests with their target", () => {
		expect(
			parseClaudeRequest(body("WebFetch", { url: "https://example.com/a", prompt: "p" }), ctx()),
		).toMatchObject({
			kind: "claude_tool",
			reason: "p",
			claude: { tool: "WebFetch", target: "https://example.com/a" },
		});
		expect(
			parseClaudeRequest(
				body("Read", { file_path: "/etc/hosts", limit: 1 }),
				ctx({ fs: fsPort({}) }),
			),
		).toMatchObject({ kind: "claude_tool", claude: { tool: "Read", target: "/etc/hosts" } });
	});

	test("unknown keys are decline-only, incl. a background Bash; false is not set", () => {
		const reasons = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
			parseClaudeRequest(body("Bash", { command: "ls", ...input }, extra), ctx())?.declineOnly;
		expect(reasons({ run_in_background: true })).toEqual(["unknown_param"]);
		expect(reasons({ run_in_background: false })).toEqual([]);
		expect(reasons({ dangerouslyDisableSandbox: true })).toEqual(["unknown_param"]);
		expect(reasons({ surprise: 1 })).toEqual(["unknown_param"]);
		expect(reasons({ surprise: null })).toEqual([]);
		expect(reasons({}, { a_new_top_level_key: "x" })).toEqual(["unknown_param"]);
		// A key that exists on every object is still unknown, never inherited.
		const proto = JSON.parse('{"command":"ls","__proto__":{"x":1},"constructor":"y"}');
		expect(parseClaudeRequest(body("Bash", proto), ctx())?.declineOnly).toEqual(["unknown_param"]);
	});

	test("requires_user_interaction, an unlisted tool and an unstable input are decline-only with their own reason", () => {
		expect(
			parseClaudeRequest(
				body("Bash", { command: "ls" }, { requires_user_interaction: true }),
				ctx(),
			)?.declineOnly,
		).toEqual(["requires_interaction"]);
		expect(parseClaudeRequest(body("Agent", { prompt: "x" }), ctx())?.declineOnly).toContain(
			"unknown_tool",
		);
		expect(
			parseClaudeRequest(body("Bash", { command: "ls" }), ctx({ inputStable: false }))?.declineOnly,
		).toEqual(["input_not_stable"]);
	});

	test("a path that isn't a full path is decline-only: ~/x, ~user/x and a relative one, for every file tool", () => {
		for (const bad of ["~/x", "~user/x", "rel/x", "./x", "../x"]) {
			for (const [tool, input] of [
				["Write", { file_path: bad, content: "x" }],
				["Edit", { file_path: bad, old_string: "a", new_string: "b" }],
				["NotebookEdit", { notebook_path: bad, new_source: "x" }],
				["Read", { file_path: bad }],
			] as const) {
				expect(
					parseClaudeRequest(body(tool, input), ctx({ fs: fsPort({}) }))?.declineOnly,
					`${tool} ${bad}`,
				).toContain("path_not_absolute");
			}
		}
		expect(
			parseClaudeRequest(
				body("Write", { file_path: "/work/project/x", content: "x" }),
				ctx({ fs: fsPort({}) }),
			)?.declineOnly,
		).toEqual([]);
	});

	test("a link whose target can't be found (dangling, or a loop) is symlink_target, not 'Replaces'", () => {
		const port: ClaudeFsPort = {
			realpath: () => {
				throw Object.assign(new Error("loop"), { code: "ELOOP" });
			},
			exists: () => "yes",
			isSymlink: (path) => path === "/work/project/link",
		};
		for (const tool of ["Write", "Edit", "NotebookEdit"] as const) {
			const input =
				tool === "Write"
					? { file_path: "/work/project/link", content: "x" }
					: tool === "Edit"
						? { file_path: "/work/project/link", old_string: "a", new_string: "b" }
						: { notebook_path: "/work/project/link", new_source: "x" };
			expect(parseClaudeRequest(body(tool, input), ctx({ fs: port }))?.declineOnly, tool).toContain(
				"symlink_target",
			);
		}
		// A dangling link higher up the path is caught the same way.
		const ancestor: ClaudeFsPort = {
			realpath: () => {
				throw new Error("ENOENT");
			},
			exists: () => "no",
			isSymlink: (path) => path === "/work/project/dir",
		};
		expect(
			parseClaudeRequest(
				body("Write", { file_path: "/work/project/dir/new.txt", content: "x" }),
				ctx({ fs: ancestor }),
			)?.declineOnly,
		).toContain("symlink_target");
	});

	test("with no config directory known, a path under a projects/<x>/memory segment or ~/.claude is agent_memory, and so is a command naming it", () => {
		const noDir = ctx({ configDir: null, fs: fsPort({}) });
		for (const path of [
			"/home/u/.claude/projects/p/memory/a.md",
			"/home/u/.claude/CLAUDE.md",
			"/srv/x/projects/p/MEMORY/a",
		]) {
			expect(
				parseClaudeRequest(body("Write", { file_path: path, content: "x" }), noDir)?.declineOnly,
				path,
			).toContain("agent_memory");
		}
		expect(
			parseClaudeRequest(body("Write", { file_path: "/work/project/a.txt", content: "x" }), noDir)
				?.declineOnly,
		).toEqual([]);
		expect(
			parseClaudeRequest(
				body("Bash", { command: "echo x > ~/.claude/projects/p/memory/a.md" }),
				noDir,
			)?.declineOnly,
		).toContain("agent_memory");
	});

	test("NotebookEdit in delete mode shows no new source as added lines", () => {
		const parsed = parseClaudeRequest(
			body("NotebookEdit", {
				notebook_path: "/work/project/n.ipynb",
				cell_id: "c0",
				edit_mode: "delete",
				new_source: "SECRET-SRC",
			}),
			ctx({ fs: fsPort({}) }),
		);
		const diff = parsed?.claude?.changes[0]?.diff ?? "";
		expect(diff).toBe("@@ delete cell c0 @@");
		expect(diff).not.toContain("SECRET-SRC");
		expect(
			parseClaudeRequest(
				body("NotebookEdit", {
					notebook_path: "/work/project/n.ipynb",
					cell_id: "c0",
					edit_mode: "delete",
				}),
				ctx({ fs: fsPort({}) }),
			),
		).not.toBeNull();
	});

	test("a request that can't be reported at all is null", () => {
		expect(parseClaudeRequest(null, ctx())).toBeNull();
		expect(parseClaudeRequest({ input: {} }, ctx())).toBeNull();
		expect(
			parseClaudeRequest(body("Bash", { command: "ls" }, { tool_use_id: "x".repeat(200) }), ctx()),
		).toBeNull();
		expect(parseClaudeRequest(body("Write", { file_path: "/a" }), ctx())).toBeNull();
	});

	describe("on a real disk: links and Claude's memory directory", () => {
		const roots: string[] = [];
		afterEach(() => {
			for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
		});
		function tree() {
			const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-approvals-")));
			roots.push(root);
			const real = join(root, "real");
			const outside = join(root, "outside");
			const cfg = join(root, "cfg");
			mkdirSync(real, { recursive: true });
			mkdirSync(outside, { recursive: true });
			mkdirSync(join(cfg, "projects", "proj", "memory"), { recursive: true });
			return { root: real, outside, cfg, realRoot: root };
		}

		test("a link to somewhere else is symlink_target, and the exclude rules see where it really points", () => {
			const t = tree();
			symlinkSync(t.outside, join(t.root, "link"));
			const parsed = parseClaudeRequest(
				body("Write", { file_path: join(t.root, "link", "new.txt"), content: "x" }),
				ctx({ cwd: t.root, configDir: t.cfg, fs: REAL_FS }),
			);
			expect(parsed?.declineOnly).toContain("symlink_target");
			expect(parsed?.claude?.excludePaths).toContain(
				join(resolveThroughLinks(t.outside, REAL_FS), "new.txt"),
			);
		});

		test("a dangling link and a link loop on a real disk are symlink_target", () => {
			const t = tree();
			symlinkSync(join(t.realRoot, "nowhere"), join(t.root, "dangling"));
			symlinkSync(join(t.root, "loop-b"), join(t.root, "loop-a"));
			symlinkSync(join(t.root, "loop-a"), join(t.root, "loop-b"));
			for (const name of ["dangling", "loop-a"]) {
				const parsed = parseClaudeRequest(
					body("Write", { file_path: join(t.root, name), content: "x" }),
					ctx({ cwd: t.root, configDir: t.cfg, fs: REAL_FS }),
				);
				expect(parsed?.declineOnly, name).toContain("symlink_target");
			}
		});

		test("a plain file under the directory is neither", () => {
			const t = tree();
			const parsed = parseClaudeRequest(
				body("Write", { file_path: join(t.root, "ok.txt"), content: "x" }),
				ctx({ cwd: t.root, configDir: t.cfg, fs: REAL_FS }),
			);
			expect(parsed?.declineOnly).toEqual([]);
			expect(parsed?.claude?.changes[0]?.kind).toBe("add");
		});

		test("a write into the memory directory is agent_memory for Write, Edit and NotebookEdit; Read stays", () => {
			const t = tree();
			const memory = join(t.cfg, "projects", "proj", "memory", "note.md");
			for (const [tool, input] of [
				["Write", { file_path: memory, content: "x" }],
				["Edit", { file_path: memory, old_string: "a", new_string: "b" }],
				["NotebookEdit", { notebook_path: memory, new_source: "x" }],
			] as const) {
				const parsed = parseClaudeRequest(
					body(tool, input),
					ctx({ cwd: t.root, configDir: t.cfg, fs: REAL_FS }),
				);
				expect(parsed?.declineOnly, tool).toContain("agent_memory");
			}
			expect(
				parseClaudeRequest(
					body("Read", { file_path: memory }),
					ctx({ cwd: t.root, configDir: t.cfg, fs: REAL_FS }),
				)?.declineOnly,
			).not.toContain("agent_memory");
		});

		test("a link into the memory directory is caught on the real path", () => {
			const t = tree();
			symlinkSync(join(t.cfg, "projects", "proj", "memory"), join(t.root, "mem"));
			const parsed = parseClaudeRequest(
				body("Write", { file_path: join(t.root, "mem", "a.md"), content: "x" }),
				ctx({ cwd: t.root, configDir: t.cfg, fs: REAL_FS }),
			);
			expect(parsed?.declineOnly).toEqual(
				expect.arrayContaining(["agent_memory", "symlink_target"]),
			);
		});
	});

	test("the memory path matcher: segments, dot-dot, a sibling, APFS case, and a Bash text naming it", () => {
		const cfg = "/home/user/.claude";
		expect(isAgentMemoryPath(`${cfg}/projects/p/memory/x.md`, cfg)).toBe(true);
		expect(isAgentMemoryPath(`${cfg}/projects/p/memory`, cfg)).toBe(true);
		expect(isAgentMemoryPath(`${cfg}/projects/p/../p/memory/x.md`, cfg)).toBe(true);
		expect(isAgentMemoryPath(`${cfg}/projects/p/MEMORY/x.md`, cfg)).toBe(true);
		expect(isAgentMemoryPath(`${cfg}/projects/p/memory-x/a`, cfg)).toBe(false);
		expect(isAgentMemoryPath(`${cfg}/projects/p/q/memory/a`, cfg)).toBe(false);
		expect(isAgentMemoryPath("/work/memory/a", cfg)).toBe(false);
		expect(commandNamesAgentMemory(`echo x > ${cfg}/projects/p/memory/a.md`, cfg)).toBe(true);
		expect(commandNamesAgentMemory("echo x > ~/.claude/projects/p/memory/a.md", cfg)).toBe(true);
		expect(commandNamesAgentMemory("echo x > memory/a.md", cfg)).toBe(false);
		expect(commandNamesAgentMemory(`ls ${cfg}/projects/p/memory-x`, cfg)).toBe(false);
	});

	test("a Bash command naming the memory directory is agent_memory", () => {
		const parsed = parseClaudeRequest(
			body("Bash", { command: "echo hi > /cfg/projects/p/memory/a.md" }),
			ctx({ configDir: "/cfg" }),
		);
		expect(parsed?.declineOnly).toEqual(["agent_memory"]);
	});
});

// ======================================================================================================
describe("the exact line on the wire", () => {
	test("a person's accept leaves the stream as one byte-exact control_response, an unstable one as a deny", async () => {
		const clock = clockPair();
		const stub = stubGate();
		const tracker = createCodexApprovalTracker({
			gate: stub.gate,
			now: clock.now,
			monotonic: clock.monotonic,
		});
		tracker.setServerFeatures(BOTH);
		const port = tracker.attachClaude(
			{ sessionId: SESSION, cwd: CWD, warn: async () => {} },
			{ mode: "ask", configDir: "/cfg", verdict: SUPPORTED },
		);
		const written: string[] = [];
		const link = new ClaudeLink({ write: (l) => void written.push(l), closeStdin: () => {} });
		link.client.onServerRequest((call) => {
			port.onToolRequest(call, {
				answer: (id, body) => link.client.respond(id, body),
				markDecidedElsewhere: () => {},
				turnId: TURN,
				inputStable: link.requestInputStable(String(call.id)),
			});
		});
		const line = (id: string, input: string) =>
			`{"type":"control_request","request_id":"${id}","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"t-${id}","input":${input}}}\n`;
		link.receive(line("r1", '{"command":"echo hi","description":"d"}'));
		link.receive(line("r2", '{"command":"a","command":"b"}'));
		await settle();
		stub.script.sync = async () => ({
			answers: [
				{ approvalId: "ap-1", decision: "accept", revision: 1 },
				{ approvalId: "ap-2", decision: "accept", revision: 1 },
			],
		});
		await tracker.tick();
		await link.flush();
		expect(written).toEqual([
			'{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"behavior":"allow","updatedInput":{"command":"echo hi","description":"d"}}}}',
			`{"type":"control_response","response":{"subtype":"success","request_id":"r2","response":{"behavior":"deny","message":${JSON.stringify(CLAUDE_HOST_DECLINE_MESSAGE)}}}}`,
		]);
	});
});

describe("the stream's own checks on an input", () => {
	test("an input that doesn't survive a round trip is unstable: 1.0, 2^53+1, pretty-printed; compact, non-BMP and __proto__ are stable", () => {
		const stableFor = (rawInput: string) => {
			const written: string[] = [];
			const link = new ClaudeLink({ write: (l) => void written.push(l), closeStdin: () => {} });
			link.client.onServerRequest(() => {});
			link.receive(
				`{"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool","tool_name":"Bash","tool_use_id":"t","input":${rawInput}}}\n`,
			);
			return link.requestInputStable("r");
		};
		expect(stableFor('{"command":"ls"}')).toBe(true);
		expect(stableFor('{"command":"echo 😀"}')).toBe(true);
		expect(stableFor('{"command":"ls","__proto__":{"a":1}}')).toBe(true);
		expect(stableFor('{"command":"ls","n":1.0}')).toBe(false);
		expect(stableFor('{"command":"ls","n":9007199254740993}')).toBe(false);
		expect(stableFor('{ "command": "ls" }')).toBe(false);
		// A repeated key: parsing keeps the last, so echoing the parsed object would say something Claude didn't.
		expect(stableFor('{"command":"a","command":"b"}')).toBe(false);
		expect(
			new ClaudeLink({ write: () => {}, closeStdin: () => {} }).requestInputStable("none"),
		).toBe(false);
	});
});

// ======================================================================================================
describe("reporting a request", () => {
	test("a Bash request is reported under the fork's ids with the id as JSON, and its fields come from the request", async () => {
		const a = armed();
		const toolUseId = a.request("req-1", "Bash", { command: "ls -la", description: "list" });
		await settle();
		expect(a.reports).toHaveLength(1);
		const { sessionId, body } = a.reports[0] as (typeof a.reports)[number];
		expect(sessionId).toBe(SESSION);
		expect(body).toMatchObject({
			v: 1,
			requestKind: "command",
			rpcId: '"req-1"',
			threadId: SESSION,
			turnId: TURN,
			itemId: toolUseId,
			providerApprovalId: null,
			command: "ls -la",
			cwd: CWD,
			reason: "list",
			revision: 1,
			declineOnly: [],
		});
		expect(body.runtimeEpoch).toMatch(/^[0-9a-f-]{36}$/);
	});

	test("a Write is a file_change with the one change; a WebFetch is a claude_tool", async () => {
		const a = armed();
		a.request("w1", "Write", { file_path: "/work/project/x.txt", content: "hello" });
		a.request("f1", "WebFetch", { url: "https://example.com", prompt: "summarise" });
		await settle();
		const [write, fetch] = a.reports.map((r) => r.body);
		expect(write).toMatchObject({
			requestKind: "file_change",
			changes: [{ path: "/work/project/x.txt", kind: "add", diff: "hello" }],
		});
		expect(fetch).toMatchObject({
			requestKind: "claude_tool",
			tool: "WebFetch",
			target: "https://example.com",
			reason: "summarise",
		});
	});

	test("a request over the report bounds is cut and says so", async () => {
		const a = armed();
		a.request("big", "Bash", { command: "x".repeat(20_000) });
		await settle();
		expect(a.reports[0]?.body.truncated).toBe(true);
		expect((a.reports[0]?.body.command ?? "").length).toBeLessThanOrEqual(16 * 1024);
	});

	test("a tool no one listed is reported decline-only, and an accept for it is a decline", async () => {
		const a = armed();
		a.request("u1", "Agent", { prompt: "x" });
		await settle();
		expect(a.reports[0]?.body.declineOnly).toContain("unknown_tool");
		a.script.sync = async () => ({ answers: [a.answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		expect(a.written.map((w) => w.body.behavior)).toEqual(["deny"]);
	});

	test("a person's decline whose write didn't go out leaves the host's own words for a later decline", async () => {
		const a = armed();
		let first = true;
		a.request(
			"r1",
			"Bash",
			{ command: "ls" },
			{},
			{
				answer: (id, body) => {
					if (first) {
						first = false;
						return false;
					}
					a.written.push({ id, body });
					return true;
				},
			},
		);
		await settle();
		a.script.sync = async () => ({ answers: [a.answerOf("ap-1", "decline")] });
		await a.tracker.tick();
		expect(a.written).toEqual([]);
		a.port.fence();
		expect(a.written[0]?.body.message).toBe(CLAUDE_HOST_DECLINE_MESSAGE);
	});

	test("a Claude report the server won't take stops Claude's requests only: Codex stays answerable", async () => {
		const a = armed();
		const codex = new RpcClient({ write: () => {}, close: () => {} });
		const handle = a.tracker.attachClient(codex, {
			sessionId: "codex-2",
			cwd: CWD,
			warn: async () => {},
		});
		a.tracker.setVerdict(handle, SUPPORTED);
		a.script.report = async (sessionId) => {
			if (sessionId === SESSION) throw new SupervisorRequestError(404, "Not Found");
			return { approvalId: "ap-codex" };
		};
		a.request("r1", "Bash", { command: "ls" });
		await settle();
		expect(a.written.map((w) => w.body.behavior)).toEqual(["deny"]);
		// Claude is off now; a new Claude request is declined on arrival, and a Codex one is still reported.
		a.request("r2", "Bash", { command: "pwd" });
		codex.receive(
			`${JSON.stringify({ id: 0, method: "item/commandExecution/requestApproval", params: { kind: "command", threadId: "t", turnId: "u", itemId: "i", startedAtMs: 1, environmentId: "local", reason: null, command: "ls", cwd: CWD, availableDecisions: ["accept", "cancel"] } })}\n`,
		);
		await settle();
		expect(a.written.map((w) => w.id)).toEqual(["r1", "r2"]);
		// Only r1 was ever sent for the fork (r2 was declined on arrival); the Codex request was reported.
		expect(a.reports.map((r) => r.sessionId).sort()).toEqual(["codex-2", SESSION]);
	});

	test("an excluded session or path is declined locally and said nowhere", async () => {
		const a = armed();
		a.script.excluded.add("/work/project/secret.txt");
		a.request("e1", "Write", { file_path: "/work/project/secret.txt", content: "x" });
		await settle();
		expect(a.reports).toEqual([]);
		expect(a.written).toHaveLength(1);
		expect(a.written[0]?.body).toEqual(denyResponse(CLAUDE_HOST_DECLINE_MESSAGE));
		expect(a.warnings).toEqual([]);

		const b = armed();
		b.script.verdict = "excluded";
		b.request("e2", "Bash", { command: "ls" });
		await settle();
		expect(b.reports).toEqual([]);
		expect(b.written).toHaveLength(1);
	});

	test("a request with a bad shape is declined with the host's words and one fixed warning", async () => {
		const a = armed();
		a.port.onToolRequest(
			{
				id: "m1",
				method: "claude/can_use_tool",
				params: { tool_name: "Bash", input: { command: "ls" } },
			},
			{
				answer: (id, body) => {
					a.written.push({ id, body });
					return true;
				},
				markDecidedElsewhere: () => {},
				turnId: TURN,
				inputStable: true,
			},
		);
		await settle();
		expect(a.written).toHaveLength(1);
		expect(a.reports).toEqual([]);
		expect(a.warnings.map((w) => w.detail.reason)).toEqual(["malformed_request"]);
		expect(a.warnings[0]?.content).toBe(
			"Claude asked to use a tool. AgentPulse declined it automatically. The request wasn't in a form AgentPulse understands.",
		);
	});
});

// ======================================================================================================
describe("answering", () => {
	test("accept writes allow with the held input and nothing else; decline and cancel write deny", async () => {
		const input = { command: "npm test", description: "run the tests" };
		const a = armed();
		a.request("r1", "Bash", input);
		a.request("r2", "Bash", { command: "ls" });
		a.request("r3", "Bash", { command: "pwd" });
		await settle();
		a.script.sync = async () => ({
			answers: [
				a.answerOf("ap-1", "accept"),
				a.answerOf("ap-2", "decline"),
				a.answerOf("ap-3", "cancel"),
			],
		});
		await a.tracker.tick();
		expect(a.written).toEqual([
			{ id: "r1", body: { behavior: "allow", updatedInput: input } },
			{ id: "r2", body: { behavior: "deny", message: CLAUDE_PERSON_DECLINE_MESSAGE } },
			{
				id: "r3",
				body: { behavior: "deny", message: CLAUDE_PERSON_STOP_MESSAGE, interrupt: true },
			},
		]);
		for (const w of a.written) expect(JSON.stringify(w.body)).not.toContain("updatedPermissions");
	});

	test("the allow is byte-equal to the recorded shape for every recorded request", async () => {
		for (const { id, body: recorded } of recordedRequests().filter((r) =>
			["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "Read"].includes(r.body.tool_name),
		)) {
			const a = armed();
			a.port.onToolRequest(
				{ id, method: "claude/can_use_tool", params: recorded },
				{
					answer: (rid, body) => {
						a.written.push({ id: rid, body });
						return true;
					},
					markDecidedElsewhere: () => {},
					turnId: TURN,
					inputStable: true,
				},
			);
			await settle();
			const declineOnly = a.reports[0]?.body.declineOnly ?? [];
			if (declineOnly.length > 0) continue;
			a.script.sync = async () => ({ answers: [a.answerOf("ap-1", "accept")] });
			await a.tracker.tick();
			expect(a.written, id).toEqual([{ id, body: allowResponse(recorded.input) }]);
			expect(JSON.stringify(a.written[0]?.body), id).toBe(
				JSON.stringify({ behavior: "allow", updatedInput: recorded.input }),
			);
		}
	});

	test("a changed revision, a mismatched id and an unstable input are declines, never an allow", async () => {
		const a = armed();
		await openBash(a);
		a.script.sync = async () => ({ answers: [a.answerOf("ap-1", "accept", 9)] });
		await a.tracker.tick();
		expect(a.written.map((w) => w.body.behavior)).toEqual(["deny"]);

		const b = armed();
		b.request("u", "Bash", { command: "ls" }, {}, { inputStable: false });
		await settle();
		expect(b.reports[0]?.body.declineOnly).toEqual(["input_not_stable"]);
		b.script.sync = async () => ({ answers: [b.answerOf("ap-1", "accept")] });
		await b.tracker.tick();
		expect(b.written.map((w) => w.body.behavior)).toEqual(["deny"]);

		const c = armed();
		await openBash(c);
		c.script.sync = async () => ({ answers: [c.answerOf("not-an-id", "accept")] });
		await c.tracker.tick();
		expect(c.written).toEqual([]);
	});

	test("an accept in a sync response that took over 3 s becomes a decline", async () => {
		const a = armed();
		await openBash(a);
		a.script.sync = async () => {
			a.clock.advance(3_100);
			return { answers: [a.answerOf("ap-1", "accept")] };
		};
		await a.tracker.tick();
		expect(a.written.map((w) => w.body.behavior)).toEqual(["deny"]);
		expect(a.written[0]?.body.message).toBe(CLAUDE_HOST_DECLINE_MESSAGE);
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(outcomesSent(a)).toContain("ap-1:declined_slow_response:decline");
	});

	test("exactly 3000 ms is still in time; 3001 ms is not", async () => {
		const at = async (ms: number) => {
			const a = armed();
			await openBash(a);
			a.script.sync = async () => {
				a.clock.advance(ms);
				return { answers: [a.answerOf("ap-1", "accept")] };
			};
			await a.tracker.tick();
			return a.written.map((w) => w.body.behavior);
		};
		expect(await at(3_000)).toEqual(["allow"]);
		expect(await at(3_001)).toEqual(["deny"]);
	});

	test("Stop: an accept is never written after the fence, whichever step it was at", async () => {
		// answered, not issued: the fence lands before the sync that carries the accept
		const a = armed();
		await openBash(a);
		a.port.fence();
		a.script.sync = async () => ({ answers: [a.answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		expect(a.written.map((w) => w.body.behavior)).toEqual(["deny"]);

		// issued and written, then the fence: one allow only, and the row isn't touched again
		const b = armed();
		await openBash(b);
		b.script.sync = async () => ({ answers: [b.answerOf("ap-1", "accept")] });
		await b.tracker.tick();
		b.port.fence();
		expect(b.written.map((w) => w.body.behavior)).toEqual(["allow"]);

		// the fence between two requests: the second, arriving after it, is denied on arrival
		const c = armed();
		await openBash(c, "r1");
		c.port.fence();
		c.request("r2", "Bash", { command: "ls" });
		await settle();
		expect(c.written.map((w) => `${w.id}:${w.body.behavior}`)).toEqual(["r1:deny", "r2:deny"]);
		expect(c.warnings.map((w) => w.detail.reason)).toEqual(["fenced"]);
	});

	test("the turn ending closes what is held; the next sync issues nothing", async () => {
		const a = armed();
		await openBash(a);
		a.port.turnEnded();
		a.script.sync = async () => ({ answers: [a.answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		await a.tracker.tick();
		expect(a.written).toEqual([]);
		expect(outcomesSent(a)).toContain("ap-1:resolved_before_response:null");
	});
});

// ======================================================================================================
describe("something else decided (T10)", () => {
	test("a cancel before the report left: no row, one fixed warning, nothing written, nothing ever reported", async () => {
		const a = armed();
		a.script.offline = true;
		const toolUseId = a.request("r1", "Bash", { command: "ls" });
		await settle();
		a.port.cancel("r1");
		a.script.offline = false;
		await a.tracker.tick();
		await a.tracker.tick();
		expect(a.reports).toEqual([]);
		expect(a.syncs).toEqual([]);
		expect(a.written).toEqual([]);
		expect(a.elsewhere).toEqual([toolUseId]);
		expect(a.warnings.map((w) => w.detail.reason)).toEqual(["decided_elsewhere"]);
		expect(a.warnings[0]?.content).toBe(
			"Claude asked to use a tool. AgentPulse declined it automatically. Something else on this machine decided it first.",
		);
	});

	test("a cancel while the report is in flight: the next sync closes decided_elsewhere, not the clock", async () => {
		const a = armed();
		let release!: () => void;
		a.script.report = () =>
			new Promise((resolve) => {
				release = () => resolve({ approvalId: "ap-1" });
			});
		const toolUseId = a.request("r1", "Bash", { command: "ls" });
		await settle();
		a.port.cancel("r1");
		release();
		await settle();
		expect(a.elsewhere).toEqual([toolUseId]);
		await a.tracker.tick();
		expect(outcomesSent(a)).toEqual(["ap-1:decided_elsewhere:null"]);
		expect(a.written).toEqual([]);
	});

	test("a cancel after a report: decided_elsewhere, once, and a later answer for it writes nothing", async () => {
		const a = armed();
		const toolUseId = await openBash(a);
		a.port.cancel("r1");
		a.script.sync = async () => ({ answers: [a.answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		await a.tracker.tick();
		expect(a.written).toEqual([]);
		expect(a.elsewhere).toEqual([toolUseId]);
		expect(outcomesSent(a).filter((o) => o.includes("decided_elsewhere"))).toHaveLength(1);
	});

	test("a cancel after our own accept leaves approved_sent: exactly one write on the wire", async () => {
		const a = armed();
		const toolUseId = await openBash(a);
		a.script.sync = async () => ({ answers: [a.answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		a.port.cancel("r1");
		a.port.toolResult(toolUseId, {
			isError: false,
			nonExecutionKind: null,
			decisionSource: "user_temporary",
			content: "ok",
		});
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(a.written.map((w) => w.body.behavior)).toEqual(["allow"]);
		expect(outcomesSent(a)).toEqual([
			"ap-1:respond_sent:accept",
			"ap-1:resolved_after_response:accept",
		]);
		expect(a.elsewhere).toEqual([]);
	});

	test("a cancel for an id nobody holds is ignored", async () => {
		const a = armed();
		await openBash(a);
		a.port.cancel("nobody");
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(outcomesSent(a)).toEqual([]);
	});

	test("a tool_result for a request still waiting for a person closes it decided_elsewhere", async () => {
		const a = armed();
		const toolUseId = await openBash(a);
		a.port.toolResult(toolUseId, {
			isError: false,
			nonExecutionKind: null,
			decisionSource: "hook",
			content: "ok",
		});
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(outcomesSent(a)).toEqual(["ap-1:decided_elsewhere:null"]);
		expect(a.elsewhere).toEqual([toolUseId]);
	});

	describe("after our deny", () => {
		async function denied(a: Armed) {
			const toolUseId = await openBash(a);
			a.script.sync = async () => ({ answers: [a.answerOf("ap-1", "decline")] });
			await a.tracker.tick();
			a.script.sync = async () => ({});
			expect(a.written.map((w) => w.body.behavior)).toEqual(["deny"]);
			return toolUseId;
		}
		const refusal: ClaudeToolResultInfo = {
			isError: true,
			nonExecutionKind: "permission-rule",
			decisionSource: "user_reject",
			content: CLAUDE_PERSON_DECLINE_MESSAGE,
		};

		test("the harness's refusal on a person's word reports declined: resolved_after_response", async () => {
			const a = armed();
			const toolUseId = await denied(a);
			a.port.toolResult(toolUseId, refusal);
			await a.tracker.tick();
			expect(outcomesSent(a)).toContain("ap-1:resolved_after_response:decline");
			expect(outcomesSent(a).some((o) => o.includes("decided_elsewhere"))).toBe(false);
			expect(a.written).toHaveLength(1);
		});

		test("anything else first is decided_elsewhere, never declined, posted once", async () => {
			const cases: Array<Partial<ClaudeToolResultInfo>> = [
				// a Bash that ran and failed: is_error, no non_execution_kind (bash_fail)
				{ nonExecutionKind: null, decisionSource: "user_temporary", content: "Exit code 3" },
				// a non-error result
				{ isError: false, nonExecutionKind: null, decisionSource: "user_temporary", content: "ok" },
				// a refusal by config or a hook, not a person's
				{ decisionSource: "config" },
				{ decisionSource: "hook" },
				// our words missing
				{ content: "something else" },
			];
			for (const over of cases) {
				const a = armed();
				const toolUseId = await denied(a);
				a.port.toolResult(toolUseId, { ...refusal, ...over });
				await a.tracker.tick();
				await a.tracker.tick();
				const sent = outcomesSent(a);
				expect(
					sent.filter((o) => o.includes("decided_elsewhere")),
					JSON.stringify(over),
				).toHaveLength(1);
				expect(sent.some((o) => o.includes("resolved_after_response"))).toBe(false);
			}
			const b = armed();
			await denied(b);
			b.port.cancel("r1");
			await b.tracker.tick();
			expect(outcomesSent(b).filter((o) => o.includes("decided_elsewhere"))).toHaveLength(1);
		});

		test("silence: 4.9 s then the proof is declined; 5.1 s is decided_elsewhere and stays so", async () => {
			const early = armed();
			const t1 = await denied(early);
			early.timers.advance(CLAUDE_DECLINE_EVIDENCE_WAIT_MS - 100);
			early.port.toolResult(t1, refusal);
			await early.tracker.tick();
			expect(outcomesSent(early)).toContain("ap-1:resolved_after_response:decline");

			const late = armed();
			const t2 = await denied(late);
			late.timers.advance(CLAUDE_DECLINE_EVIDENCE_WAIT_MS + 100);
			late.port.toolResult(t2, refusal);
			await late.tracker.tick();
			const sent = outcomesSent(late);
			expect(sent.filter((o) => o.includes("decided_elsewhere"))).toHaveLength(1);
			expect(sent.some((o) => o.includes("resolved_after_response"))).toBe(false);
		});

		test("the turn's end first, a fence and a dispose all leave the timer cleared", async () => {
			const ended = armed();
			await denied(ended);
			ended.port.turnEnded();
			ended.timers.advance(CLAUDE_DECLINE_EVIDENCE_WAIT_MS + 1000);
			await ended.tracker.tick();
			expect(outcomesSent(ended).some((o) => o.includes("decided_elsewhere"))).toBe(false);
			expect(outcomesSent(ended)).toContain("ap-1:resolved_before_response:decline");

			const disposed = armed();
			await denied(disposed);
			disposed.port.dispose();
			disposed.timers.advance(CLAUDE_DECLINE_EVIDENCE_WAIT_MS + 1000);
			await disposed.tracker.tick();
			expect(outcomesSent(disposed).some((o) => o.includes("decided_elsewhere"))).toBe(false);
		});
	});

	test("a host decline (a fence) is not a person's: the cancel that follows our own interrupt changes nothing", async () => {
		const a = armed();
		await openBash(a);
		a.port.fence();
		a.port.cancel("r1");
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(a.written[0]?.body.message).toBe(CLAUDE_HOST_DECLINE_MESSAGE);
		expect(outcomesSent(a)).toEqual(["ap-1:declined_local:decline"]);
	});
});

// ======================================================================================================
describe("the server rolled back past a feature", () => {
	test("Codex stays answerable while a Claude request is declined locally with one fixed warning and never reported", async () => {
		const a = armed({ features: ["codex_approvals"] });
		// A live Codex request on the same tracker.
		const written: any[] = [];
		const codex = new RpcClient({
			write: (frame) => written.push(JSON.parse(frame)),
			close: () => {},
		});
		const codexHandle = a.tracker.attachClient(codex, {
			sessionId: "codex-1",
			cwd: CWD,
			warn: async () => {},
		});
		a.tracker.setVerdict(codexHandle, SUPPORTED);
		codex.receive(
			`${JSON.stringify({
				id: 0,
				method: "item/commandExecution/requestApproval",
				params: {
					kind: "command",
					threadId: "t",
					turnId: "u",
					itemId: "i",
					startedAtMs: 1,
					environmentId: "local",
					reason: null,
					command: "npm test",
					cwd: CWD,
					availableDecisions: ["accept", "cancel"],
				},
			})}\n`,
		);
		a.request("c1", "Bash", { command: "ls" });
		await settle();
		expect(a.reports.map((r) => r.sessionId)).toEqual(["codex-1"]);
		expect(a.written.map((w) => w.body.behavior)).toEqual(["deny"]);
		expect(a.warnings.map((w) => w.detail.reason)).toEqual(["approvals_not_enabled"]);
		a.script.sync = async () => ({ answers: [a.answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		expect(written).toEqual([{ id: 0, result: { decision: "accept" } }]);
	});

	test("decided_elsewhere is withheld without claude_approvals: the server hears an accept whose end is unknown, which reads may-have-run", async () => {
		const a = armed();
		await openBash(a);
		a.port.cancel("r1");
		a.tracker.setServerFeatures(["codex_approvals"]);
		await a.tracker.tick();
		await a.tracker.tick();
		expect(outcomesSent(a)).toEqual(["ap-1:runtime_gone_after_response:accept"]);
		expect(JSON.stringify(a.syncs)).not.toContain("decided_elsewhere");
	});

	test("turning claude_approvals off declines what is held for Claude and leaves Codex's", async () => {
		const a = armed();
		await openBash(a);
		a.tracker.setServerFeatures(["codex_approvals"]);
		expect(a.written.map((w) => w.body.behavior)).toEqual(["deny"]);
	});
});

// ======================================================================================================
describe("crash and shared sync", () => {
	test("a child that dies with requests pending: runtime_gone, nothing answerable afterwards", async () => {
		const a = armed();
		await openBash(a);
		a.port.dispose();
		a.script.sync = async () => ({ answers: [a.answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		expect(a.written).toEqual([]);
		expect(outcomesSent(a)).toContain("ap-1:runtime_gone:null");
	});

	test("an accepted request whose child died reports runtime_gone_after_response", async () => {
		const a = armed();
		await openBash(a);
		a.script.sync = async () => ({ answers: [a.answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		a.port.dispose();
		a.script.sync = async () => ({});
		await a.tracker.tick();
		expect(outcomesSent(a)).toContain("ap-1:runtime_gone_after_response:accept");
	});

	test("Codex and Claude held together are one sync, one request, with both in it", async () => {
		const a = armed();
		const codex = new RpcClient({ write: () => {}, close: () => {} });
		const handle = a.tracker.attachClient(codex, {
			sessionId: "codex-1",
			cwd: CWD,
			warn: async () => {},
		});
		a.tracker.setVerdict(handle, SUPPORTED);
		codex.receive(
			`${JSON.stringify({
				id: 0,
				method: "item/commandExecution/requestApproval",
				params: {
					kind: "command",
					threadId: "t",
					turnId: "u",
					itemId: "i",
					startedAtMs: 1,
					environmentId: "local",
					reason: null,
					command: "npm test",
					cwd: CWD,
					availableDecisions: ["accept", "cancel"],
				},
			})}\n`,
		);
		await openBash(a);
		await a.tracker.tick();
		expect(a.syncs).toHaveLength(1);
		expect(a.syncs[0]?.live.map((l) => l.sessionId).sort()).toEqual(["codex-1", SESSION]);
	});

	test("many Claude and Codex rows together are still one sync, bounded", async () => {
		const a = armed();
		const codex = new RpcClient({ write: () => {}, close: () => {} });
		const handle = a.tracker.attachClient(codex, {
			sessionId: "codex-9",
			cwd: CWD,
			warn: async () => {},
		});
		a.tracker.setVerdict(handle, SUPPORTED);
		for (let i = 0; i < 40; i++) {
			codex.receive(
				`${JSON.stringify({ id: i, method: "item/commandExecution/requestApproval", params: { kind: "command", threadId: "t", turnId: "u", itemId: `i${i}`, startedAtMs: 1, environmentId: "local", reason: null, command: "ls", cwd: CWD, availableDecisions: ["accept", "cancel"] } })}\n`,
			);
		}
		for (let i = 0; i < 40; i++) a.request(`m${i}`, "Bash", { command: `echo ${i}` });
		await settle();
		await a.tracker.tick();
		expect(a.syncs).toHaveLength(1);
		expect(a.syncs[0]?.live.length).toBe(64);
		expect(new Set(a.syncs[0]?.live.map((l) => l.sessionId))).toEqual(
			new Set(["codex-9", SESSION]),
		);
	});
});

// ======================================================================================================
describe("where an allow can be written", () => {
	const SUPERVISOR = join(import.meta.dir, "..");
	function sources(): string[] {
		const out: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					if (entry.name !== "__fixtures__") walk(full);
				} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
			}
		};
		walk(SUPERVISOR);
		return out;
	}
	const strip = (text: string) =>
		text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

	test("allowResponse( is called in one place, inside deliverAccept, and nothing builds an allow by hand", () => {
		const files = sources();
		expect(files.length).toBeGreaterThan(20);
		const callers: string[] = [];
		const handBuilt: string[] = [];
		for (const file of files) {
			const text = strip(readFileSync(file, "utf8"));
			const name = file.slice(SUPERVISOR.length);
			for (const _ of text.matchAll(/\ballowResponse\(/g)) callers.push(name);
			for (const _ of text.matchAll(/behavior\s*:\s*["'`]allow["'`]/g)) handBuilt.push(name);
		}
		// The definition in the wire is `export const allowResponse = (`, which is not a call.
		expect(callers).toEqual(["/providers/codex-approvals.ts"]);
		expect(handBuilt).toEqual(["/providers/claude-wire.ts"]);
		const text = readFileSync(join(import.meta.dir, "codex-approvals.ts"), "utf8");
		const at = text.indexOf("allowResponse(held.parsed");
		const start = text.lastIndexOf("function deliverAccept", at);
		const end = text.indexOf("\n\t// ----", at);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(at);
		expect(text.slice(start, at)).not.toMatch(/\bawait\b/);
	});

	test("updatedPermissions and permission suggestions are never echoed anywhere in the supervisor", () => {
		for (const file of sources()) {
			const text = strip(readFileSync(file, "utf8"));
			expect(text, file).not.toMatch(/updatedPermissions/);
			expect(text, file).not.toMatch(/permission_suggestions\s*[,}\]]/);
		}
	});
});

// ======================================================================================================
// A real fake `claude` child, the stream runtime, and the real tracker's port.
describe("through the stream runtime", () => {
	const harnesses: Array<ReturnType<typeof createHarness>> = [];
	const runtimes: Array<{ dispose(): Promise<unknown> }> = [];
	afterEach(async () => {
		for (const rt of runtimes.splice(0)) await rt.dispose().catch(() => {});
		for (const h of harnesses.splice(0)) {
			h.assertCleanWire();
			h.cleanup();
		}
	});

	/** The work directory by its real path: a file under it is not "a link to somewhere else" on a Mac. */
	const workDir = (h: ReturnType<typeof createHarness>) => realpathSync(h.options().cwd);

	function wired(h: ReturnType<typeof createHarness>) {
		const clock = clockPair();
		const stub = stubGate();
		const tracker = createCodexApprovalTracker({
			gate: stub.gate,
			now: clock.now,
			monotonic: clock.monotonic,
		});
		tracker.setServerFeatures(BOTH);
		const port = tracker.attachClaude(
			{ sessionId: "22222222-2222-4222-8222-222222222222", cwd: workDir(h), warn: async () => {} },
			{ mode: "ask", configDir: join(h.root, "cfg"), verdict: SUPPORTED },
		);
		return { tracker, port, ...stub };
	}

	test("a Write request reaches the server as a card, and a person's accept is written as allow", async () => {
		const h = createHarness({
			defaultTurn: [
				INIT,
				assistantToolUse("t1", "Write", { file_path: ABS_TARGET, content: "hi" }),
				canUseTool("r1", "Write", "t1", { file_path: ABS_TARGET, content: "hi" }),
				AWAIT,
				toolResult("t1", {
					meta: { permission_decision: { decision: "accept", source: "user_temporary" } },
				}),
				resultOk,
			],
		});
		harnesses.push(h);
		const w = wired(h);
		const rt = await h.start({ approvals: w.port });
		runtimes.push(rt);
		rt.beginSettle();
		rt.settled();
		const sent = await rt.sendPrompt("go", "act-1");
		await until(() => w.reports.length === 1, "the report");
		expect(w.reports[0]?.body).toMatchObject({
			requestKind: "file_change",
			turnId: "act-1",
			rpcId: '"r1"',
		});
		w.script.sync = async () => ({
			answers: [{ approvalId: "ap-1", decision: "accept", revision: 1 }],
		});
		await w.tracker.tick();
		const outcome = await sent.done;
		expect(outcome.ok).toBe(true);
		w.script.sync = async () => ({});
		await w.tracker.tick();
		expect(JSON.stringify(w.syncs)).toContain("resolved_after_response");
		expect(h.fake.badResponses()).toEqual([]);
	});

	test("a person's decline ends in declined when the harness refuses it on their word", async () => {
		const h = createHarness({
			defaultTurn: [
				INIT,
				assistantToolUse("t1", "Bash", { command: "rm -rf x" }),
				canUseTool("r1", "Bash", "t1", { command: "rm -rf x" }),
				AWAIT,
				{
					say: {
						type: "user",
						session_id: "$SESSION",
						message: {
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: "t1",
									content: CLAUDE_PERSON_DECLINE_MESSAGE,
									is_error: true,
								},
							],
						},
						tool_result_meta: [
							{
								id: "t1",
								non_execution_kind: "permission-rule",
								permission_decision: { decision: "reject", source: "user_reject" },
							},
						],
					},
				},
				resultOk,
			],
		});
		harnesses.push(h);
		const w = wired(h);
		const rt = await h.start({ approvals: w.port });
		runtimes.push(rt);
		rt.beginSettle();
		rt.settled();
		const sent = await rt.sendPrompt("go", "act-1");
		await until(() => w.reports.length === 1, "the report");
		w.script.sync = async () => ({
			answers: [{ approvalId: "ap-1", decision: "decline", revision: 1 }],
		});
		await w.tracker.tick();
		await sent.done;
		w.script.sync = async () => ({});
		await w.tracker.tick();
		const all = w.syncs.flatMap((s) => s.resolved.map((r) => r.outcome));
		expect(all).toContain("resolved_after_response");
		expect(all).not.toContain("decided_elsewhere");
	});

	test("a child that exits with a request pending: runtime_gone, and the held request can't be answered", async () => {
		const h = createHarness({
			defaultTurn: [
				INIT,
				assistantToolUse("t1", "Bash", { command: "ls" }),
				canUseTool("r1", "Bash", "t1", { command: "ls" }),
				{ exit: 9 },
			],
		});
		harnesses.push(h);
		const w = wired(h);
		const rt = await h.start({ approvals: w.port });
		runtimes.push(rt);
		rt.beginSettle();
		rt.settled();
		const sent = await rt.sendPrompt("go", "act-1");
		await until(() => w.reports.length === 1, "the report");
		await sent.done;
		w.script.sync = async () => ({
			answers: [{ approvalId: "ap-1", decision: "accept", revision: 1 }],
		});
		await w.tracker.tick();
		await w.tracker.tick();
		const all = w.syncs.flatMap((s) => s.resolved.map((r) => r.outcome));
		expect(all).toContain("runtime_gone");
		expect(h.fake.badResponses()).toEqual([]);
	});
});

// ======================================================================================================
describe("the turn fence of Stop turn (AGEN-119)", () => {
	test("fenceTurn declines what the turn holds, with the turn's own reason, and the session stays answerable for the next turn", async () => {
		const a = armed();
		await openBash(a, "r1");
		a.port.fenceTurn();
		expect(a.written.map((w) => `${w.id}:${w.body.behavior}`)).toEqual(["r1:deny"]);
		expect(a.warnings.map((w) => w.detail.reason)).toEqual(["turn_interrupted"]);
		// A request on the same, fenced turn is denied on arrival and never reported.
		const reportsBefore = a.reports.length;
		a.request("r2", "Bash", { command: "ls" });
		await settle();
		expect(a.written.map((w) => `${w.id}:${w.body.behavior}`)).toEqual(["r1:deny", "r2:deny"]);
		expect(a.reports.length).toBe(reportsBefore);
		// The turn ends: the fence goes with it, and the next turn's request is a card again.
		a.port.turnEnded();
		a.request("r3", "Bash", { command: "pwd" });
		await settle();
		expect(a.reports.length).toBe(reportsBefore + 1);
		expect(a.written.map((w) => w.id)).toEqual(["r1", "r2"]);
	});

	test("liftTurnFence (the turn didn't stop in time): later requests are cards again", async () => {
		const a = armed();
		a.port.fenceTurn();
		a.request("r1", "Bash", { command: "ls" });
		await settle();
		expect(a.written.map((w) => w.body.behavior)).toEqual(["deny"]);
		a.port.liftTurnFence();
		a.request("r2", "Bash", { command: "pwd" });
		await settle();
		expect(a.reports).toHaveLength(1);
		expect(a.written).toHaveLength(1);
	});

	test("a request already answered keeps its own outcome: the turn fence only declines what is unanswered", async () => {
		const a = armed();
		await openBash(a);
		a.script.sync = async () => ({ answers: [a.answerOf("ap-1", "accept")] });
		await a.tracker.tick();
		expect(a.written.map((w) => w.body.behavior)).toEqual(["allow"]);
		a.port.fenceTurn();
		expect(a.written.map((w) => w.body.behavior)).toEqual(["allow"]);
	});

	test("it is not the session fence: dispose is not called and a later Stop's fence still works", async () => {
		const a = armed();
		a.port.fenceTurn();
		a.port.turnEnded();
		await openBash(a, "r9");
		a.port.fence();
		expect(a.written.map((w) => `${w.id}:${w.body.behavior}`)).toEqual(["r9:deny"]);
	});

	test("the server's report refusal turn_interrupted declines that one request and leaves the session alone", async () => {
		const a = armed();
		a.script.report = async () => {
			throw new SupervisorRequestError(409, "turn_interrupted", "turn_interrupted");
		};
		a.request("r1", "Bash", { command: "ls" });
		await settle();
		expect(a.written.map((w) => w.body.behavior)).toEqual(["deny"]);
		expect(a.warnings.map((w) => w.detail.reason)).toEqual(["turn_interrupted"]);
		// Not a rollback: the next request reports normally and the breaker is untouched.
		a.script.report = async () => ({ approvalId: "ap-ok" });
		a.request("r2", "Bash", { command: "pwd" });
		await settle();
		expect(a.reports.length).toBeGreaterThanOrEqual(1);
		expect(a.written).toHaveLength(1);
	});
});
