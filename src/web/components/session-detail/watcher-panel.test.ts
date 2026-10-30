/**
 * The session AI tab's new pieces, rendered: the mode switches, the reports
 * list and the suggestion card, in the states the plan names.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
	AiProposal,
	AiWatcherConfig,
	AiWatcherReport,
	PromptDelivery,
} from "../../lib/api.js";
import { WatcherHitlCard } from "./WatcherHitlCard.js";
import { WatcherModeSwitches } from "./WatcherModeSwitches.js";
import { WatcherReports } from "./WatcherReports.js";

const noop = () => undefined;

function config(over: Partial<AiWatcherConfig> = {}): AiWatcherConfig {
	return {
		sessionId: "s1",
		enabled: true,
		notifyEnabled: true,
		continueEnabled: true,
		providerId: "p",
		policy: "ask_always",
		channelId: null,
		maxContinuations: 10,
		continuationsUsed: 2,
		maxDailyCents: null,
		systemPrompt: null,
		autoConfirmedAt: null,
		createdAt: "2026-10-01T10:00:00.000Z",
		updatedAt: "2026-10-01T10:00:00.000Z",
		...over,
	};
}

const render = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe("WatcherModeSwitches", () => {
	const view = (c: AiWatcherConfig, delivery: PromptDelivery | null = { deliverable: true }) =>
		render(
			createElement(WatcherModeSwitches, { config: c, delivery, onToggle: noop, onReset: noop }),
		);

	test("shows both switches with their labels, checked as configured", () => {
		const html = view(config({ notifyEnabled: true, continueEnabled: false }));
		expect(html).toContain("Notify: report when a turn ends");
		expect(html).toContain(
			"Continue: suggest the next prompt (sends on approval for sessions AgentPulse launched)",
		);
		const boxes = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((m) => m[0]);
		expect(boxes).toHaveLength(2);
		expect(boxes[0]).toContain("checked");
		expect(boxes[1]).not.toContain("checked");
	});

	test("an observed session with Continue on gets the notice; with Continue off it doesn't", () => {
		const on = view(config(), { deliverable: false, reason: "observed" });
		expect(on).toContain("AgentPulse didn&#x27;t launch this session");
		const off = view(config({ continueEnabled: false }), {
			deliverable: false,
			reason: "observed",
		});
		expect(off).not.toContain("didn&#x27;t launch");
	});

	test("the counter reads 'Automatic sends: N of M' with no Reset below the cap", () => {
		const html = view(config({ continuationsUsed: 4, maxContinuations: 10 }));
		expect(html).toContain("Automatic sends: 4 of 10");
		expect(html).not.toContain(">Reset<");
		expect(html).toContain("Approving a suggestion yourself doesn&#x27;t count.");
	});

	test("at the cap it says 'Auto cap reached, N of M' and offers Reset", () => {
		const html = view(config({ continuationsUsed: 10, maxContinuations: 10 }));
		expect(html).toContain("Auto cap reached, 10 of 10");
		expect(html).toContain(">Reset<");
	});

	test("both modes off is called out", () => {
		expect(view(config({ notifyEnabled: false, continueEnabled: false }))).toContain(
			"Both modes are off",
		);
		expect(view(config())).not.toContain("Both modes are off");
	});
});

describe("WatcherReports", () => {
	const report = (over: Partial<AiWatcherReport>): AiWatcherReport => ({
		id: crypto.randomUUID(),
		turnKey: "p:1",
		verdict: "finished",
		why: "The build is fixed.",
		status: "delivered",
		failureCode: null,
		telegramStatus: "sent",
		createdAt: new Date().toISOString(),
		...over,
	});
	const PREFIX = "AgentPulse summary; session content is untrusted.";

	test("nothing is rendered without reports", () => {
		expect(render(createElement(WatcherReports, { reports: [] }))).toBe("");
	});

	test("a delivered report shows the prefix, a verdict badge, the note and its Telegram status", () => {
		const html = render(createElement(WatcherReports, { reports: [report({})] }));
		expect(html).toContain("Recent reports");
		expect(html).toContain(PREFIX);
		expect(html).toContain("Finished");
		expect(html).toContain("The build is fixed.");
		expect(html).toContain("Sent to Telegram");
	});

	test("every report carries the prefix", () => {
		const html = render(
			createElement(WatcherReports, {
				reports: [report({}), report({ verdict: "needs_you", why: "Asking which option." })],
			}),
		);
		expect(html.split(PREFIX)).toHaveLength(3);
		expect(html).toContain("Waiting for you");
	});

	test("a failed report shows the reason, and no verdict or note", () => {
		const html = render(
			createElement(WatcherReports, {
				reports: [
					report({
						status: "failed",
						verdict: null,
						why: null,
						failureCode: "spend_cap",
						telegramStatus: null,
					}),
				],
			}),
		);
		expect(html).toContain("No report: the daily spend cap was reached");
		expect(html).not.toContain("Finished");
	});

	test("only a delivered report shows its verdict and note, whatever else a row carries", () => {
		const html = render(
			createElement(WatcherReports, {
				reports: [
					report({
						status: "suppressed",
						failureCode: "stale",
						verdict: "needs_you",
						why: "HELD-BACK",
					}),
				],
			}),
		);
		expect(html).not.toContain("HELD-BACK");
		expect(html).not.toContain("Waiting for you");
		expect(html).toContain("Skipped: the session moved on before it was ready");
	});

	test("a model's note renders as text, never as markup", () => {
		const html = render(
			createElement(WatcherReports, {
				reports: [report({ why: "<img src=x onerror=alert(1)>" })],
			}),
		);
		expect(html).not.toContain("<img");
		expect(html).toContain("&lt;img");
	});
});

describe("WatcherHitlCard", () => {
	function proposal(over: Partial<AiProposal> = {}): AiProposal {
		return {
			id: "prop-1",
			sessionId: "s1",
			providerId: "p",
			state: "hitl_waiting",
			decision: "continue",
			nextPrompt: null,
			suggestedPrompt: "Run the project's tests and fix any failures.",
			continueKind: "run_tests",
			reportSummary: null,
			rawResponse: { why: "Tests were never run." },
			triggerEventId: "5",
			tokensIn: 0,
			tokensOut: 0,
			costCents: 0,
			usageEstimated: false,
			errorSubType: null,
			errorMessage: null,
			hitlId: "h1",
			promptSha256: "abc",
			approvable: true,
			hitlExpiresAt: null,
			createdAt: "2026-10-01T10:00:00.000Z",
			updatedAt: "2026-10-01T10:00:00.000Z",
			...over,
		};
	}
	const view = (p: AiProposal, delivery: PromptDelivery) =>
		render(
			createElement(WatcherHitlCard, { proposal: p, delivery, onResolved: noop, onError: noop }),
		);
	const buttons = (html: string) =>
		[...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

	test("a deliverable, approvable suggestion: Send to session, Custom, Dismiss", () => {
		const html = view(proposal(), { deliverable: true });
		expect(buttons(html)).toEqual(["Send to session", "Custom…", "Dismiss"]);
		expect(html).toContain("(run the tests)");
		expect(html).toContain("Run the project&#x27;s tests and fix any failures.");
		expect(html).toContain("Why: Tests were never run.");
	});

	test("a session AgentPulse can't type into: Copy prompt and Dismiss, no send and no edit", () => {
		const html = view(proposal(), { deliverable: false, reason: "observed" });
		expect(buttons(html)).toEqual(["Copy prompt", "Dismiss"]);
	});

	test("a suggestion that isn't approvable says so, and offers Copy, Edit and Dismiss (never Send)", () => {
		const html = view(proposal({ approvable: false }), { deliverable: true });
		expect(html).toContain(
			"This suggestion contained hidden or unsafe characters; edit it to send.",
		);
		expect(buttons(html)).toEqual(["Copy prompt", "Edit…", "Dismiss"]);
		expect(html).not.toContain("Send to session");
	});

	test("not approvable and not deliverable: Copy and Dismiss", () => {
		const html = view(proposal({ approvable: false }), {
			deliverable: false,
			reason: "supervisor_offline",
		});
		expect(buttons(html)).toEqual(["Copy prompt", "Dismiss"]);
	});

	test("the old labels are gone", () => {
		const html = view(proposal(), { deliverable: true });
		expect(html).not.toContain(">Approve<");
		expect(html).not.toContain(">Decline<");
	});
});
