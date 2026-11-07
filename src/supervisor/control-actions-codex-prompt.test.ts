/**
 * AGEN-91: a prompt action is routed by the agent type the server stamped on it (the launch's), then by
 * mode. A Codex session's prompt goes to the live app-server thread and nowhere else; anything that can't
 * is refused with fixed words and never reaches the Claude path.
 *
 * Real: the control handler and the report gate (transport stubbed). Spied: the providers.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlAction } from "../shared/types.js";
import { type ControlProviders, createControlActionHandler } from "./control-actions.js";
import { CodexPromptWithheld } from "./providers/codex-shared.js";
import { LAUNCH_REFUSED_MESSAGE, createReportGate } from "./services/report-gate.js";

const SUPERVISOR_ID = "sup-1";
const STATUS_PATH = `/supervisors/${SUPERVISOR_ID}/control-actions/act-1/status`;
const CLAUDE_CALLS = ["promptClaudeHeadlessSession", "promptClaudeInteractiveSession"];

const NOT_RECORDED = "AgentPulse couldn't record this prompt, so it wasn't sent.";
const UNKNOWN_AGENT = "This host can't send prompts to this kind of session.";
const MISMATCH = "This session's records don't match how it was launched, so nothing was sent.";

let home: string;
let work: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-control-codex-prompt-")));
	work = join(home, "trusted", "project");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

type Posted = { path: string; body: Record<string, unknown> };

function harness(
	over: {
		codexPrompt?: (args: unknown, callbacks: unknown) => Promise<{ metadata: unknown }>;
		runtimeSessions?: string[];
		failSucceededReport?: boolean;
	} = {},
) {
	const calls: string[] = [];
	const codexArgs: unknown[] = [];
	const claudeArgs: Record<string, unknown>[] = [];
	const posted: Posted[] = [];
	const logs: string[] = [];
	const gate = createReportGate({
		request: async (path: string, options?: RequestInit) => {
			const body = options?.body ? JSON.parse(String(options.body)) : {};
			posted.push({ path, body });
			if (over.failSucceededReport && body?.status === "succeeded") {
				throw new Error("server unreachable");
			}
			return { session: { displayName: "x" }, managedSession: {}, events: [] };
		},
		supervisorId: SUPERVISOR_ID,
		home,
		now: () => 0,
		log: () => {},
	} as never);
	const providers = {
		stopManagedCodexSession: async () => {
			calls.push("stopManagedCodexSession");
		},
		promptManagedCodexSession: async (args: unknown, callbacks: unknown) => {
			calls.push("promptManagedCodexSession");
			codexArgs.push(args);
			if (over.codexPrompt) return over.codexPrompt(args, callbacks);
			return { metadata: { mode: "managed_codex", threadId: "thr-1", turnId: "turn-2" } };
		},
		hasManagedCodexRuntime: (id: string) => (over.runtimeSessions ?? []).includes(id),
		hasClaudeStreamRuntime: () => false,
		hasHeadlessRuntime: () => false,
		promptClaudeHeadlessSession: async (a: Record<string, unknown>) => {
			calls.push("promptClaudeHeadlessSession");
			claudeArgs.push(a);
			return { pid: 1, metadata: { mode: "headless" }, monitor: Promise.resolve() };
		},
		promptClaudeInteractiveSession: async () => {
			calls.push("promptClaudeInteractiveSession");
			return { metadata: { delivered: true } };
		},
	} as unknown as ControlProviders;
	const handle = createControlActionHandler({
		gate,
		trustedRoots: [join(home, "trusted")],
		providers,
		executeCleanupWorkArea: (async () => ({ removed: true, resolvedPath: work })) as never,
		log: (line) => logs.push(line),
	});
	return { calls, codexArgs, claudeArgs, posted, logs, gate, handle };
}

/** What the server really queues for a Codex prompt (held equal to enqueuePromptInTx's output by its own test). */
const CODEX_ACTION_METADATA = JSON.parse(
	readFileSync(new URL("../shared/__fixtures__/codex-prompt-action.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const promptAction = (metadata: Record<string, unknown>): ControlAction =>
	({
		id: "act-1",
		sessionId: "sess-1",
		launchRequestId: null,
		actionType: "prompt",
		requestedBy: null,
		status: "claimed",
		error: null,
		metadata: { ...CODEX_ACTION_METADATA, prompt: "go on", cwd: work, ...metadata },
	}) as unknown as ControlAction;

const statusBodies = (h: ReturnType<typeof harness>) =>
	h.posted.filter((p) => p.path === STATUS_PATH).map((p) => p.body);

const WRONG_STATE = (words: string) => `This session can't take a prompt because it's ${words}.`;

type Row = {
	label: string;
	metadata: Record<string, unknown>;
	calls: string[];
	failedWith?: string;
};

const ROWS: Row[] = [
	{
		label: "codex_cli + managed",
		metadata: { agentType: "codex_cli", managedState: "managed" },
		calls: ["promptManagedCodexSession"],
	},
	...(
		[
			["degraded", "having trouble reaching Codex"],
			["linked", "still starting up"],
			["pending", "still starting up"],
			["stopped", "already finished"],
			["completed", "already finished"],
			["failed", "already finished"],
			["interactive_terminal", "not ready"],
			["headless", "not ready"],
			["a-state-nobody-invented", "not ready"],
		] as const
	).map(([state, words]) => ({
		label: `codex_cli + ${state}`,
		metadata: { agentType: "codex_cli", managedState: state },
		calls: [],
		failedWith: WRONG_STATE(words),
	})),
	{
		label: "codex_cli + no managedState",
		metadata: { agentType: "codex_cli", managedState: undefined },
		calls: [],
		failedWith: WRONG_STATE("not ready"),
	},
	...(
		[
			["copilot_cli", { agentType: "copilot_cli", managedState: "managed" }],
			["a nonsense agentType", { agentType: "nonsense", managedState: "managed" }],
			["an absent agentType", { agentType: undefined, managedState: "managed" }],
			["a null agentType", { agentType: null, managedState: "managed" }],
		] as const
	).map(([label, metadata]) => ({
		label,
		metadata: metadata as Record<string, unknown>,
		calls: [],
		failedWith: UNKNOWN_AGENT,
	})),
	{
		label: "claude_code + headless",
		metadata: { agentType: "claude_code", managedState: "headless" },
		calls: ["promptClaudeHeadlessSession"],
	},
	{
		label: "claude_code + null managedState",
		metadata: { agentType: "claude_code", managedState: null },
		calls: ["promptClaudeHeadlessSession"],
	},
	{
		label: "claude_code + interactive_terminal",
		metadata: { agentType: "claude_code", managedState: "interactive_terminal" },
		calls: ["promptClaudeInteractiveSession"],
	},
];

describe("the routing table", () => {
	test("covers at least 15 rows and names codex_cli + managed and copilot_cli", () => {
		expect(ROWS.length).toBeGreaterThanOrEqual(15);
		expect(ROWS.map((r) => r.label)).toContain("codex_cli + managed");
		expect(ROWS.map((r) => r.label)).toContain("copilot_cli");
	});

	for (const row of ROWS) {
		test(`${row.label} -> ${row.calls.join(",") || "no provider"}`, async () => {
			const h = harness();
			await h.handle(promptAction(row.metadata));
			const context = `metadata=${JSON.stringify(row.metadata)} calls=${JSON.stringify(h.calls)}`;
			expect(h.calls, context).toEqual(row.calls);
			const [status] = statusBodies(h);
			if (row.failedWith) {
				expect(status, context).toMatchObject({ status: "failed", error: row.failedWith });
				// The raw value never reaches the error text.
				expect(String(status?.error)).not.toContain("a-state-nobody-invented");
				expect(String(status?.error)).not.toContain("nonsense");
			}
		});
	}
});

describe("a Codex session's prompt", () => {
	test("goes to the Codex runtime only, and succeeds with the metadata it returns", async () => {
		const h = harness();
		await h.handle(
			promptAction({
				agentType: "codex_cli",
				managedState: "managed",
				approvalPolicy: "on-request",
				sandboxMode: "workspace-write",
			}),
		);
		expect(h.calls.filter((c) => CLAUDE_CALLS.includes(c))).toEqual([]);
		expect(h.calls).toEqual(["promptManagedCodexSession"]);
		expect(statusBodies(h)).toEqual([
			{
				status: "succeeded",
				metadata: { mode: "managed_codex", threadId: "thr-1", turnId: "turn-2" },
			},
		]);
	});

	test("the function's args are exactly {sessionId, prompt}, whatever the action carried", async () => {
		for (const privileges of [
			{ approvalPolicy: "on-request", sandboxMode: "workspace-write" },
			{ approvalPolicy: null, sandboxMode: null },
		]) {
			const h = harness();
			await h.handle(
				promptAction({
					agentType: "codex_cli",
					managedState: "managed",
					model: "m",
					env: { A: "b" },
					...privileges,
				}),
			);
			expect(h.codexArgs).toHaveLength(1);
			expect(Object.keys(h.codexArgs[0] as object).sort()).toEqual(["prompt", "sessionId"]);
			expect(h.codexArgs[0]).toEqual({ sessionId: "sess-1", prompt: "go on" });
		}
	});

	test("does not depend on the directory: outside the trusted roots, empty or absent is still routed", async () => {
		for (const cwd of [join(home, "elsewhere"), "", undefined]) {
			const h = harness();
			await h.handle(
				promptAction({
					agentType: "codex_cli",
					managedState: "managed",
					cwd,
				}),
			);
			expect(h.calls, `cwd=${String(cwd)}`).toEqual(["promptManagedCodexSession"]);
			expect(statusBodies(h)[0]?.status, `cwd=${String(cwd)}`).toBe("succeeded");
		}
	});

	test("an empty prompt is a failure with no provider, on both agents", async () => {
		for (const metadata of [
			{ agentType: "codex_cli", managedState: "managed" },
			{ agentType: "claude_code", managedState: "headless" },
		]) {
			const h = harness();
			await h.handle(promptAction({ ...metadata, prompt: "" }));
			expect(h.calls, JSON.stringify(metadata)).toEqual([]);
			expect(statusBodies(h)[0]?.status, JSON.stringify(metadata)).toBe("failed");
		}
	});

	test("a runtime that was withheld by the report gate is a refusal, not a failure with exception text", async () => {
		const h = harness({
			codexPrompt: async () => {
				throw new CodexPromptWithheld();
			},
		});
		const refuse = spyOn(h.gate, "refuseControlAction");
		await h.handle(promptAction({ agentType: "codex_cli", managedState: "managed" }));
		expect(refuse).toHaveBeenCalledTimes(1);
		expect(refuse).toHaveBeenCalledWith("act-1");
		// The gate's one generic body: no metadata, no exception text.
		expect(statusBodies(h)).toEqual([{ status: "failed", error: LAUNCH_REFUSED_MESSAGE }]);
	});

	test("a gate throw is the not-recorded failure with {mode:'managed_codex'}, never a refusal", async () => {
		const h = harness({
			codexPrompt: async () => {
				throw new Error(NOT_RECORDED);
			},
		});
		const refuse = spyOn(h.gate, "refuseControlAction");
		await h.handle(promptAction({ agentType: "codex_cli", managedState: "managed" }));
		expect(refuse).not.toHaveBeenCalled();
		expect(statusBodies(h)).toEqual([
			{ status: "failed", error: NOT_RECORDED, metadata: { mode: "managed_codex" } },
		]);
	});

	test("a throw from the provider is reported failed with its fixed words and no prompt text", async () => {
		const h = harness({
			codexPrompt: async () => {
				throw new Error("Codex hasn't ended its current turn. Send this again when it ends.");
			},
		});
		await h.handle(
			promptAction({ agentType: "codex_cli", managedState: "managed", prompt: "SECRET" }),
		);
		const [body] = statusBodies(h);
		expect(body).toMatchObject({
			status: "failed",
			error: "Codex hasn't ended its current turn. Send this again when it ends.",
			metadata: { mode: "managed_codex" },
		});
		expect(JSON.stringify(body)).not.toContain("SECRET");
	});

	test("a report(succeeded) that throws is logged and never becomes a failed report", async () => {
		const h = harness({ failSucceededReport: true });
		await h.handle(promptAction({ agentType: "codex_cli", managedState: "managed" }));
		await Bun.sleep(30);
		const bodies = statusBodies(h);
		expect(bodies.map((b) => b.status)).toEqual(["succeeded"]);
	});

	test("success metadata has no prompt text", async () => {
		const h = harness();
		await h.handle(
			promptAction({ agentType: "codex_cli", managedState: "managed", prompt: "SECRET-TEXT" }),
		);
		expect(JSON.stringify(statusBodies(h))).not.toContain("SECRET-TEXT");
	});
});

describe("a Claude action is cross-checked against this host's Codex runtimes", () => {
	test("a claude_code action for a session that has a Codex runtime here is refused", async () => {
		const h = harness({ runtimeSessions: ["sess-1"] });
		await h.handle(promptAction({ agentType: "claude_code", managedState: "headless" }));
		expect(h.calls).toEqual([]);
		expect(statusBodies(h)).toMatchObject([{ status: "failed", error: MISMATCH }]);
	});

	test("a claude_code action for another session is not affected", async () => {
		const h = harness({ runtimeSessions: ["some-other-session"] });
		await h.handle(promptAction({ agentType: "claude_code", managedState: "headless" }));
		expect(h.calls).toEqual(["promptClaudeHeadlessSession"]);
	});

	test("the headless call still gets today's args", async () => {
		const h = harness();
		await h.handle(
			promptAction({
				agentType: "claude_code",
				managedState: "headless",
				approvalPolicy: "manual",
				sandboxMode: "read-only",
				model: "m",
			}),
		);
		expect(h.claudeArgs[0]).toMatchObject({
			sessionId: "sess-1",
			prompt: "go on",
			cwd: work,
			model: "m",
			managedState: "headless",
			approvalPolicy: "manual",
			sandboxMode: "read-only",
		});
	});
});

describe("exclusion", () => {
	test("an excluded Codex session is refused by the gate and no provider is called", async () => {
		const { writeFileSync, utimesSync } = await import("node:fs");
		const h = harness();
		const file = join(home, ".agentpulse", "exclude");
		writeFileSync(file, `${work}\n`, { mode: 0o600 });
		chmodSync(file, 0o600);
		utimesSync(file, new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
		h.gate.noteCwd("sess-1", work);
		await h.handle(promptAction({ agentType: "codex_cli", managedState: "managed" }));
		expect(h.calls).toEqual([]);
		expect(statusBodies(h)).toEqual([{ status: "failed", error: LAUNCH_REFUSED_MESSAGE }]);
	});
});
