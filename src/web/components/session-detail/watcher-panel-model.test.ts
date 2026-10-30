import { describe, expect, test } from "bun:test";
import type { AiProposal, AiWatcherReport, PromptDelivery } from "../../lib/api.js";
import {
	NOT_APPROVABLE_NOTE,
	autoConfirmationPoints,
	autoCounter,
	continueKindLabel,
	failureLabel,
	promptDeliveryNotice,
	reportStatusLine,
	suggestionControls,
	telegramLabel,
} from "./watcher-panel-model.js";

const REASONS = ["observed", "supervisor_offline", "managed_state", "control_busy"] as const;
const ok: PromptDelivery = { deliverable: true };
const no = (reason: (typeof REASONS)[number]): PromptDelivery => ({ deliverable: false, reason });

describe("promptDeliveryNotice", () => {
	test("says nothing when Continue is off, whatever the session can take", () => {
		for (const reason of REASONS) expect(promptDeliveryNotice(false, no(reason))).toBeNull();
	});

	test("says nothing for a session that can take a prompt, or before the server has answered", () => {
		expect(promptDeliveryNotice(true, ok)).toBeNull();
		expect(promptDeliveryNotice(true, null)).toBeNull();
	});

	test("an observed session is told AgentPulse didn't launch it and that prompts are for copying", () => {
		expect(promptDeliveryNotice(true, no("observed"))).toBe(
			"AgentPulse didn't launch this session, so it can't type into it. Continue will suggest prompts for you to copy.",
		);
	});

	test("each reason has its own sentence, and none of them is empty", () => {
		const texts = REASONS.map((r) => promptDeliveryNotice(true, no(r)));
		for (const t of texts) expect(t?.length ?? 0).toBeGreaterThan(20);
		expect(new Set(texts).size).toBe(REASONS.length);
	});
});

describe("autoCounter", () => {
	test("reads 'Automatic sends: N of M' below the cap", () => {
		expect(autoCounter({ continuationsUsed: 3, maxContinuations: 10 })).toEqual({
			text: "Automatic sends: 3 of 10",
			capReached: false,
		});
		expect(autoCounter({ continuationsUsed: 0, maxContinuations: 0 }).capReached).toBe(true);
	});

	test("at the cap it says so, and past it still does", () => {
		expect(autoCounter({ continuationsUsed: 10, maxContinuations: 10 })).toEqual({
			text: "Auto cap reached, 10 of 10",
			capReached: true,
		});
		expect(autoCounter({ continuationsUsed: 12, maxContinuations: 10 }).capReached).toBe(true);
	});
});

describe("autoConfirmationPoints", () => {
	const points = autoConfirmationPoints(7).join("\n");
	test("names the three nudges and says model text is never sent", () => {
		expect(points).toContain("retry the failed step");
		expect(points).toContain("run the tests");
		expect(points).toContain("summarize status");
		expect(points).toContain("never sends text the model wrote");
	});
	test("says when it holds back, the limits with this session's total, and the pause setting", () => {
		expect(points).toContain("question or a permission prompt");
		expect(points).toContain("6 an hour");
		expect(points).toContain("7 in total");
		expect(points).toContain("Pause automatic prompt sending");
		expect(points).toContain("confirm again");
	});
});

describe("suggestionControls", () => {
	const proposal = (approvable: boolean | null) =>
		({ approvable }) as Pick<AiProposal, "approvable">;

	test("a deliverable, approvable suggestion is sent, with an edit option and no note", () => {
		expect(suggestionControls(proposal(true), ok)).toEqual({
			primary: "send",
			copy: false,
			edit: true,
			note: null,
		});
	});

	test("a request from before approvability was recorded is treated as approvable", () => {
		expect(suggestionControls(proposal(null), ok).primary).toBe("send");
	});

	test("a session that can't take a prompt gets Copy only, with no edit-to-send", () => {
		for (const reason of REASONS) {
			expect(suggestionControls(proposal(true), no(reason))).toEqual({
				primary: "copy",
				copy: true,
				edit: false,
				note: null,
			});
		}
	});

	test("a suggestion that isn't approvable says why and offers copy, plus edit when the session could take it", () => {
		expect(suggestionControls(proposal(false), ok)).toEqual({
			primary: "copy",
			copy: true,
			edit: true,
			note: NOT_APPROVABLE_NOTE,
		});
		expect(suggestionControls(proposal(false), no("observed"))).toMatchObject({
			primary: "copy",
			edit: false,
			note: NOT_APPROVABLE_NOTE,
		});
	});
});

describe("words for reports", () => {
	test("failureLabel has a sentence for every code the server stores", () => {
		for (const code of [
			"provider_timeout",
			"provider_transient",
			"evidence_read",
			"abandoned",
			"empty_output",
			"length",
			"refusal",
			"parse",
			"citation",
			"suspect_text",
			"spend_cap",
			"no_new_evidence",
			"stale",
		]) {
			expect(failureLabel(code), code).not.toBe("unknown reason");
		}
		expect(failureLabel("provider_permanent_auth")).toBe("the provider refused the request");
		expect(failureLabel("made_up")).toBe("unknown reason");
		expect(failureLabel(null)).toBe("unknown reason");
	});

	test("telegramLabel and the status line", () => {
		expect(telegramLabel("sent")).toBe("Sent to Telegram");
		expect(telegramLabel(null)).toBeNull();
		const report = (over: Partial<AiWatcherReport>): AiWatcherReport => ({
			id: "r",
			turnKey: "p:1",
			verdict: null,
			why: null,
			status: "delivered",
			failureCode: null,
			telegramStatus: null,
			createdAt: "2026-10-01T10:00:00.000Z",
			...over,
		});
		expect(reportStatusLine(report({ telegramStatus: "skipped_rate_limit" }))).toBe(
			"Not sent to Telegram (rate limit)",
		);
		expect(reportStatusLine(report({}))).toBe("In the inbox");
		expect(reportStatusLine(report({ status: "failed", failureCode: "parse" }))).toBe(
			"No report: the answer wasn't usable",
		);
		expect(reportStatusLine(report({ status: "suppressed", failureCode: "stale" }))).toBe(
			"Skipped: the session moved on before it was ready",
		);
		expect(reportStatusLine(report({ status: "claimed" }))).toBe("Writing…");
	});

	test("continueKindLabel", () => {
		expect(continueKindLabel("run_tests")).toBe("run the tests");
		expect(continueKindLabel(null)).toBeNull();
	});
});
