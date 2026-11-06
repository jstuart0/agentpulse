import { describe, expect, test } from "bun:test";
import { CONTROL_TIMEOUT_ERROR } from "../../../shared/managed-messages.js";
import type { Session } from "../../../shared/types.js";
import { ApiError } from "../../lib/api.js";
import {
	STOP_NOT_OWNER_REASON,
	canStopSession,
	stopConfirmCopy,
	stopControlLabel,
	stopFailureText,
	stopInFlight,
	stopRefusalMessage,
	stopRequestFailure,
	stopSucceeded,
	stoppingText,
} from "./stop-view.js";

const session = (agentType: string, managedState?: string, hostName: string | null = "studio") =>
	({
		agentType,
		managedSession: managedState === undefined ? null : { managedState, hostName },
	}) as unknown as Session;

describe("which sessions offer Stop", () => {
	test.each([
		["a managed Codex session", "codex_cli", "managed", true],
		["a Codex session that is degraded", "codex_cli", "degraded", false],
		["a launched headless Claude", "claude_code", "headless", true],
		["a managed Claude", "claude_code", "managed", true],
		["a Claude in a terminal: no stop path exists", "claude_code", "interactive_terminal", false],
		["a Claude whose turn has ended", "claude_code", "completed", false],
		["a stopped Claude", "claude_code", "stopped", false],
		["a Copilot session", "copilot_cli", "managed", false],
	])("%s", (_name, agentType, state, expected) => {
		expect(canStopSession(session(agentType, state))).toBe(expected);
	});

	test("an unmanaged session has none", () => {
		expect(canStopSession(session("claude_code"))).toBe(false);
	});
});

describe("the confirmation's words", () => {
	test("a launched Claude is asked 'Stop this turn?' and told the next prompt carries on", () => {
		expect(stopConfirmCopy({ agentType: "claude_code" })).toEqual({
			title: "Stop this turn?",
			confirmLabel: "Stop turn",
			body: "Claude stops now. Anything it left running in the background may keep running. Files already changed stay changed. You can send another prompt to carry on.",
		});
	});

	test("Codex is not told it can carry on, because its stop closes the thread", () => {
		const copy = stopConfirmCopy({ agentType: "codex_cli" });
		expect(copy.title).toBe("Stop this session?");
		expect(copy.body).not.toContain("carry on");
		expect(copy.body).not.toContain("Claude");
	});

	test("Codex is told the session can't take more prompts, in the words the coordinator set", () => {
		expect(stopConfirmCopy({ agentType: "codex_cli" })).toEqual({
			title: "Stop this session?",
			confirmLabel: "Stop session",
			body: "Codex stops now and this session can't take more prompts. To keep working, start a new session. Anything it left running in the background may keep running. Files already changed stay changed.",
		});
	});

	test("the overflow menu says 'Stop turn' for a launched Claude and 'Stop session' for Codex", () => {
		expect(stopControlLabel({ agentType: "claude_code" })).toBe("Stop turn");
		expect(stopControlLabel({ agentType: "codex_cli" })).toBe("Stop session");
	});
});

describe("a stop in flight", () => {
	test("a queued or running stop counts; a finished one or a prompt does not", () => {
		expect(stopInFlight([{ actionType: "stop", status: "queued" }])).toBe(true);
		expect(stopInFlight([{ actionType: "stop", status: "running" }])).toBe(true);
		expect(stopInFlight([{ actionType: "stop", status: "succeeded" }])).toBe(false);
		expect(stopInFlight([{ actionType: "stop", status: "failed" }])).toBe(false);
		expect(stopInFlight([{ actionType: "prompt", status: "running" }])).toBe(false);
		expect(stopInFlight([])).toBe(false);
	});

	test("the line names the agent and the machine", () => {
		expect(stoppingText(session("claude_code", "headless"))).toBe("Stopping Claude on studio…");
	});

	test("a blank or missing host name leaves out 'on ...' instead of inventing one", () => {
		expect(stoppingText(session("codex_cli", "managed", null))).toBe("Stopping Codex…");
		expect(stoppingText(session("claude_code", "headless", "   "))).toBe("Stopping Claude…");
	});
});

describe("a stop the server refused", () => {
	const refused = (status: number, code: string) => new ApiError(status, code, { error: code });
	const claude = session("claude_code", "headless");
	const codex = session("codex_cli", "managed");

	test("control_busy says the agent is still handling the last request, in the agent's name", () => {
		expect(stopRefusalMessage(refused(400, "control_busy"), claude)).toBe(
			"Claude is still handling the last request, so it couldn't be stopped yet. Try again when it finishes its current turn.",
		);
		expect(stopRefusalMessage(refused(400, "control_busy"), codex)).toBe(
			"Codex is still handling the last request, so it couldn't be stopped yet. Try again when it finishes its current turn.",
		);
	});

	test("an old supervisor is named, with the machine, and the fix", () => {
		expect(stopRefusalMessage(refused(409, "host_upgrade_required"), claude)).toBe(
			"studio is running an older supervisor that can't stop Claude sessions. Update it, then try again.",
		);
	});

	test("nothing_to_stop says the session has already ended", () => {
		expect(stopRefusalMessage(refused(409, "nothing_to_stop"), claude)).toBe(
			"This session has already ended, so there is nothing to stop.",
		);
	});

	test("a terminal launch gets the fixed words", () => {
		expect(stopRefusalMessage(refused(409, "stop_not_supported"), claude)).toBe(
			"Stop isn't available for sessions started in a terminal yet. Stop it in that terminal.",
		);
	});

	test("an offline host still reads as the shared host sentence", () => {
		expect(stopRefusalMessage(refused(409, "host_offline"), claude)).toBe(
			"studio is offline, so this session can't be controlled right now. Nothing was sent.",
		);
	});

	test("anything else is not claimed: null, and the request failure falls back to the usual text", () => {
		expect(stopRefusalMessage(new Error("boom"), claude)).toBeNull();
		expect(stopRequestFailure(new Error("boom"), claude)).toBe("Couldn't stop the session.");
	});

	test("who may not stop gets one fixed reason", () => {
		expect(STOP_NOT_OWNER_REASON).toBe("Only the owner or an admin can stop this session.");
	});
});

describe("the standing failure of a stop", () => {
	const claude = session("claude_code", "headless");
	const action = (over: object) => ({
		actionType: "stop" as const,
		status: "failed" as const,
		error: "A command on this machine is still finishing, so the session can't be stopped yet.",
		createdAt: "2026-11-05T10:00:00.000Z",
		...over,
	});

	test("the newest action being a failed stop shows the host's cleaned words", () => {
		expect(stopFailureText(claude, [action({})])).toBe(
			"A command on this machine is still finishing, so the session can't be stopped yet.",
		);
		expect(stopFailureText(claude, [action({ error: "line one\n\u202Eline two" })])).toBe(
			"line one line two",
		);
	});

	test("a lost final report reads as 'didn't confirm the stop', with the machine and the agent", () => {
		expect(stopFailureText(claude, [action({ error: CONTROL_TIMEOUT_ERROR })])).toBe(
			"studio didn't confirm the stop. Claude may still be running.",
		);
		expect(
			stopFailureText(session("claude_code", "headless", null), [
				action({ error: CONTROL_TIMEOUT_ERROR }),
			]),
		).toBe("This session's host didn't confirm the stop. Claude may still be running.");
	});

	test("an empty error falls back to a plain sentence", () => {
		expect(stopFailureText(claude, [action({ error: null })])).toBe(
			"The stop didn't finish. Try again.",
		);
	});

	test("it goes away when something newer happens, and a succeeded stop shows nothing", () => {
		expect(
			stopFailureText(claude, [
				action({}),
				action({
					actionType: "prompt",
					status: "succeeded",
					createdAt: "2026-11-05T10:05:00.000Z",
				}),
			]),
		).toBeNull();
		expect(stopFailureText(claude, [action({ status: "succeeded" })])).toBeNull();
		expect(stopFailureText(claude, [])).toBeNull();
	});
});

describe("the dialog for a launched Claude with no turn running", () => {
	test("Stop stays available but the words don't say 'this turn'", () => {
		const idle = stopConfirmCopy({ agentType: "claude_code", isWorking: false });
		expect(idle).toEqual({
			title: "Stop Claude?",
			confirmLabel: "Stop",
			body: "Claude isn't working on anything right now. Stopping ends any Claude process still running for this session and clears a status that may be out of date. Programs it started in the background may keep running, and files it changed stay changed. You can send another prompt to carry on.",
		});
		expect(`${idle.title} ${idle.body} ${idle.confirmLabel}`).not.toMatch(/this turn|Stop turn/);
	});

	test("a working Claude, and one whose state is unknown, keep the turn words", () => {
		expect(stopConfirmCopy({ agentType: "claude_code", isWorking: true }).title).toBe(
			"Stop this turn?",
		);
		expect(stopConfirmCopy({ agentType: "claude_code" }).title).toBe("Stop this turn?");
	});

	test("Codex is the same working or not", () => {
		expect(stopConfirmCopy({ agentType: "codex_cli", isWorking: false }).title).toBe(
			"Stop this session?",
		);
	});
});

describe("a failed stop that the session has since outlived", () => {
	const failed = {
		actionType: "stop" as const,
		status: "failed" as const,
		error: "A command on this machine is still finishing.",
		createdAt: "2026-11-05 10:00:00",
	};
	const withSession = (over: object) =>
		({
			agentType: "claude_code",
			endedAt: null,
			managedSession: {
				hostName: "studio",
				managedState: "headless",
				updatedAt: "2026-11-05 09:00:00",
			},
			...over,
		}) as never;

	test("an end after the failure hides it", () => {
		expect(stopFailureText(withSession({ endedAt: "2026-11-05 10:05:00" }), [failed])).toBeNull();
	});

	test("a terminal managed state reported after the failure hides it", () => {
		const session = withSession({
			managedSession: {
				hostName: "studio",
				managedState: "stopped",
				updatedAt: "2026-11-05 10:05:00",
			},
		});
		expect(stopFailureText(session, [failed])).toBeNull();
	});

	test("positive control: an end before the failure, or a live session, still shows it", () => {
		expect(stopFailureText(withSession({ endedAt: "2026-11-05 09:00:00" }), [failed])).toBe(
			"A command on this machine is still finishing.",
		);
		expect(stopFailureText(withSession({}), [failed])).toBe(
			"A command on this machine is still finishing.",
		);
	});
});

describe("stopSucceeded", () => {
	test("the newest action being a succeeded stop", () => {
		const stop = (status: "succeeded" | "failed", createdAt: string) =>
			({ actionType: "stop", status, error: null, createdAt }) as never;
		expect(stopSucceeded([stop("succeeded", "2026-11-05 10:00:00")])).toBe(true);
		expect(stopSucceeded([stop("failed", "2026-11-05 10:00:00")])).toBe(false);
		expect(
			stopSucceeded([
				stop("succeeded", "2026-11-05 10:00:00"),
				stop("failed", "2026-11-05 10:01:00"),
			]),
		).toBe(false);
		expect(stopSucceeded([])).toBe(false);
	});
});
