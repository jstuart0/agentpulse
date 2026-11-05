import { describe, expect, test } from "bun:test";
import { HOST_RESTARTED_SYNC_ERROR } from "../../../shared/managed-messages.js";
import { CONTROL_TIMEOUT_ERROR } from "../../../shared/managed-messages.js";
import type { ControlAction, HostControl, ManagedState, Session } from "../../../shared/types.js";
import { ApiError } from "../../lib/api.js";
import {
	COMPOSER_BLOCKED_CONNECTION,
	COMPOSER_BLOCKED_NOT_OWNER,
	COMPOSER_BLOCKED_NOT_READY,
	COMPOSER_BLOCKED_RESTARTED,
	COMPOSER_BUSY,
	COMPOSER_FAILED_FALLBACK,
	COMPOSER_UNKNOWN_OUTCOME,
	FOLLOW_DEADLINE_MS,
	FOLLOW_POLL_MS,
	type FollowDeps,
	boxState,
	composerMode,
	composerNotice,
	composerStatus,
	describeResumeFailure,
	describeSendFailure,
	focusBoxAfterSettle,
	followPromptAction,
	followsAction,
	lockedNotice,
	settleFollow,
	shouldRefocusBox,
} from "./prompt-composer-view.js";

type Probe = Pick<Session, "agentType" | "managedSession" | "isWorking" | "metadata"> &
	Partial<Pick<Session, "hostControl" | "ownerUserId">>;

function probe(
	agentType: string,
	managedState: ManagedState | null,
	extra: Partial<Probe> & {
		syncError?: string | null;
		host?: HostControl["state"];
		threadId?: string | null;
	} = {},
): Probe {
	const { syncError = null, host, threadId = null, ...rest } = extra;
	return {
		agentType: agentType as Session["agentType"],
		managedSession: managedState
			? ({
					managedState,
					hostName: "studio",
					providerSyncError: syncError,
					providerThreadId: threadId,
				} as Probe["managedSession"])
			: null,
		isWorking: false,
		metadata: {},
		hostControl: host ? { state: host, lastSeenAt: null } : undefined,
		...rest,
	};
}
function settled(result: Parameters<typeof settleFollow>[0]) {
	const out = settleFollow(result);
	if (out === null) throw new Error("expected a settled follow");
	return out;
}
function modeOf(session: Probe, canPrompt = true) {
	const mode = composerMode(session, { canPrompt, canResume: canPrompt });
	if (mode === null) throw new Error("expected a mode");
	return mode;
}
function hasControlOrBidi(text: string): boolean {
	return Array.from(text).some((ch) => {
		const code = ch.codePointAt(0) ?? 0;
		return (
			code < 32 ||
			code === 127 ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		);
	});
}
const ALLOWED = { canPrompt: true, canResume: true };
const DENIED = { canPrompt: false, canResume: false };
const IDLE = { step: "idle" } as const;
const NO_FLIGHT = { posting: false };

describe("composerMode: Claude keeps today's flow and words", () => {
	test("an interactive Claude session", () => {
		expect(composerMode(probe("claude_code", "interactive_terminal"), ALLOWED)).toMatchObject({
			kind: "claude_interactive",
			button: "Send to terminal",
			placeholder: "What should the interactive Claude session do next?",
			hint: "This sends your prompt into the owned interactive Claude session and keeps the terminal and workspace on the same session.",
			side: "AgentPulse will also log the prompt in the session timeline.",
		});
	});

	test("a headless Claude session", () => {
		expect(composerMode(probe("claude_code", "headless"), ALLOWED)).toMatchObject({
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

	test("a Claude session on an offline host keeps its box (the page disables it and says why)", () => {
		expect(composerMode(probe("claude_code", "headless", { host: "offline" }), ALLOWED)?.kind).toBe(
			"claude_headless",
		);
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

	test("degraded after a host restart says the process ended, and offers a new session", () => {
		const mode = composerMode(
			probe("codex_cli", "degraded", { syncError: HOST_RESTARTED_SYNC_ERROR }),
			ALLOWED,
		);
		expect(mode).toEqual({
			kind: "blocked",
			reason:
				"This session's process ended when its host restarted, so it can't take more prompts. Start a new session for this work.",
			startNew: true,
		});
		expect(COMPOSER_BLOCKED_RESTARTED).toBe(
			"This session's process ended when its host restarted, so it can't take more prompts. Start a new session for this work.",
		);
	});

	test("any other degraded reading says the connection isn't healthy, and offers a new session", () => {
		for (const syncError of [null, "Codex closed the connection.", ""]) {
			expect(composerMode(probe("codex_cli", "degraded", { syncError }), ALLOWED)).toEqual({
				kind: "blocked",
				reason:
					"This session's connection to Codex isn't healthy, so it can't take prompts. Start a new session to keep going.",
				startNew: true,
			});
		}
		expect(COMPOSER_BLOCKED_CONNECTION).toBe(
			"This session's connection to Codex isn't healthy, so it can't take prompts. Start a new session to keep going.",
		);
	});

	test("pending, linked and the other live states are blocked as not ready", () => {
		for (const state of ["pending", "linked", "headless", "interactive_terminal"] as const) {
			expect(composerMode(probe("codex_cli", state), ALLOWED)).toEqual({
				kind: "blocked",
				reason: "This session isn't ready for prompts yet. The box opens once Codex has started.",
				startNew: false,
			});
		}
		expect(COMPOSER_BLOCKED_NOT_READY).toBe(
			"This session isn't ready for prompts yet. The box opens once Codex has started.",
		);
	});

	test("stopped, completed and failed are the only hidden states", () => {
		for (const state of ["stopped", "completed", "failed"] as const) {
			expect(composerMode(probe("codex_cli", state), ALLOWED)).toBeNull();
			expect(composerMode(probe("codex_cli", state), DENIED)).toBeNull();
		}
	});

	test("an offline host is a blocked box with its own sentence, and nothing about 'nothing was sent'", () => {
		const mode = composerMode(probe("codex_cli", "managed", { host: "offline" }), ALLOWED);
		expect(mode).toEqual({
			kind: "blocked",
			reason: "studio is offline, so this session can't take prompts until it's back.",
			startNew: false,
		});
		expect(JSON.stringify(mode)).not.toContain("Nothing was sent");
	});

	test("a host with no name reads as 'This session's host'", () => {
		const session = probe("codex_cli", "managed", { host: "offline" });
		(session.managedSession as { hostName: string | null }).hostName = null;
		expect(composerMode(session, ALLOWED)).toMatchObject({
			reason: "This session's host is offline, so this session can't take prompts until it's back.",
		});
	});

	test("a removed host says so and offers to archive", () => {
		expect(composerMode(probe("codex_cli", "managed", { host: "gone" }), ALLOWED)).toEqual({
			kind: "blocked",
			reason:
				"This session's host was removed from AgentPulse, so it can't take prompts. You can archive it.",
			startNew: false,
		});
	});

	test("a live host or one the server didn't describe is not a reason", () => {
		expect(composerMode(probe("codex_cli", "managed", { host: "live" }), ALLOWED)?.kind).toBe(
			"codex",
		);
		expect(composerMode(probe("codex_cli", "managed"), ALLOWED)?.kind).toBe("codex");
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
			expect(composerMode(probe(agent, state), DENIED)).toEqual({
				kind: "blocked",
				reason: "Only the owner or an admin can send prompts to this session.",
				startNew: false,
			});
		}
		expect(COMPOSER_BLOCKED_NOT_OWNER).toBe(
			"Only the owner or an admin can send prompts to this session.",
		);
	});

	test("a blocked box is read-only with Send off", () => {
		const box = boxState(modeOf(probe("codex_cli", "degraded")), IDLE, NO_FLIGHT);
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
		const mode = modeOf(probe("codex_cli", "managed", { isWorking: true }));
		expect(boxState(mode, IDLE, NO_FLIGHT).sendDisabled).toBe(false);
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
	const codex = modeOf(probe("codex_cli", "managed"));

	test("while following, the text is read-only, the button says Sending… and Send is off", () => {
		expect(boxState(codex, { step: "following" }, NO_FLIGHT)).toMatchObject({
			readOnly: true,
			sendDisabled: true,
			buttonText: "Sending…",
			alert: null,
		});
	});

	test("while the POST is in flight a followed mode is read-only, a headless Claude box is not", () => {
		expect(boxState(codex, IDLE, { posting: true })).toMatchObject({
			readOnly: true,
			sendDisabled: true,
			buttonText: "Sending...",
		});
		const headless = modeOf(probe("claude_code", "headless"));
		expect(boxState(headless, IDLE, { posting: true })).toMatchObject({
			readOnly: false,
			sendDisabled: true,
			buttonText: "Sending...",
		});
	});

	test("succeeded clears the draft and goes idle", () => {
		expect(settleFollow({ outcome: "succeeded" })).toEqual({
			phase: { step: "idle" },
			clearDraft: true,
		});
	});

	test("failed makes the box editable with the reason in an alert", () => {
		const result = settled({ outcome: "failed", error: "Host said no." });
		expect(result.clearDraft).toBe(false);
		expect(boxState(codex, result.phase, NO_FLIGHT)).toMatchObject({
			readOnly: false,
			sendDisabled: false,
			alert: "Host said no.",
			buttonText: "Send prompt",
			startNew: false,
		});
	});

	test("a failure with no text falls back to a sentence", () => {
		const result = settled({ outcome: "failed", error: null });
		expect(boxState(codex, result.phase, NO_FLIGHT).alert).toBe(COMPOSER_FAILED_FALLBACK);
	});

	test("a host's failure text is cleaned and capped again before it is shown", () => {
		const hostile = `a${String.fromCharCode(27)}b${String.fromCharCode(0x202e)}c${"y".repeat(900)}`;
		const result = settled({ outcome: "failed", error: hostile });
		const alert = boxState(codex, result.phase, NO_FLIGHT).alert ?? "";
		expect(alert.startsWith("a bcyyy")).toBe(true);
		expect(hasControlOrBidi(alert)).toBe(false);
		expect(Array.from(alert).length).toBeLessThanOrEqual(501);
	});

	test("unknown gives the text back with the literal warning", () => {
		const result = settled({ outcome: "unknown" });
		expect(result.clearDraft).toBe(false);
		expect(boxState(codex, result.phase, NO_FLIGHT)).toMatchObject({
			readOnly: false,
			alert:
				"No answer from the host yet, so it may still run. Your text is back here. If Control history shows it queued or running, don't send it again yet.",
		});
		expect(COMPOSER_UNKNOWN_OUTCOME).toBe(
			"No answer from the host yet, so it may still run. Your text is back here. If Control history shows it queued or running, don't send it again yet.",
		);
	});

	test("an aborted follow changes nothing", () => {
		expect(settleFollow({ outcome: "aborted" })).toBeNull();
	});

	test("a failure that asks for a new session carries it into the box", () => {
		const phase = { step: "failed", reason: "x", startNew: true } as const;
		expect(boxState(codex, phase, NO_FLIGHT).startNew).toBe(true);
	});
});

describe("composerStatus", () => {
	const codex = composerMode(probe("codex_cli", "managed"), ALLOWED);
	const headless = composerMode(probe("claude_code", "headless"), ALLOWED);

	test("followed modes say what is being waited for, then (screen reader only) that it went", () => {
		expect(composerStatus(codex, { step: "following" }, false)).toEqual({
			text: "Waiting for the host to start this turn.",
			srOnly: false,
		});
		expect(composerStatus(codex, IDLE, true)).toEqual({ text: "Prompt sent.", srOnly: true });
		expect(composerStatus(codex, IDLE, false)).toEqual({ text: "", srOnly: true });
	});

	test("Claude headless and a blocked box have no status line", () => {
		expect(composerStatus(headless, { step: "following" }, true)).toBeNull();
		expect(
			composerStatus(composerMode(probe("codex_cli", "degraded"), ALLOWED), IDLE, false),
		).toBeNull();
		expect(composerStatus(null, IDLE, false)).toBeNull();
	});
});

describe("describeSendFailure", () => {
	const session = { managedSession: { hostName: "studio" } } as Pick<Session, "managedSession">;

	test("a host refusal reads through the host table, and the two that end a session offer a new one", () => {
		const restarted = describeSendFailure(
			new ApiError(409, "x", { error: "managed_state_not_continuable" }),
			session,
		);
		expect(restarted).toEqual({ reason: COMPOSER_BLOCKED_RESTARTED, startNew: true });
		const upgrade = describeSendFailure(
			new ApiError(409, "x", { error: "host_upgrade_required" }),
			session,
		);
		expect(upgrade.reason).toBe(
			"This session's host is running an older supervisor that can't send prompts to Codex. Update it, then start a new session for this work. Updating ends the sessions running there.",
		);
		expect(upgrade.startNew).toBe(true);
		const offline = describeSendFailure(new ApiError(409, "x", { error: "host_offline" }), session);
		expect(offline.startNew).toBe(false);
		expect(offline.reason).toStartWith("studio is offline");
	});

	test("the lock being held reads as 'another action', and any other failure keeps its usual text", () => {
		const busy = new ApiError(
			400,
			"Another control action is already in progress for this session.",
			{
				error: "Another control action is already in progress for this session.",
				reason: "control_busy",
			},
		);
		expect(describeSendFailure(busy, session)).toEqual({ reason: COMPOSER_BUSY, startNew: false });
		expect(COMPOSER_BUSY).toBe(
			"Another action on this session is still going. Your text is here. Send it when that finishes.",
		);
		expect(describeSendFailure(new Error("boom"), session).reason).toBe(
			"Couldn't send the prompt. Try again.",
		);
	});
});

describe("shouldRefocusBox", () => {
	test("not on a touch screen, where focus would raise the keyboard", () => {
		const coarse = (query: string) => ({ matches: query === "(pointer: coarse)" });
		const fine = () => ({ matches: false });
		expect(shouldRefocusBox(coarse)).toBe(false);
		expect(shouldRefocusBox(fine)).toBe(true);
		expect(shouldRefocusBox(undefined)).toBe(true);
	});
});

describe("focusBoxAfterSettle", () => {
	test("focuses the box, except on a touch screen or when there is no box", () => {
		let focused = 0;
		const box = {
			focus: () => {
				focused += 1;
			},
		};
		focusBoxAfterSettle(box, () => ({ matches: false }));
		expect(focused).toBe(1);
		focusBoxAfterSettle(box, (q) => ({ matches: q === "(pointer: coarse)" }));
		expect(focused).toBe(1);
		focusBoxAfterSettle(null, undefined);
	});
});

describe("lockedNotice", () => {
	test("a blocked mode is its reason; an ended session with text in the box keeps it; otherwise the box shows", () => {
		const blocked = composerMode(probe("codex_cli", "degraded"), ALLOWED);
		expect(lockedNotice(blocked, false)).toEqual({
			reason: COMPOSER_BLOCKED_CONNECTION,
			startNew: true,
		});
		expect(lockedNotice(blocked, true)).toEqual({
			reason: COMPOSER_BLOCKED_CONNECTION,
			startNew: true,
		});
		expect(lockedNotice(null, true)).toEqual({
			reason: "This session has ended, so it can't take prompts. Your text is still here to copy.",
			startNew: false,
		});
		expect(lockedNotice(null, false)).toBeNull();
		expect(lockedNotice(composerMode(probe("codex_cli", "managed"), ALLOWED), true)).toBeNull();
	});
});

describe("followPromptAction", () => {
	function action(over: Partial<ControlAction>): ControlAction {
		return { id: "a1", sessionId: "s1", status: "running", error: null, ...over } as ControlAction;
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
				return { controlActions: script(calls.length, sessionId, opts) };
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

	test("an action whose lock ran out is unknown, not failed: the prompt may have run", async () => {
		const { deps } = harness(() => [action({ status: "failed", error: CONTROL_TIMEOUT_ERROR })]);
		expect(await followPromptAction("s1", "a1", deps)).toEqual({ outcome: "unknown" });
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

describe("composerMode: a Codex session whose process is gone can be resumed (AGEN-115)", () => {
	const THREAD = "0199e3a2-7c1d-7a31-9e2f-123456789abc";
	const degraded = (extra: Parameters<typeof probe>[2] = {}) =>
		probe("codex_cli", "degraded", { threadId: THREAD, ...extra });
	const withAccess = (canResume: boolean, resumeInFlight = false) => ({
		canPrompt: true,
		canResume,
		resumeInFlight,
	});

	test("restarted host: the sentence offers Resume and a new session, and Resume is available", () => {
		expect(
			composerMode(degraded({ syncError: HOST_RESTARTED_SYNC_ERROR }), withAccess(true)),
		).toEqual({
			kind: "blocked",
			reason:
				"This session's process ended when its host restarted. Resume it to keep going, or start a new session for this work.",
			startNew: true,
			resume: { state: "available" },
		});
	});

	test("lost connection: its own sentence", () => {
		expect(composerMode(degraded(), withAccess(true))).toEqual({
			kind: "blocked",
			reason:
				"This session lost its connection to Codex, so it can't take prompts. Resume it to reconnect, or start a new session to keep going.",
			startNew: true,
			resume: { state: "available" },
		});
	});

	test("a viewer who can't resume is told who can, by whether the session has an owner", () => {
		expect(
			composerMode(
				degraded({ syncError: HOST_RESTARTED_SYNC_ERROR, ownerUserId: "alice" }),
				withAccess(false),
			),
		).toEqual({
			kind: "blocked",
			reason:
				"This session's process ended when its host restarted. Ask its owner or an admin to resume it, or start a new session for this work.",
			startNew: true,
		});
		expect(composerMode(degraded({ ownerUserId: null }), withAccess(false))).toEqual({
			kind: "blocked",
			reason:
				"This session lost its connection to Codex, so it can't take prompts. Ask an admin to resume it, or start a new session for this work.",
			startNew: true,
		});
	});

	test("an offline host: the disabled button points at the existing offline sentence, with no second sentence", () => {
		const mode = composerMode(degraded({ host: "offline" }), withAccess(true));
		expect(mode).toEqual({
			kind: "blocked",
			reason: "studio is offline, so this session can't take prompts until it's back.",
			startNew: false,
			resume: { state: "disabled" },
		});
	});

	test("a removed host says so and offers no Resume", () => {
		const mode = composerMode(degraded({ host: "gone" }), withAccess(true));
		expect(mode).toMatchObject({ kind: "blocked", startNew: false });
		expect((mode as { resume?: unknown }).resume).toBeUndefined();
	});

	test("Resume is hidden when the session has no thread id, and the old sentence stands", () => {
		const noThread = probe("codex_cli", "degraded", { syncError: HOST_RESTARTED_SYNC_ERROR });
		expect(composerMode(noThread, withAccess(true))).toEqual({
			kind: "blocked",
			reason: COMPOSER_BLOCKED_RESTARTED,
			startNew: true,
		});
	});

	test("Resume is never offered on a managed session, a pending one, or another agent", () => {
		for (const state of ["managed", "pending", "linked"] as const) {
			const mode = composerMode(probe("codex_cli", state, { threadId: THREAD }), withAccess(true));
			expect((mode as { resume?: unknown } | null)?.resume).toBeUndefined();
		}
		const claude = composerMode(
			probe("claude_code", "degraded", { threadId: THREAD }),
			withAccess(true),
		);
		expect((claude as { resume?: unknown } | null)?.resume).toBeUndefined();
	});

	test("while a resume is in flight the box is not offered: a status and a busy button instead, the draft kept by the slot", () => {
		const mode = composerMode(degraded(), withAccess(true, true));
		expect(mode).toEqual({
			kind: "blocked",
			reason: "Asking studio to resume this session…",
			startNew: false,
			resume: { state: "in_flight" },
		});
	});

	test("the person who can't prompt at all still gets only the not-owner sentence", () => {
		expect(composerMode(degraded(), { canPrompt: false, canResume: false })).toEqual({
			kind: "blocked",
			reason: COMPOSER_BLOCKED_NOT_OWNER,
			startNew: false,
		});
	});

	test("the reorder: degraded is judged before the host, so an offline degraded session reaches the disabled button", () => {
		const online = composerMode(degraded({ host: "live" }), withAccess(true)) as {
			resume?: { state: string };
		};
		const offline = composerMode(degraded({ host: "offline" }), withAccess(true)) as {
			resume?: { state: string };
		};
		expect(online.resume?.state).toBe("available");
		expect(offline.resume?.state).toBe("disabled");
	});
});

describe("describeResumeFailure: a refusal from POST /resume, in the recovery's words", () => {
	test("the host's name, and the way back for a session that can't be resumed", () => {
		const session = probe("codex_cli", "degraded", { threadId: "t" });
		const out = describeResumeFailure(new ApiError(409, "x", { error: "not_resumable" }), session);
		expect(out.reason).toBe(
			"AgentPulse can't confirm this session can be resumed on studio. Start a new session for this work.",
		);
		expect(out.startNew).toBe(true);
		expect(describeResumeFailure(new ApiError(409, "x", { error: "host_offline" }), session)).toEqual(
			{
				reason: "studio is offline, so nothing was started. Try again when it's back.",
				startNew: false,
			},
		);
	});

	test("a network failure keeps its own plain sentence", () => {
		expect(
			describeResumeFailure(new TypeError("Failed to fetch"), probe("codex_cli", "degraded")).reason,
		).toBe("Couldn't reach AgentPulse. Check your connection and try again.");
	});
});

describe("composerMode: the hint says whose settings a Codex turn runs under", () => {
	test("a launched session keeps 'the launch's approval policy and sandbox'", () => {
		const session = probe("codex_cli", "managed");
		(session.managedSession as { hostAffinityReason: string | null }).hostAffinityReason = "launched";
		expect(composerMode(session, ALLOWED)).toMatchObject({
			hint: "This starts a new turn in the same Codex thread, under the launch's approval policy and sandbox.",
		});
	});

	test("a taken-over session says 'this session's', because nothing launched it", () => {
		const session = probe("codex_cli", "managed");
		(session.managedSession as { hostAffinityReason: string | null }).hostAffinityReason =
			"taken_over";
		expect(composerMode(session, ALLOWED)).toMatchObject({
			hint: "This starts a new turn in the same Codex thread, under this session's approval policy and sandbox.",
		});
	});
});
