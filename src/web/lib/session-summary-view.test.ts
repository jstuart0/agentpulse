import { describe, expect, test } from "bun:test";
import {
	FIXTURE_NOW,
	STORED,
	SUMMARY_VIEW_FIXTURES,
	type SummaryViewFixtureName,
} from "../../shared/__fixtures__/session-summary-view/index.js";
import type { SessionSummaryView } from "../../shared/session-summary-view.js";
import type { StoredSessionSummary, SummaryProvenance } from "../../shared/session-summary.js";
import { resolvePanel } from "../pages/settings-panels.js";
import { useLabsStore } from "../stores/labs-store.js";
import type { AiStatusResponse } from "./api.js";
import {
	NO_UNFINISHED_WORK,
	type SummaryLoad,
	type SummaryViewer,
	VERIFY_LINE,
	availabilityFromStores,
	budgetSentence,
	buildContextMarkdown,
	buildHandoffMarkdown,
	buildSummaryMarkdown,
	claimOnlyMode,
	deriveSummaryView,
	evidenceAccessibleName,
	evidenceLabel,
	evidenceResultCounts,
	failureCopy,
	finePrint,
	footerText,
	formatCost,
	formatMoment,
	formatMoney,
	labsPointer,
	outcomeChip,
	outcomeNotes,
	partialEvidenceNotice,
	refusalCopy,
	relativeAgo,
	resolveWorkspaceTab,
	summaryAvailability,
	summaryHref,
	tabBadge,
	validationResultText,
	validationTally,
	visibleWorkspaceTabs,
} from "./session-summary-view.js";

const CLOCK = { now: new Date(FIXTURE_NOW), timeZone: "UTC", locale: "en-GB" };
const ADMIN: SummaryViewer = { adminSettingsLocked: false, showSummarySharedNote: false };
const MEMBER: SummaryViewer = { adminSettingsLocked: true, showSummarySharedNote: true };
const AI_ON: AiStatusResponse = { build: true, runtime: true, killSwitch: false, active: true };
const AI_PAUSED: AiStatusResponse = { build: true, runtime: true, killSwitch: true, active: false };
const AI_OFF: AiStatusResponse = { build: true, runtime: false, killSwitch: false, active: false };

function ready(view: SessionSummaryView): SummaryLoad {
	return { status: "ready", view };
}
function derive(
	view: SessionSummaryView,
	ai: AiStatusResponse = AI_ON,
	viewer: SummaryViewer = ADMIN,
) {
	const model = deriveSummaryView(ready(view), ai, viewer, CLOCK);
	if (!model) throw new Error("expected a model");
	return model;
}
const F = SUMMARY_VIEW_FIXTURES;

describe("availability", () => {
	test("TC-7.1a available iff the flag is on and build is true, whatever `active` says", () => {
		const labs = { flags: { sessionSummary: true }, error: null, loading: false };
		for (const active of [true, false]) {
			const status: AiStatusResponse = { ...AI_ON, active, runtime: active, killSwitch: !active };
			expect(availabilityFromStores(labs, { status, loadState: "loaded" })).toBe("available");
		}
	});

	test("TC-7.1b either side unloaded is pending", () => {
		expect(
			summaryAvailability({
				flag: null,
				labsLoadFailed: false,
				aiBuild: true,
				aiLoadFailed: false,
			}),
		).toBe("pending");
		expect(
			summaryAvailability({
				flag: true,
				labsLoadFailed: false,
				aiBuild: null,
				aiLoadFailed: false,
			}),
		).toBe("pending");
		expect(
			summaryAvailability({
				flag: null,
				labsLoadFailed: false,
				aiBuild: null,
				aiLoadFailed: false,
			}),
		).toBe("pending");
	});

	test("TC-7.1c build false, flag off, and a failed fetch of either are unavailable, never pending forever", () => {
		expect(
			summaryAvailability({
				flag: true,
				labsLoadFailed: false,
				aiBuild: false,
				aiLoadFailed: false,
			}),
		).toBe("unavailable");
		expect(
			summaryAvailability({
				flag: false,
				labsLoadFailed: false,
				aiBuild: true,
				aiLoadFailed: false,
			}),
		).toBe("unavailable");
		expect(
			summaryAvailability({ flag: null, labsLoadFailed: true, aiBuild: true, aiLoadFailed: false }),
		).toBe("unavailable");
		expect(
			summaryAvailability({ flag: true, labsLoadFailed: false, aiBuild: null, aiLoadFailed: true }),
		).toBe("unavailable");
		expect(
			summaryAvailability({ flag: null, labsLoadFailed: true, aiBuild: null, aiLoadFailed: true }),
		).toBe("unavailable");
	});

	test("TC-7.1d from the stores: an errored labs store with no flags, and an errored AI store with no status, are unavailable", () => {
		const aiOk = { status: AI_ON, loadState: "loaded" as const };
		expect(availabilityFromStores({ flags: null, error: "boom", loading: false }, aiOk)).toBe(
			"unavailable",
		);
		expect(
			availabilityFromStores(
				{ flags: { sessionSummary: true }, error: null, loading: false },
				{ status: null, loadState: "error" },
			),
		).toBe("unavailable");
		expect(availabilityFromStores({ flags: null, error: "boom", loading: true }, aiOk)).toBe(
			"pending",
		);
	});

	test("TC-7.2 with the labs store unloaded isEnabled is true but availability is not", () => {
		useLabsStore.setState({ flags: null, error: null, loading: false });
		// biome-ignore lint/suspicious/noExplicitAny: the flag joins the union in phase 5
		expect(useLabsStore.getState().isEnabled("sessionSummary" as any)).toBe(true);
		const s = useLabsStore.getState();
		expect(availabilityFromStores(s, { status: AI_ON, loadState: "loaded" })).toBe("pending");
	});

	test("TC-7.34 build false with the flag on is unavailable and ?tab=summary resolves to activity", () => {
		const a = availabilityFromStores(
			{ flags: { sessionSummary: true }, error: null, loading: false },
			{ status: { ...AI_ON, build: false, active: false }, loadState: "loaded" },
		);
		expect(a).toBe("unavailable");
		expect(resolveWorkspaceTab("summary", a)).toEqual({
			kind: "tab",
			tab: "activity",
			fellBack: true,
		});
	});
});

describe("tabs", () => {
	test("TC-7.3a summary resolves by availability; pending keeps the deep link; unknown falls to the default", () => {
		expect(resolveWorkspaceTab("summary", "available")).toEqual({
			kind: "tab",
			tab: "summary",
			fellBack: false,
		});
		expect(resolveWorkspaceTab("summary", "unavailable")).toEqual({
			kind: "tab",
			tab: "activity",
			fellBack: true,
		});
		expect(resolveWorkspaceTab("summary", "pending")).toEqual({ kind: "pending" });
		expect(resolveWorkspaceTab("nope", "available")).toEqual({
			kind: "tab",
			tab: "activity",
			fellBack: false,
		});
		expect(resolveWorkspaceTab(null, "pending")).toEqual({
			kind: "tab",
			tab: "activity",
			fellBack: false,
		});
		expect(resolveWorkspaceTab("notes", "pending")).toEqual({
			kind: "tab",
			tab: "notes",
			fellBack: false,
		});
	});

	test("TC-7.3b derived at render: a selected summary that becomes unavailable falls to activity", () => {
		expect(resolveWorkspaceTab("summary", "available").kind).toBe("tab");
		expect(resolveWorkspaceTab("summary", "unavailable")).toEqual({
			kind: "tab",
			tab: "activity",
			fellBack: true,
		});
	});

	test("TC-7.4 visible tabs in the owner's order; Summary absent unless available", () => {
		expect(visibleWorkspaceTabs("available")).toEqual([
			"overview",
			"summary",
			"activity",
			"notes",
			"instructions",
			"launch",
			"ai",
		]);
		for (const a of ["pending", "unavailable"] as const) {
			expect(visibleWorkspaceTabs(a)).toEqual([
				"overview",
				"activity",
				"notes",
				"instructions",
				"launch",
				"ai",
			]);
		}
	});

	test("TC-7.30 summaryHref encodes the id", () => {
		expect(summaryHref("abc")).toBe("/sessions/abc?tab=summary");
		expect(summaryHref("a/b c?d#e")).toBe("/sessions/a%2Fb%20c%3Fd%23e?tab=summary");
	});
});

describe("deriveSummaryView: the three pieces", () => {
	test("TC-7.5a unavailable hides everything; loading and load failed have no action and no notice", () => {
		expect(deriveSummaryView({ status: "unavailable" }, AI_ON, ADMIN, CLOCK)).toBeNull();
		expect(deriveSummaryView({ status: "ready", view: F.empty }, null, ADMIN, CLOCK)).toBeNull();
		for (const [status, kind] of [
			["loading", "loading"],
			["error", "load_failed"],
		] as const) {
			const m = deriveSummaryView({ status }, AI_ON, ADMIN, CLOCK);
			expect(m?.content.kind).toBe(kind);
			expect(m?.action).toEqual({ kind: "none" });
			expect(m?.notice).toEqual({ kind: "none" });
		}
	});

	test("TC-7.5b content: none, ready, stale (with the capped count)", () => {
		expect(derive(F.empty).content.kind).toBe("none");
		expect(derive(F.ready).content.kind).toBe("ready");
		const stale = derive(F.stale).content;
		expect(stale.kind).toBe("stale");
		if (stale.kind === "stale") {
			expect(stale.newEvents).toBe(12);
			expect(stale.text).toBe(
				"This session has moved on since this summary (12 prompts and tool calls later).",
			);
		}
		const capped = derive(F.stale_capped).content;
		if (capped.kind === "stale")
			expect(capped.text).toBe(
				"This session has moved on since this summary (100+ prompts and tool calls later).",
			);
		else throw new Error("expected stale");
	});

	test("TC-7.5c action: available in its three variants", () => {
		const none = derive(F.empty).action;
		expect(
			none.kind === "available" &&
				none.variant === "summarize" &&
				none.label === "Summarize this session",
		).toBe(true);
		if (none.kind === "available") expect(none.finePrint).toContain("claude-sonnet-4-6");
		const upd = derive(F.ready).action;
		expect(upd.kind === "available" && upd.variant === "update" && upd.label === "Update").toBe(
			true,
		);
		const st = derive(F.stale).action;
		expect(
			st.kind === "available" && st.variant === "update_stale" && st.label === "Update summary",
		).toBe(true);
	});

	test("TC-7.5d action: generating keeps a disabled-looking label and the status line", () => {
		const a = derive(F.generating).action;
		expect(a.kind).toBe("generating");
		if (a.kind === "generating") {
			expect(a.label).toBe("Summarizing…");
			expect(a.statusText).toBe(
				"Summarizing. This can take a couple of minutes on a long session. You can leave this page; it keeps going.",
			);
			expect(a.startedAt).toBe("2026-10-04T11:58:00.000Z");
		}
	});

	test("TC-7.5e action: blocked for too little activity, no provider (with the member variant), paused, off", () => {
		const little = derive(F.too_little_activity).action;
		expect(little).toMatchObject({
			kind: "blocked",
			reason: "too_little_activity",
			text: "There's nothing to summarize yet. This fills in once the session has a prompt or some tool activity.",
		});

		const np = derive(F.no_provider).action;
		expect(np).toMatchObject({
			kind: "blocked",
			reason: "no_provider",
			text: "No AI provider is set up.",
			link: { href: "/settings?panel=ai" },
		});
		const npMember = derive(F.no_provider, AI_ON, MEMBER).action;
		expect(npMember).toMatchObject({
			kind: "blocked",
			reason: "no_provider",
			text: "No AI provider is set up. Ask an admin to add one.",
			link: null,
		});

		expect(derive(F.ready, AI_PAUSED).action).toMatchObject({
			kind: "blocked",
			reason: "ai_paused",
			text: "Summaries are unavailable while AI is paused.",
		});
		expect(derive(F.ready, AI_OFF).action).toMatchObject({
			kind: "blocked",
			reason: "ai_off",
			text: "Summaries are unavailable while AI is turned off.",
		});
	});

	test("TC-7.5f action: over budget and cooling down", () => {
		const over = derive(F.spend_cap).action;
		expect(over).toMatchObject({
			kind: "blocked",
			reason: "over_budget",
			text: "Not enough of today's AI budget left for a summary: $4.20 of $5.00 used, and one can cost up to $0.45, or $0.90 if the answer has to be retried. The budget resets at Mon 00:00.",
		});
		expect(derive(F.cooldown).action).toMatchObject({
			kind: "blocked",
			reason: "cooling_down",
			text: "Available in 17s",
		});
	});

	test("TC-7.5g action: evidence shrunk asks for confirmation", () => {
		const a = derive(F.evidence_shrunk).action;
		expect(a.kind === "available" && a.confirm).toBe(
			"Older events have been removed. A new summary would be based on less evidence and replaces this one.",
		);
		expect(
			derive(F.ready).action.kind === "available" &&
				(derive(F.ready).action as { confirm: string | null }).confirm,
		).toBeNull();
	});

	test("TC-7.5h notice: none, red with nothing stored, muted when a summary exists", () => {
		expect(derive(F.ready).notice).toEqual({ kind: "none" });
		expect(derive(F.empty).notice).toEqual({ kind: "none" });
		const red = derive(F.failed).notice;
		expect(red).toMatchObject({
			kind: "failed",
			tone: "error",
			reason: "The model's answer wasn't usable. Try again; a different model may do better.",
		});
		const muted = derive(F.failed_ai_inactive).notice;
		expect(muted).toMatchObject({
			kind: "failed",
			tone: "muted",
			reason: "AI was paused before this finished. Resume it in Settings to try again.",
		});
		if (muted.kind === "failed") expect(muted.lead).toContain("Last attempt");
	});
});

describe("deriveSummaryView: the pieces combine independently", () => {
	test("TC-7.6a stale + over budget: stale notice, ready view, over-budget sentence where Update would be", () => {
		const m = derive({ ...F.stale, ...{ spend: F.spend_cap.spend, blocked: "spend_cap_reached" } });
		expect(m.content.kind).toBe("stale");
		expect(m.action).toMatchObject({ kind: "blocked", reason: "over_budget" });
	});

	test("TC-7.6b ready + no provider: the sentence replaces Update, the stored view stays", () => {
		const m = derive({ ...F.ready, provider: null, blocked: "no_provider" });
		expect(m.content.kind).toBe("ready");
		expect(m.action).toMatchObject({ kind: "blocked", reason: "no_provider" });
	});

	test("TC-7.6c failed + cooling down shows both the notice and the countdown", () => {
		const m = derive({ ...F.failed, blocked: "summary_cooldown", cooldownSeconds: 5 });
		expect(m.notice.kind).toBe("failed");
		expect(m.action).toMatchObject({
			kind: "blocked",
			reason: "cooling_down",
			text: "Available in 5s",
		});
	});

	test("TC-7.6d suspect + stale: the notice, the stale view and all three buttons read anyway", () => {
		const m = derive({ ...F.suspect, staleEvents: 3 });
		expect(m.content.kind).toBe("stale");
		expect(m.suspectNotice).toBe(
			"This summary contains text that looks like instructions. Read it before pasting it into an agent.",
		);
		expect(m.copyLabels).toEqual({
			handoff: "Copy handoff anyway",
			summary: "Copy summary anyway",
			context: "Copy context anyway",
		});
		expect(derive(F.ready).suspectNotice).toBeNull();
		expect(derive(F.ready).copyLabels).toEqual({
			handoff: "Copy handoff",
			summary: "Copy summary",
			context: "Copy context",
		});
	});

	test("TC-7.6e paused + stale: the stored summary stays readable, Update is replaced by the reason", () => {
		const m = derive(F.stale, AI_PAUSED);
		expect(m.content.kind).toBe("stale");
		expect(m.action).toMatchObject({ kind: "blocked", reason: "ai_paused" });
	});

	test("TC-7.6f generating + stored keeps the previous summary; generating wins over a cooldown", () => {
		const gen = {
			...F.ready,
			attempt: {
				status: "generating" as const,
				startedAt: "2026-10-04T11:59:00.000Z",
				errorCode: null,
			},
		};
		const m = derive(gen);
		expect(m.content.kind).toBe("ready");
		expect(m.action.kind).toBe("generating");
		expect(m.notice.kind).toBe("none");
		expect(derive({ ...gen, blocked: "summary_cooldown", cooldownSeconds: 4 }).action.kind).toBe(
			"generating",
		);
	});

	test("TC-7.6g too little + stored; shrunk + stale asks to confirm", () => {
		const little = derive({ ...F.ready, blocked: "too_little_activity" });
		expect(little.content.kind).toBe("ready");
		expect(little.action).toMatchObject({ kind: "blocked", reason: "too_little_activity" });
		const shrunk = derive({ ...F.stale, evidenceShrunk: true });
		expect(shrunk.content.kind).toBe("stale");
		expect(shrunk.action).toMatchObject({ kind: "available", variant: "update_stale" });
		expect(shrunk.action.kind === "available" && shrunk.action.confirm).toBeTruthy();
	});

	test("TC-7.6h a blocked action never carries a label that could be rendered as an enabled button", () => {
		for (const name of [
			"no_provider",
			"spend_cap",
			"too_little_activity",
			"cooldown",
		] as SummaryViewFixtureName[]) {
			const a = derive(F[name]).action;
			expect(a.kind).toBe("blocked");
			expect("label" in a).toBe(false);
		}
		expect("label" in derive(F.ready, AI_PAUSED).action).toBe(false);
	});
});

describe("failureCopy", () => {
	const RESET = "2026-10-05T00:00:00.000Z";
	const TABLE: Array<[string, string]> = [
		["provider_auth", "The provider rejected the API key. Check it in Settings."],
		[
			"provider_key_unreadable",
			"The provider's API key can't be read. Enter it again in Settings.",
		],
		["provider_rate_limit", "The provider is rate-limiting. Try again shortly."],
		["provider_timeout", "The provider took too long to answer. Try again."],
		[
			"provider_error",
			"The provider returned an error. Try again; if it keeps happening, check the provider's status.",
		],
		[
			"provider_refused",
			"The model declined to summarize this session. A different model may do better.",
		],
		[
			"parse_failed",
			"The model's answer wasn't usable. Try again; a different model may do better.",
		],
		[
			"output_truncated",
			"The model ran out of room before finishing its answer. Try again; a different default model may do better.",
		],
		[
			"spend_cap",
			"The first answer wasn't usable, and a retry would have gone over today's AI budget. Nothing was saved; the first call was still charged. The budget resets at Mon 00:00.",
		],
		["ai_inactive", "AI was paused before this finished. Resume it in Settings to try again."],
		["busy", "Something went wrong on the server. Try again."],
		["internal_error", "Something went wrong on the server. Try again."],
		["interrupted", "The server restarted mid-way. Try again."],
	];

	test("TC-7.7a the thirteen codes carry the plan's exact copy", () => {
		expect(TABLE).toHaveLength(13);
		for (const [code, copy] of TABLE) expect(failureCopy(code, ADMIN, RESET, CLOCK)).toBe(copy);
	});

	test("TC-7.7b members are not told to open Settings for the two key codes", () => {
		expect(failureCopy("provider_auth", MEMBER)).toBe(
			"The provider rejected the API key. Ask an admin to check the provider.",
		);
		expect(failureCopy("provider_key_unreadable", MEMBER)).toBe(
			"The provider's API key can't be read. Ask an admin to check the provider.",
		);
		expect(failureCopy("ai_inactive", MEMBER)).not.toContain("Enter it again");
	});

	test("TC-7.7c an unknown, null or hostile code falls to the generic line and no server string is rendered", () => {
		expect(failureCopy("something_new", ADMIN)).toBe("Something went wrong. Try again.");
		expect(failureCopy(null, ADMIN)).toBe("Something went wrong. Try again.");
		expect(failureCopy("<img src=x onerror=1>", ADMIN)).toBe("Something went wrong. Try again.");
	});
});

describe("formatting", () => {
	test("TC-7.8a formatCost", () => {
		expect(formatCost(0, true)).toBe("no cost recorded");
		expect(formatCost(0)).toBe("under $0.01");
		expect(formatCost(1)).toBe("$0.01");
		expect(formatCost(3)).toBe("$0.03");
		expect(formatCost(100)).toBe("$1.00");
		expect(formatCost(497)).toBe("$4.97");
	});

	test("TC-7.8b formatCost is safe on negative, NaN, infinite and fractional input", () => {
		expect(formatCost(-5)).toBe("under $0.01");
		expect(formatCost(Number.NaN)).toBe("under $0.01");
		expect(formatCost(Number.POSITIVE_INFINITY)).toBe("under $0.01");
		expect(formatCost(2.6)).toBe("$0.03");
		expect(formatCost(0.2)).toBe("under $0.01");
		expect(formatMoney(497)).toBe("$4.97");
		expect(formatMoney(0)).toBe("$0.00");
		expect(formatMoney(500)).toBe("$5.00");
	});

	test("TC-7.9a the budget sentence is built from the view's numbers and follows the cap", () => {
		const spend = {
			spentCents: 420,
			capCents: 500,
			maxCostCents: 45,
			maxCostWithRetryCents: 90,
			resetsAt: "2026-10-05T00:00:00.000Z",
		};
		expect(budgetSentence(spend, CLOCK)).toBe(
			"Not enough of today's AI budget left for a summary: $4.20 of $5.00 used, and one can cost up to $0.45, or $0.90 if the answer has to be retried. The budget resets at Mon 00:00.",
		);
		const bigger = budgetSentence({ ...spend, capCents: 1000 }, CLOCK);
		expect(bigger).toContain("$4.20 of $10.00");
		expect(bigger).not.toContain("$5.00");
	});

	test("TC-7.9b the reset time is the server's instant shown in the browser's zone, not a local midnight", () => {
		const spend = {
			spentCents: 420,
			capCents: 500,
			maxCostCents: 45,
			maxCostWithRetryCents: 90,
			resetsAt: "2026-10-05T07:00:00.000Z",
		};
		const utc = budgetSentence(spend, { ...CLOCK, timeZone: "UTC" });
		const la = budgetSentence(spend, { ...CLOCK, timeZone: "America/Los_Angeles" });
		expect(utc).toContain("resets at Mon 07:00.");
		expect(la).toContain("resets at Mon 00:00.");
		expect(utc).not.toBe(la);
	});

	test("TC-7.40a formatMoment adds a weekday when the instant is not today", () => {
		expect(formatMoment("2026-10-04T10:07:00.000Z", CLOCK)).toBe("10:07");
		expect(formatMoment("2026-09-29T10:09:00.000Z", CLOCK)).toBe("Tue 10:09");
		expect(formatMoment("2026-10-04 10:07:00", CLOCK)).toBe("10:07");
	});

	test("TC-7.40b relativeAgo", () => {
		expect(relativeAgo("2026-10-04T11:59:40.000Z", CLOCK)).toBe("just now");
		expect(relativeAgo("2026-10-04T11:57:00.000Z", CLOCK)).toBe("3 min ago");
		expect(relativeAgo("2026-10-04T09:00:00.000Z", CLOCK)).toBe("3h ago");
		expect(relativeAgo("2026-10-01T12:00:00.000Z", CLOCK)).toBe("3d ago");
		expect(relativeAgo("2026-10-04T12:00:30.000Z", CLOCK)).toBe("just now");
	});
});

describe("evidenceLabel", () => {
	test("TC-7.33a labels from stored facts, never an id", () => {
		expect(
			evidenceLabel({ kind: "command", at: "2026-10-04T10:07:00.000Z", result: "ok" }, CLOCK),
		).toBe("command 10:07");
		expect(evidenceLabel({ kind: "edit", at: "2026-10-04T10:04:00.000Z", count: 3 }, CLOCK)).toBe(
			"3 edits 10:04",
		);
		expect(evidenceLabel({ kind: "edit", at: "2026-10-04T10:04:00.000Z", count: 1 }, CLOCK)).toBe(
			"edit 10:04",
		);
		expect(evidenceLabel({ kind: "prompt", at: "2026-10-04T10:02:00.000Z" }, CLOCK)).toBe(
			"prompt 10:02",
		);
		expect(
			evidenceLabel({ kind: "command", at: "2026-10-04T10:09:00.000Z", result: "failed" }, CLOCK),
		).toBe("failed command 10:09");
	});

	test("TC-7.33b a weekday when the time is not today", () => {
		expect(
			evidenceLabel({ kind: "command", at: "2026-09-29T10:09:00.000Z", result: "failed" }, CLOCK),
		).toBe("failed command Tue 10:09");
	});

	test("TC-7.33c all four results are worded, unknown facts fall back to a neutral label", () => {
		const at = "2026-10-04T10:07:00.000Z";
		expect(evidenceLabel({ kind: "command", at, result: "unknown" }, CLOCK)).toBe(
			"command (result unclear) 10:07",
		);
		expect(evidenceLabel({ kind: "command", at, result: "completed" }, CLOCK)).toBe(
			"command (finished) 10:07",
		);
		expect(evidenceLabel({ kind: "mystery", at }, CLOCK)).toBe("activity 10:07");
		expect(evidenceLabel(undefined, CLOCK)).toBe("activity");
		expect(evidenceLabel({ kind: "command", at: null }, CLOCK)).toBe("command");
		for (const fact of [undefined, { kind: "command", at }, { kind: "x", at: null }]) {
			expect(evidenceLabel(fact, CLOCK)).not.toMatch(/E\d+/);
		}
	});

	test("TC-7.33d the accessible name is a sentence", () => {
		expect(
			evidenceAccessibleName(
				{ kind: "command", at: "2026-10-04T10:07:00.000Z", result: "ok" },
				CLOCK,
			),
		).toBe("Open the 10:07 command in Activity");
		expect(
			evidenceAccessibleName(
				{ kind: "command", at: "2026-09-29T10:09:00.000Z", result: "failed" },
				CLOCK,
			),
		).toBe("Open the Tue 10:09 failed command in Activity");
		expect(
			evidenceAccessibleName({ kind: "edit", at: "2026-10-04T10:04:00.000Z", count: 3 }, CLOCK),
		).toBe("Open the 3 edits from 10:04 in Activity");
		expect(evidenceAccessibleName(undefined, CLOCK)).toBe("Open the activity in Activity");
	});

	test("TC-7.40c results are tallied in four separate buckets", () => {
		const at = null;
		const counts = evidenceResultCounts([
			{ kind: "command", at, result: "ok" },
			{ kind: "command", at, result: "ok" },
			{ kind: "command", at, result: "failed" },
			{ kind: "command", at, result: "unknown" },
			{ kind: "command", at, result: "completed" },
			{ kind: "command", at, result: "completed" },
			{ kind: "prompt", at },
		]);
		expect(counts).toEqual({ ok: 2, failed: 1, unknown: 1, completed: 2 });
	});
});

describe("sections and chips", () => {
	test("TC-7.40d validation tally in words and the result text for adjusted items", () => {
		const v = (result: "passed" | "failed" | "not_run" | "unknown") => ({
			what: "x",
			result,
			detail: "",
			evidence: [],
			adjusted: false,
		});
		expect(
			validationTally([v("passed"), v("passed"), v("failed"), v("unknown"), v("not_run")]),
		).toBe("2 passed · 1 failed · 1 unknown · 1 not run");
		expect(validationTally([v("passed")])).toBe("1 passed");
		expect(validationTally([])).toBe("");
		const prov: SummaryProvenance = {
			...STORED.provenance,
			adjustments: [
				{ code: "validation_adjusted", index: 1, from: "passed", reason: "no_validation_cited" },
				{ code: "validation_adjusted", index: 2, from: "passed", reason: "mixed" },
			],
		};
		const adj = { ...v("unknown"), adjusted: true };
		expect(validationResultText(v("passed"), 0, prov)).toBe("Passed");
		expect(validationResultText(v("failed"), 0, prov)).toBe("Failed");
		expect(validationResultText(v("not_run"), 0, prov)).toBe("Not run");
		expect(validationResultText(v("unknown"), 0, prov)).toBe("Unknown");
		expect(validationResultText(adj, 1, prov)).toBe(
			"Unknown: no test or build command found for this",
		);
		expect(validationResultText(adj, 2, prov)).toBe(
			"Unknown: the recorded activity doesn't confirm this",
		);
	});

	test("TC-7.40e claim-only presentation: per item, or one section note past half", () => {
		const items = (...u: boolean[]) => u.map((unverified) => ({ unverified }));
		expect(claimOnlyMode([])).toBe("none");
		expect(claimOnlyMode(items(false, false))).toBe("none");
		expect(claimOnlyMode(items(true, false, false, false))).toBe("per_item");
		expect(claimOnlyMode(items(true, true, false, false))).toBe("per_item");
		expect(claimOnlyMode(items(true, true, true, false))).toBe("section");
		expect(claimOnlyMode(items(true))).toBe("section");
	});

	test("TC-7.40f the outcome chip: sentence case, colour family, dashed only for unclear", () => {
		expect(outcomeChip("mostly_completed")).toEqual({
			label: "Mostly completed",
			family: "green",
			dashed: false,
		});
		expect(outcomeChip("completed").family).toBe("green");
		expect(outcomeChip("partially_completed").family).toBe("blue");
		expect(outcomeChip("in_progress").family).toBe("blue");
		expect(outcomeChip("blocked").family).toBe("amber");
		expect(outcomeChip("failed").family).toBe("red");
		expect(outcomeChip("abandoned")).toEqual({
			label: "Abandoned",
			family: "slate",
			dashed: false,
		});
		expect(outcomeChip("unclear")).toEqual({ label: "Unclear", family: "slate", dashed: true });
	});

	test("TC-7.40g the outcome explanation sentences for the server's adjustments", () => {
		const withAdj = (adjustments: SummaryProvenance["adjustments"]): StoredSessionSummary => ({
			...STORED,
			provenance: { ...STORED.provenance, adjustments },
		});
		expect(outcomeNotes(STORED)).toEqual([]);
		expect(
			outcomeNotes(
				withAdj([
					{ code: "outcome_clamped", from: "completed", to: "in_progress", reason: "working" },
				]),
			),
		).toEqual([
			"The model said Completed. Shown as In progress because the session is still running.",
		]);
		expect(
			outcomeNotes(
				withAdj([
					{ code: "outcome_clamped", from: "failed", to: "in_progress", reason: "permission_wait" },
				]),
			),
		).toEqual([
			"The model said Failed. Shown as In progress because the session is waiting on a permission prompt.",
		]);
		expect(
			outcomeNotes(
				withAdj([
					{ code: "note_lifecycle_failed" },
					{ code: "note_completed_with_failed_validation" },
				]),
			),
		).toEqual([
			"The session itself ended as failed.",
			"A validation step failed (see Validation).",
		]);
	});

	test("TC-7.40h partial-evidence wording follows the cut-off, never 'n of m events read'", () => {
		const cov = (c: Partial<SummaryProvenance["coverage"]>): SummaryProvenance["coverage"] => ({
			status: "partial",
			droppedByCap: 0,
			droppedByBudget: 0,
			cutoffAt: null,
			...c,
		});
		expect(partialEvidenceNotice({ ...cov({}), status: "full" }, CLOCK)).toBeNull();
		expect(
			partialEvidenceNotice(cov({ cutoffAt: "2026-10-04T08:00:00.000Z", droppedByCap: 9 }), CLOCK),
		).toBe("Based on part of this session: activity before 08:00 was left out.");
		expect(partialEvidenceNotice(cov({ droppedByCap: 4, droppedByBudget: 3 }), CLOCK)).toBe(
			"Some activity was left out (7 tool calls).",
		);
		expect(partialEvidenceNotice(cov({ droppedByCap: 1 }), CLOCK)).toBe(
			"Some activity was left out (1 tool call).",
		);
		expect(partialEvidenceNotice(cov({}), CLOCK)).toBe("Some activity was left out.");
		expect(partialEvidenceNotice(cov({ cutoffAt: "2026-09-29T08:00:00.000Z" }), CLOCK)).not.toMatch(
			/of \d+ events/,
		);
	});

	test("TC-7.40i the footer", () => {
		const f = footerText(F.ready, CLOCK);
		expect(f).toEqual({
			line: "Based on 140 events through 06:41 · claude-sonnet-4-6 · $0.03 · generated 3h ago",
			masked: null,
			retention: null,
		});
		const masked = footerText(
			{
				...F.retention,
				stored: { ...STORED, provenance: { ...STORED.provenance, redactionHits: 5 } },
			},
			CLOCK,
		);
		expect(masked?.masked).toBe("5 known patterns masked before sending.");
		expect(masked?.retention).toBe("Removed along with this session's events after 30 days.");
		const one = footerText(
			{
				...F.ready,
				retentionDays: 1,
				stored: { ...STORED, provenance: { ...STORED.provenance, redactionHits: 1 } },
			},
			CLOCK,
		);
		expect(one?.masked).toBe("1 known pattern masked before sending.");
		expect(one?.retention).toBe("Removed along with this session's events after 1 day.");
		const free = footerText(
			{
				...F.ready,
				spend: { ...F.ready.spend, maxCostCents: 0, maxCostWithRetryCents: 0 },
				stored: { ...STORED, provenance: { ...STORED.provenance, costCents: 0 } },
			},
			CLOCK,
		);
		expect(free?.line).toContain("no cost recorded");
		const cheap = footerText(
			{ ...F.ready, stored: { ...STORED, provenance: { ...STORED.provenance, costCents: 0 } } },
			CLOCK,
		);
		expect(cheap?.line).toContain("under $0.01");
		expect(footerText(F.empty, CLOCK)).toBeNull();
	});

	test("TC-7.40j the fine print under Summarize", () => {
		expect(finePrint(F.empty, { showSummarySharedNote: false })).toBe(
			"Sends this session's prompts, agent replies, notes, commands and file paths to anthropic · claude-sonnet-4-6. Command output is sent only for tests, builds and failures. Known secret patterns are removed first. Up to $0.04, or $0.08 if the answer has to be retried; $1.20 of today's $5.00 used.",
		);
		expect(finePrint(F.empty, { showSummarySharedNote: true })).toEndWith(
			" Everyone on this instance can read it.",
		);
		const free = finePrint(
			{ ...F.empty, spend: { ...F.empty.spend, maxCostCents: 0, maxCostWithRetryCents: 0 } },
			{ showSummarySharedNote: false },
		);
		expect(free).toContain("No cost is recorded for this provider.");
		expect(free).not.toContain("Up to");
		expect(finePrint(F.no_provider, { showSummarySharedNote: false })).toBeNull();
	});
});

describe("tab badge and pointer", () => {
	test("TC-7.36 Summarizing while generating; New only for a result seen this visit and cleared on opening the tab", () => {
		expect(tabBadge({ generating: true, newResult: false, tabActive: false })).toBe("Summarizing");
		expect(tabBadge({ generating: true, newResult: true, tabActive: false })).toBe("Summarizing");
		expect(tabBadge({ generating: false, newResult: true, tabActive: false })).toBe("New");
		expect(tabBadge({ generating: false, newResult: true, tabActive: true })).toBeNull();
		expect(tabBadge({ generating: false, newResult: false, tabActive: false })).toBeNull();
	});

	test("TC-7.37a the pointer reads flags directly: nothing before they load, nothing when on", () => {
		expect(labsPointer(null, ADMIN)).toEqual({ visible: false });
		expect(labsPointer({ sessionSummary: true }, ADMIN)).toEqual({ visible: false });
		expect(labsPointer({ sessionSummary: false }, ADMIN, false)).toEqual({ visible: false });
	});

	test("TC-7.37b a person who can change Labs sees a Turn on button and a What it does link", () => {
		expect(labsPointer({ sessionSummary: false }, ADMIN)).toEqual({
			visible: true,
			text: "Session summaries are a Labs feature and are off.",
			canTurnOn: true,
			learnMoreHref: "/settings?panel=labs",
		});
	});

	test("TC-7.37c a team member is told whom to ask and gets no button", () => {
		expect(labsPointer({ sessionSummary: false }, MEMBER)).toEqual({
			visible: true,
			text: "Session summaries are a Labs feature and are off. Ask an admin to turn on Session summary in Settings → Labs.",
			canTurnOn: false,
			learnMoreHref: null,
		});
	});
});

describe("refusalCopy", () => {
	const r = (status: number, code: string | null, retryAfterSeconds: number | null = null) =>
		// biome-ignore lint/suspicious/noExplicitAny: the code is a plain string on the wire
		({ status, code: code as any, retryAfterSeconds });

	test("TC-7.39a rate limiting carries a countdown", () => {
		expect(refusalCopy(r(429, "summary_rate_limited", 12))).toEqual({
			text: "Too many summary requests. Try again in 12s.",
			refetch: null,
			countdownSeconds: 12,
		});
		expect(refusalCopy(r(429, "summary_rate_limited")).text).toBe(
			"Too many summary requests. Try again shortly.",
		);
	});

	test("TC-7.39b the plain refusals", () => {
		expect(refusalCopy(r(409, "caller_generation_running")).text).toBe(
			"You already have a summary being made. Wait for it to finish.",
		);
		expect(refusalCopy(r(503, "shutting_down", 5)).text).toBe(
			"The server is restarting. Try again in a moment.",
		);
		expect(refusalCopy(r(503, "busy", 5)).text).toBe(
			"The server is busy with other summaries. Try again in a few seconds.",
		);
		expect(refusalCopy(r(404, "session_not_found")).text).toBe("This session no longer exists.");
		expect(refusalCopy(r(404, null)).text).toBe("This session no longer exists.");
	});

	test("TC-7.39c the AI and Labs refusals ask for a re-read", () => {
		expect(refusalCopy(r(409, "session_summary_disabled"))).toMatchObject({
			text: "Session summaries were just turned off.",
			refetch: "availability",
		});
		expect(refusalCopy(r(409, "ai_disabled"))).toMatchObject({
			text: "AI was just turned off.",
			refetch: "ai_status",
		});
		expect(refusalCopy(r(404, "ai_disabled"))).toMatchObject({
			text: "AI was just turned off.",
			refetch: "ai_status",
		});
		expect(refusalCopy(r(409, "ai_paused"))).toMatchObject({
			text: "AI was just paused.",
			refetch: "ai_status",
		});
	});

	test("TC-7.39d provider_key_unreadable reads as the failure line, with the member variant", () => {
		expect(refusalCopy(r(409, "provider_key_unreadable"), ADMIN).text).toBe(
			"The provider's API key can't be read. Enter it again in Settings.",
		);
		expect(refusalCopy(r(409, "provider_key_unreadable"), MEMBER).text).toBe(
			"The provider's API key can't be read. Ask an admin to check the provider.",
		);
	});

	test("TC-7.39e the four 409s that the blocked action explains request a refetch and no inline copy", () => {
		for (const code of [
			"no_provider",
			"too_little_activity",
			"spend_cap_reached",
			"summary_cooldown",
		]) {
			expect(refusalCopy(r(409, code))).toEqual({
				text: null,
				refetch: "view",
				countdownSeconds: null,
			});
		}
		expect(refusalCopy(r(429, "summary_cooldown", 9))).toEqual({
			text: null,
			refetch: "view",
			countdownSeconds: null,
		});
	});

	test("TC-7.39f an unknown refusal says something generic and refetches, never raw server text", () => {
		expect(refusalCopy(r(500, null))).toEqual({
			text: "Something went wrong. Try again.",
			refetch: "view",
			countdownSeconds: null,
		});
		expect(refusalCopy(r(418, "<script>"))).toMatchObject({
			text: "Something went wrong. Try again.",
		});
	});
});

describe("fixtures from the server shape", () => {
	const EXPECTED: Record<SummaryViewFixtureName, string> = {
		empty: "none/available/none",
		generating: "none/generating/none",
		ready: "ready/available/none",
		stale: "stale/available/none",
		stale_capped: "stale/available/none",
		failed: "none/available/failed-error",
		failed_ai_inactive: "ready/available/failed-muted",
		interrupted: "none/available/failed-error",
		no_provider: "none/blocked:no_provider/none",
		spend_cap: "none/blocked:over_budget/none",
		too_little_activity: "none/blocked:too_little_activity/none",
		cooldown: "ready/blocked:cooling_down/none",
		evidence_shrunk: "ready/available/none",
		suspect: "ready/available/none",
		retention: "ready/available/none",
	};

	test("TC-7.28a every committed fixture derives without throwing and yields its expected state", () => {
		const names = Object.keys(F) as SummaryViewFixtureName[];
		expect([...names].sort() as string[]).toEqual(Object.keys(EXPECTED).sort());
		for (const name of names) {
			expect(derive(F[name]).stateTag, name).toBe(EXPECTED[name]);
		}
	});

	test("TC-7.28b the view carries no AI state (key scan), and no owner or key ids", () => {
		const forbidden =
			/^(runtime|paused|killSwitch|active|build|aiActive|aiPaused|ownerUserId|ingestKeyId|providerId)$/;
		const scan = (value: unknown, path: string): string[] => {
			if (Array.isArray(value)) return value.flatMap((v, i) => scan(v, `${path}[${i}]`));
			if (value && typeof value === "object") {
				return Object.entries(value).flatMap(([k, v]) => [
					...(forbidden.test(k) ? [`${path}.${k}`] : []),
					...scan(v, `${path}.${k}`),
				]);
			}
			return [];
		};
		for (const [name, view] of Object.entries(F)) expect(scan(view, name), name).toEqual([]);
	});

	test("TC-7.28c the retention fixture reaches the footer and the suspect fixture reaches the notice", () => {
		expect(footerText(F.retention, CLOCK)?.retention).toContain("30 days");
		expect(derive(F.suspect).suspectNotice).not.toBeNull();
	});
});

describe("clipboard builders", () => {
	const META = { name: "my\nsession ```x```", branch: "feat/x", cwd: "/w/proj" };
	const nonEmpty = (md: string) => md.split("\n").filter((l) => l.trim() !== "");

	function fencedRegions(md: string): Array<[number, number, number]> {
		const lines = md.split("\n");
		const out: Array<[number, number, number]> = [];
		let open: { at: number; marker: string } | null = null;
		lines.forEach((line, i) => {
			if (open) {
				if (line === open.marker) {
					out.push([open.at, i, open.marker.length]);
					open = null;
				}
			} else if (/^`{3,}$/.test(line)) open = { at: i, marker: line };
		});
		if (open) throw new Error("unclosed fence");
		return out;
	}

	test("TC-7.10a the verify line is the first line and the last", () => {
		const lines = nonEmpty(buildHandoffMarkdown(STORED, META));
		expect(lines[0]).toBe(VERIFY_LINE);
		expect(lines[lines.length - 1]).toBe(VERIFY_LINE);
	});

	test("TC-7.10b one line carries name, branch and directory, and a hostile name stays on it", () => {
		const md = buildHandoffMarkdown(STORED, META);
		const lines = md.split("\n").filter((l) => l.includes("feat/x"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("/w/proj");
		expect(lines[0]).toContain("my session");
		expect(lines[0]).not.toContain("`");
	});

	test("TC-7.10c outcome, unfinished work, numbered next actions and key context; no overview, accomplishments or evidence ids", () => {
		const stored: StoredSessionSummary = {
			summary: {
				...STORED.summary,
				overview: "OVERVIEW-SENTINEL",
				accomplishments: [
					{ text: "ACCOMPLISHMENT-SENTINEL", evidence: ["E777777"], unverified: false },
				],
			},
			provenance: STORED.provenance,
		};
		const md = buildHandoffMarkdown(stored, META);
		expect(md).toContain("Mostly Completed");
		expect(md).toContain("Everything but the docs landed.");
		expect(md).toContain("- Write the docs");
		expect(md).toContain("1. Write the docs");
		expect(md).toContain("2. Run the live check");
		expect(md).toContain("The tab is built and tested. Docs remain.");
		expect(md).not.toContain("OVERVIEW-SENTINEL");
		expect(md).not.toContain("ACCOMPLISHMENT-SENTINEL");
		expect(md).not.toContain("E777777");
	});

	test("TC-7.10d an empty Unfinished Work reads as the owner's sentence", () => {
		const stored: StoredSessionSummary = {
			...STORED,
			summary: { ...STORED.summary, unfinished: [] },
		};
		expect(buildHandoffMarkdown(stored, META)).toContain(NO_UNFINISHED_WORK);
	});

	const HOSTILE = "before\n````\n~~~~\n# Outcome\n```\nafter";
	const hostile: StoredSessionSummary = {
		summary: {
			...STORED.summary,
			overview: HOSTILE,
			outcome: { status: "completed", explanation: HOSTILE },
			accomplishments: [{ text: HOSTILE, evidence: [], unverified: false }],
			changes: [{ kind: "other", text: HOSTILE, evidence: [], unverified: false }],
			decisions: [{ text: HOSTILE, why: HOSTILE, evidence: [] }],
			validation: [
				{ what: HOSTILE, result: "passed", detail: HOSTILE, evidence: [], adjusted: false },
			],
			problems: [{ text: HOSTILE, evidence: [] }],
			unfinished: [{ text: HOSTILE, evidence: [] }],
			nextActions: [{ text: HOSTILE, evidence: [] }],
			handoff: HOSTILE,
		},
		provenance: STORED.provenance,
	};

	test("TC-7.11 model-authored text sits in a fence longer than any backtick or tilde run in it, in all three builders", () => {
		const outputs = [
			buildHandoffMarkdown(hostile, META),
			buildSummaryMarkdown(hostile, META),
			buildContextMarkdown(hostile),
		];
		for (const md of outputs) {
			const regions = fencedRegions(md);
			expect(regions.length).toBeGreaterThan(0);
			const lines = md.split("\n");
			for (const [start, end, len] of regions) {
				expect(len).toBeGreaterThan(4);
				// the hostile heading is never outside a fence
				void start;
				void end;
			}
			lines.forEach((line, i) => {
				if (line === "# Outcome") expect(regions.some(([s, e]) => i > s && i < e)).toBe(true);
			});
		}
	});

	test("TC-7.12a the summary has all ten sections in order, results in words, and the labels", () => {
		const md = buildSummaryMarkdown(STORED, META);
		const headings = md.split("\n").filter((l) => l.startsWith("## "));
		expect(headings).toEqual([
			"## Overview",
			"## Outcome",
			"## Accomplishments",
			"## Changes",
			"## Decisions & Assumptions",
			"## Validation",
			"## Problems & Risks",
			"## Unfinished Work",
			"## Recommended Next Actions",
			"## Key Context",
		]);
		expect(md).toContain("Passed");
		expect(md).toContain("Unknown: ");
		expect(md).toContain("agent's claim only");
		const lines = nonEmpty(md);
		expect(lines[0]).toBe(VERIFY_LINE);
		expect(lines[lines.length - 1]).toBe(VERIFY_LINE);
	});

	test("TC-7.12b the context has the same first and last line and nothing but Key Context", () => {
		const md = buildContextMarkdown(STORED);
		const lines = nonEmpty(md);
		expect(lines[0]).toBe(VERIFY_LINE);
		expect(lines[lines.length - 1]).toBe(VERIFY_LINE);
		expect(md).toContain("The tab is built and tested. Docs remain.");
		expect(md).not.toContain("Built the summary tab");
		expect(md).not.toContain("Everything but the docs landed.");
	});
});

describe("settings link seen from the model", () => {
	test("TC-7.32c the no-provider link follows whether the AI panel exists", () => {
		const view = { ...F.no_provider };
		expect(
			deriveSummaryView(ready(view), { ...AI_ON, build: true }, ADMIN, CLOCK)?.action,
		).toMatchObject({ link: { href: "/settings?panel=ai" } });
		expect(resolvePanel("ai", { account: true, ai: true })).toBe("ai");
	});
});
