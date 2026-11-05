import { describe, expect, test } from "bun:test";
import type { ControlAction, ManagedState, Session } from "../../../shared/types.js";
import { ApiError } from "../../lib/api.js";
import { hostRefusalMessage } from "./host-control-view.js";
import {
	COMPOSER_BLOCKED_CONNECTION,
	COMPOSER_BLOCKED_NOT_OWNER,
	COMPOSER_BLOCKED_NOT_READY,
	COMPOSER_FAILED_FALLBACK,
	COMPOSER_UNKNOWN_OUTCOME,
	FOLLOW_DEADLINE_MS,
	FOLLOW_POLL_MS,
	type FollowDeps,
	boxState,
	composerMode,
	composerNotice,
	followPromptAction,
	followsAction,
	settleFollow,
} from "./prompt-composer-view.js";

type Probe = Pick<Session, "agentType" | "managedSession" | "isWorking" | "metadata">;

function probe(
	agentType: string,
	managedState: ManagedState | null,
	extra: Partial<Probe> = {},
): Probe {
	return {
		agentType: agentType as Session["agentType"],
		managedSession: managedState
			? ({ managedState, hostName: "studio" } as Probe["managedSession"])
			: null,
		isWorking: false,
		metadata: null,
		...extra,
	};
}
const ALLOWED = { canPrompt: true };
const DENIED = { canPrompt: false };

describe("composerMode: Claude keeps today's flow and words", () => {
	test("an interactive Claude session", () => {
		const mode = composerMode(probe("claude_code", "interactive_terminal"), ALLOWED);
		expect(mode).toMatchObject({
			kind: "claude_interactive",
			button: "Send to terminal",
			placeholder: "What should the interactive Claude session do next?",
			hint: "This sends your prompt into the owned interactive Claude session and keeps the terminal and workspace on the same session.",
			side: "AgentPulse will also log the prompt in the session timeline.",
		});
	});

	test("a headless Claude session", () => {
		const mode = composerMode(probe("claude_code", "headless"), ALLOWED);
		expect(mode).toMatchObject({
			kind: "claude_headless",
			button: "Send task",
			placeholder: "Describe the next task for this headless session.",
			hint: "This runs a follow-up headless turn inside the same Claude session and streams the visible output back here.",
			side: "Visible output lands in Activity and Launch.",
		});
	});

	test("Claude stays offered in every managed state it was offered in before", () => {
		for (const state of ["managed", "degraded", "completed", "pending"] as const) {
			expect(composerMode(probe("claude_code", state), ALLOWED)?.kind).toBe("claude_headless");
		}
	});

	test("observed sessions, Copilot and unmanaged sessions get no box", () => {
		expect(composerMode(probe("claude_code", null), ALLOWED)).toBeNull();
		expect(composerMode(probe("copilot_cli", "managed"), ALLOWED)).toBeNull();
		expect(composerMode(probe("codex_cli", null), ALLOWED)).toBeNull();
	});
});

describe("composerMode: Codex", () => {
	test("managed offers the prompt in the same thread", () => {
		expect(composerMode(probe("codex_cli", "managed"), ALLOWED)).toEqual({
			kind: "codex",
			hint: "This starts a new turn in the same Codex thread, under the launch's approval policy and sandbox.",
			placeholder: "What should Codex do next?",
			button: "Send prompt",
			side: "Replies and approval requests appear in this session.",
		});
	});

	test("degraded is blocked, with the connection reason", () => {
		expect(composerMode(probe("codex_cli", "degraded"), ALLOWED)).toMatchObject({
			kind: "blocked",
			reason: "This session's connection to Codex isn't healthy, so it can't take prompts.",
		});
		expect(COMPOSER_BLOCKED_CONNECTION).toBe(
			"This session's connection to Codex isn't healthy, so it can't take prompts.",
		);
	});

	test("pending, linked and the other live states are blocked as not ready", () => {
		for (const state of ["pending", "linked", "headless", "interactive_terminal"] as const) {
			expect(composerMode(probe("codex_cli", state), ALLOWED)).toMatchObject({
				kind: "blocked",
				reason: "This session isn't ready for prompts yet.",
			});
		}
		expect(COMPOSER_BLOCKED_NOT_READY).toBe("This session isn't ready for prompts yet.");
	});

	test("stopped, completed and failed are the only hidden states", () => {
		for (const state of ["stopped", "completed", "failed"] as const) {
			expect(composerMode(probe("codex_cli", state), ALLOWED)).toBeNull();
			expect(composerMode(probe("codex_cli", state), DENIED)).toBeNull();
		}
	});
});

describe("composerMode: who may send", () => {
	test("a viewer who can't prompt gets a blocked box on any agent", () => {
		for (const [agent, state] of [
			["claude_code", "headless"],
			["claude_code", "interactive_terminal"],
			["codex_cli", "managed"],
			["codex_cli", "degraded"],
		] as const) {
			expect(composerMode(probe(agent, state), DENIED)).toMatchObject({
				kind: "blocked",
				reason: "Only the owner or an admin can send prompts to this session.",
			});
		}
		expect(COMPOSER_BLOCKED_NOT_OWNER).toBe(
			"Only the owner or an admin can send prompts to this session.",
		);
	});

	test("a blocked box is read-only with Send off, and keeps the draft", () => {
		const mode = composerMode(probe("codex_cli", "degraded"), ALLOWED);
		if (mode === null) throw new Error("expected a mode");
		const box = boxState(mode, { step: "idle" }, { posting: false });
		expect(box.readOnly).toBe(true);
		expect(box.sendDisabled).toBe(true);
	});
});

describe("composerNotice", () => {
	const approval = { permissionWait: { ids: ["approval:a1"] } };

	test("an open approval is said first, even while the turn is running", () => {
		const session = probe("codex_cli", "managed", { isWorking: true, metadata: approval });
		expect(composerNotice(session)).toBe(
			"Answer the approval above first. A prompt sent before the turn ends is refused.",
		);
	});

	test("a running turn warns, and says the text will stay", () => {
		expect(composerNotice(probe("codex_cli", "managed", { isWorking: true }))).toBe(
			"The current turn hasn't ended. If you send now, the host will refuse it and your text will stay here.",
		);
	});

	test("nothing to say when idle", () => {
		expect(composerNotice(probe("codex_cli", "managed"))).toBeNull();
	});

	test("a notice never disables Send and never spells a state word", () => {
		const mode = composerMode(probe("codex_cli", "managed", { isWorking: true }), ALLOWED);
		if (mode === null) throw new Error("expected a mode");
		expect(boxState(mode, { step: "idle" }, { posting: false }).sendDisabled).toBe(false);
		for (const text of [
			composerNotice(probe("codex_cli", "managed", { isWorking: true })),
			composerNotice(probe("codex_cli", "managed", { metadata: approval })),
		]) {
			expect(text).not.toMatch(/\b(working|waiting|idle|error)\b/i);
		}
	});
});

describe("followsAction", () => {
	test("Codex and Claude interactive follow; Claude headless never does", () => {
		expect(followsAction(composerMode(probe("codex_cli", "managed"), ALLOWED))).toBe(true);
		expect(followsAction(composerMode(probe("claude_code", "interactive_terminal"), ALLOWED))).toBe(
			true,
		);
		expect(followsAction(composerMode(probe("claude_code", "headless"), ALLOWED))).toBe(false);
		expect(followsAction(composerMode(probe("codex_cli", "degraded"), ALLOWED))).toBe(false);
		expect(followsAction(null)).toBe(false);
	});
});

describe("the box across a send", () => {
	const codex = composerMode(probe("codex_cli", "managed"), ALLOWED);
	if (codex === null) throw new Error("expected a mode");

	test("while following, the text is read-only, the button says Sending… and Send is off", () => {
		const box = boxState(codex, { step: "following" }, { posting: false });
		expect(box).toMatchObject({
			readOnly: true,
			sendDisabled: true,
			buttonText: "Sending…",
			alert: null,
		});
	});

	test("succeeded clears the draft and goes idle", () => {
		expect(settleFollow({ outcome: "succeeded" })).toEqual({
			phase: { step: "idle" },
			clearDraft: true,
		});
	});

	test("failed makes the box editable with the reason in an alert", () => {
		const settled = settleFollow({ outcome: "failed", error: "Host said no." });
		expect(settled.clearDraft).toBe(false);
		const box = boxState(codex, settled.phase, { posting: false });
		expect(box).toMatchObject({
			readOnly: false,
			sendDisabled: false,
			alert: "Host said no.",
			buttonText: "Send prompt",
		});
	});

	test("a failure with no text falls back to a sentence", () => {
		const settled = settleFollow({ outcome: "failed", error: null });
		expect(boxState(codex, settled.phase, { posting: false }).alert).toBe(COMPOSER_FAILED_FALLBACK);
	});

	test("unknown gives the text back with the literal warning", () => {
		const settled = settleFollow({ outcome: "unknown" });
		expect(settled.clearDraft).toBe(false);
		expect(boxState(codex, settled.phase, { posting: false })).toMatchObject({
			readOnly: false,
			alert:
				"No answer from the host yet, so it may still run. Your text is back here. Check Control history before sending again.",
		});
		expect(COMPOSER_UNKNOWN_OUTCOME).toBe(
			"No answer from the host yet, so it may still run. Your text is back here. Check Control history before sending again.",
		);
	});

	test("an aborted follow changes nothing", () => {
		expect(settleFollow({ outcome: "aborted" })).toBeNull();
	});

	test("Claude headless keeps today's label while the request is in flight", () => {
		const headless = composerMode(probe("claude_code", "headless"), ALLOWED);
		if (headless === null) throw new Error("expected a mode");
		expect(boxState(headless, { step: "idle" }, { posting: true }).buttonText).toBe("Sending...");
	});

	test("a refusal that comes back on the POST reads through the host table, not a copy of it", () => {
		const error = new ApiError(409, "x", { error: "managed_state_not_continuable" });
		const text = hostRefusalMessage(error, { managedSession: { hostName: "studio" } } as never);
		const settled = { step: "failed", reason: text ?? "" } as const;
		expect(boxState(codex, settled, { posting: false }).alert).toBe(text);
		expect(text).toStartWith("This session's process ended when its host restarted");
	});
});

describe("followPromptAction", () => {
	function action(over: Partial<ControlAction>): ControlAction {
		return {
			id: "a1",
			sessionId: "s1",
			status: "running",
			error: null,
			...over,
		} as ControlAction;
	}

	function harness(script: (call: number, sessionId: string, opts: unknown) => ControlAction[]) {
		let now = 1_000_000;
		const calls: { sessionId: string; opts: unknown; at: number }[] = [];
		const deps: FollowDeps = {
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
			fetchActions: async (sessionId, opts) => {
				calls.push({ sessionId, opts, at: now });
				const result = script(calls.length, sessionId, opts);
				return { controlActions: result };
			},
		};
		return { deps, calls };
	}

	test("polls quietly every 1.5 s and returns succeeded", async () => {
		const { deps, calls } = harness((n) => [action({ status: n < 3 ? "running" : "succeeded" })]);
		expect(await followPromptAction("s1", "a1", deps)).toEqual({ outcome: "succeeded" });
		expect(calls).toHaveLength(3);
		expect(
			calls.every((c) => JSON.stringify(c.opts) === JSON.stringify({ background: true })),
		).toBe(true);
		expect(calls[1].at - calls[0].at).toBe(FOLLOW_POLL_MS);
		expect(FOLLOW_POLL_MS).toBe(1500);
	});

	test("returns failed with the action's error", async () => {
		const { deps } = harness(() => [action({ status: "failed", error: "Prompt refused." })]);
		expect(await followPromptAction("s1", "a1", deps)).toEqual({
			outcome: "failed",
			error: "Prompt refused.",
		});
	});

	test("gives up as unknown at 100 s, not before", async () => {
		const { deps, calls } = harness(() => [action({ status: "running" })]);
		expect(await followPromptAction("s1", "a1", deps)).toEqual({ outcome: "unknown" });
		expect(FOLLOW_DEADLINE_MS).toBe(100_000);
		const span = calls[calls.length - 1].at - calls[0].at;
		expect(span).toBeGreaterThanOrEqual(FOLLOW_DEADLINE_MS);
		expect(span).toBeLessThan(FOLLOW_DEADLINE_MS + 2 * FOLLOW_POLL_MS);
	});

	test("an action id that isn't in the list yet keeps waiting", async () => {
		const { deps } = harness((n) => (n < 2 ? [] : [action({ status: "succeeded" })]));
		expect(await followPromptAction("s1", "a1", deps)).toEqual({ outcome: "succeeded" });
	});

	test("an action that belongs to another session is ignored", async () => {
		const { deps } = harness(() => [action({ sessionId: "other", status: "succeeded" })]);
		expect(await followPromptAction("s1", "a1", deps)).toEqual({ outcome: "unknown" });
	});

	test("asks only about the session it started with", async () => {
		const { deps, calls } = harness(() => [action({ status: "succeeded" })]);
		await followPromptAction("s1", "a1", deps);
		expect(calls.every((c) => c.sessionId === "s1")).toBe(true);
	});

	test("a failed poll in the middle doesn't throw out of the follow", async () => {
		let n = 0;
		const { deps } = harness(() => [action({ status: "succeeded" })]);
		const flaky: FollowDeps = {
			...deps,
			fetchActions: async (id, opts) => {
				n += 1;
				if (n === 1) throw new Error("network");
				return deps.fetchActions(id, opts);
			},
		};
		expect(await followPromptAction("s1", "a1", flaky)).toEqual({ outcome: "succeeded" });
	});

	test("an abort stops it with no further polls", async () => {
		const controller = new AbortController();
		const { deps, calls } = harness(() => {
			controller.abort();
			return [action({ status: "running" })];
		});
		expect(await followPromptAction("s1", "a1", { ...deps, signal: controller.signal })).toEqual({
			outcome: "aborted",
		});
		expect(calls).toHaveLength(1);
	});
});
