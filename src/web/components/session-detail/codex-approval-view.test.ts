import { describe, expect, test } from "bun:test";
import {
	APPROVAL_ANSWER_REFUSALS,
	APPROVAL_CLOSED_REASONS,
	CODEX_APPROVAL_OUTCOMES,
	type CodexApprovalDetail,
	type CodexApprovalSummary,
	NOT_APPROVABLE_REASONS,
	type NotApprovableReason,
} from "../../../shared/codex-approvals.js";
import { ApiError } from "../../lib/api.js";
import {
	UNCONFIRMED_COPY,
	approvalErrorCopy,
	describeApprovalError,
} from "../../lib/approval-errors.js";
import {
	ARM_AFTER_MS,
	CANNOT_ACCEPT_TEXT,
	CHECK_FAILED_TEXT,
	CLOSED_TEXT,
	type CardStateKind,
	HOST_FALLBACK,
	HOST_GONE_TEXT,
	NEXT_REQUEST_LINE,
	NON_ASCII_HINT,
	OWNER_FALLBACK,
	REVISION_CHANGED_LINE,
	STILL_OPEN_TEXT,
	STOP_CONFIRM_BODY,
	STOP_CONFIRM_TITLE,
	TAIL_MAX_CHARS,
	arrivalAnnouncement,
	availabilityHint,
	cardStateOf,
	changeSummary,
	commandStats,
	commandTail,
	confirmCopy,
	countdownText,
	crossedTwoMinutes,
	decisionBody,
	defaultDiffsOpen,
	detailMatchesRow,
	diffDeltaLabel,
	dismissedStorageKey,
	fetchDelayMs,
	filesSummary,
	freezeConfirm,
	hostOfflineText,
	isOutcomeFinal,
	markBlankRuns,
	metaLine,
	midConfirmEvent,
	midConfirmView,
	newlyPending,
	notApprovableReasonCopy,
	notApprovableText,
	offersOf,
	outcomeLine,
	outcomeTimeSource,
	outsideCwdText,
	outsideFirst,
	queuePosition,
	readDismissed,
	remainingLabel,
	requestHeading,
	secondsLeft,
	shouldRefetchOnSession,
	showsAvailabilityHint,
	signedDiffLines,
	splitRows,
	teamNotOwnerHeading,
	teamNotOwnerLine,
	twoMinuteAnnouncement,
	updateKept,
	writeDismissed,
} from "./codex-approval-view.js";

const STATE_WORDS = /\b(working|waiting|idle|error)\b/i;

function row(over: Partial<CodexApprovalSummary> = {}): CodexApprovalSummary {
	return {
		id: "a1",
		requestKind: "command",
		state: "pending",
		outcome: null,
		decision: null,
		answeredAt: null,
		revision: 1,
		presentationHash: "h1",
		approvable: true,
		notApprovableReason: null,
		canCancel: true,
		createdAt: "2026-11-03T10:00:00.000Z",
		expiresAt: "2026-11-03T10:20:00.000Z",
		expiresInSeconds: 1200,
		preview: null,
		...over,
	};
}

const LIVE = { state: "live", name: "host-x" } as const;
const CTX = { notOwner: false, host: LIVE, viewer: { canAccept: true } };

describe("the card state table (D6)", () => {
	const cases: Array<{
		name: string;
		ctx: Parameters<typeof cardStateOf>[0];
		approval: Pick<CodexApprovalSummary, "approvable">;
		state: CardStateKind;
		approve: boolean;
		decline: boolean;
	}> = [
		{
			name: "403 not_owner",
			ctx: { ...CTX, notOwner: true },
			approval: { approvable: true },
			state: "team_not_owner",
			approve: false,
			decline: false,
		},
		{
			name: "host offline",
			ctx: { ...CTX, host: { state: "offline", name: "h" } },
			approval: { approvable: true },
			state: "host_offline",
			approve: false,
			decline: false,
		},
		{
			name: "host gone",
			ctx: { ...CTX, host: { state: "gone", name: null } },
			approval: { approvable: true },
			state: "host_gone",
			approve: false,
			decline: false,
		},
		{
			name: "not approvable",
			ctx: CTX,
			approval: { approvable: false },
			state: "not_approvable",
			approve: false,
			decline: true,
		},
		{
			name: "viewer.canAccept false",
			ctx: { ...CTX, viewer: { canAccept: false } },
			approval: { approvable: true },
			state: "cannot_accept",
			approve: false,
			decline: true,
		},
		{
			name: "pending, approvable",
			ctx: CTX,
			approval: { approvable: true },
			state: "pending_approvable",
			approve: true,
			decline: true,
		},
	];
	for (const c of cases) {
		test(c.name, () => {
			const state = cardStateOf(c.ctx, c.approval);
			expect(state).toBe(c.state);
			expect(offersOf(state, true)).toEqual({
				approve: c.approve,
				decline: c.decline,
				stop: c.decline,
			});
			expect(offersOf(state, false).stop).toBe(false);
		});
	}

	test("first match wins: a not-owner list beats an offline host, an offline host beats not approvable", () => {
		expect(
			cardStateOf(
				{ notOwner: true, host: { state: "offline", name: "h" }, viewer: { canAccept: false } },
				{ approvable: false },
			),
		).toBe("team_not_owner");
		expect(
			cardStateOf(
				{ ...CTX, host: { state: "offline", name: "h" }, viewer: { canAccept: false } },
				{ approvable: false },
			),
		).toBe("host_offline");
		expect(cardStateOf({ ...CTX, viewer: { canAccept: false } }, { approvable: false })).toBe(
			"not_approvable",
		);
	});

	test("an unanswerable host offers nothing, not even Decline", () => {
		expect(offersOf("host_offline", true)).toEqual({ approve: false, decline: false, stop: false });
	});
});

describe("copy", () => {
	test("every outcome has a line, with the host and the time filled in", () => {
		for (const outcome of CODEX_APPROVAL_OUTCOMES) {
			const text = outcomeLine(outcome, "host-x", "3:42 PM");
			expect(text.length, outcome).toBeGreaterThan(10);
			expect(text, outcome).not.toContain("undefined");
			expect(text, outcome).not.toContain("{");
		}
	});

	test("the plan's lines, word for word", () => {
		expect(outcomeLine("sending_accept", "H", "T")).toBe(
			"Approved and on its way to H. It may already be running. The result appears in the timeline.",
		);
		expect(outcomeLine("sending_decline", "H", "T")).toBe("Declined. Telling H…");
		expect(outcomeLine("approved_sent", "H", "T")).toBe(
			"Approved at T and sent to H. The result appears in the timeline.",
		);
		expect(outcomeLine("declined", "H", "T")).toBe("Declined at T. Nothing ran.");
		expect(outcomeLine("declined_stopped", "H", "T")).toBe(
			"Declined at T, and the turn was stopped. Nothing ran.",
		);
		expect(outcomeLine("expired", "H", "T")).toBe(
			"Nobody answered by T, so this was declined. Nothing ran.",
		);
		expect(outcomeLine("answer_lapsed", "H", "T")).toBe(
			"You approved this, but it didn't reach H in time, so it was declined. Nothing ran.",
		);
		expect(outcomeLine("may_have_run", "H", "T")).toBe(
			"This may have run. Approved, but H never confirmed. Check the machine before asking again.",
		);
	});

	test("'Nothing ran' appears only where no accept can have been delivered", () => {
		const mayRun = CODEX_APPROVAL_OUTCOMES.filter(
			(o) => !outcomeLine(o, "H", "T").includes("Nothing ran"),
		);
		expect(mayRun.map(String).sort()).toEqual(
			[
				"approved_sent",
				"decided_elsewhere",
				"may_have_run",
				"sending_accept",
				"sending_decline",
			].sort(),
		);
	});

	test("without a time, an outcome line still reads whole", () => {
		expect(outcomeLine("declined", "H", null)).toBe("Declined. Nothing ran.");
		expect(outcomeLine("expired", "H", null)).toBe(
			"Nobody answered, so this was declined. Nothing ran.",
		);
		expect(outcomeLine("approved_sent", "H", null)).toBe(
			"Approved and sent to H. The result appears in the timeline.",
		);
	});

	test("which time an outcome quotes", () => {
		const r = row({ answeredAt: "A", expiresAt: "E" });
		expect(outcomeTimeSource("approved_sent", r)).toBe("A");
		expect(outcomeTimeSource("declined", r)).toBe("A");
		expect(outcomeTimeSource("expired", r)).toBe("E");
		expect(outcomeTimeSource("may_have_run", r)).toBeNull();
	});

	test("only the two sending outcomes are not final", () => {
		expect(CODEX_APPROVAL_OUTCOMES.filter((o) => !isOutcomeFinal(o))).toEqual([
			"sending_accept",
			"sending_decline",
		]);
	});

	test("every not-approvable reason has copy, and the card adds what to do about it", () => {
		for (const reason of NOT_APPROVABLE_REASONS) {
			const copy = notApprovableReasonCopy(reason, "/root");
			expect(copy.length, reason).toBeGreaterThan(20);
			const full = notApprovableText(reason, "host-x", "/root");
			expect(full, reason).toContain(
				"You can only decline it here. If you want it done, run it yourself on host-x.",
			);
		}
		expect(notApprovableReasonCopy("grant_root", "/srv/data")).toContain("/srv/data");
		expect(notApprovableReasonCopy("grant_root", null)).toContain("a directory");
		expect(notApprovableText("too_long", null)).toContain(`on ${HOST_FALLBACK}.`);
	});

	test("the three reasons added after the plan say why and don't promise a terminal", () => {
		for (const reason of ["padded_text", "lookalike_text", "too_long"] as NotApprovableReason[]) {
			const full = notApprovableText(reason, "h");
			expect(full).not.toMatch(/terminal/i);
			expect(full).toContain("decline");
		}
	});

	test("a reason this build doesn't know still says it can't be approved", () => {
		expect(notApprovableReasonCopy("from_the_future" as NotApprovableReason)).toContain("can't");
		expect(notApprovableReasonCopy(null)).toContain("can't");
	});

	test("every refusal code has copy, and it is the plan's where the plan gave it", () => {
		const ctx = { host: "H", owner: "O", declinesAt: "T", reason: "network" as const };
		for (const code of [...APPROVAL_ANSWER_REFUSALS, "bad_origin"]) {
			const text = approvalErrorCopy(code, ctx);
			expect(text, code).not.toBeNull();
			expect(text as string, code).not.toContain("{");
		}
		expect(approvalErrorCopy("not_owner", ctx)).toBe(
			"Only O or an admin can answer this. Nothing was sent.",
		);
		expect(approvalErrorCopy("host_offline", ctx)).toBe(
			"H is offline, so your answer can't reach it. Nothing was sent. You can answer if it's back before T.",
		);
		expect(approvalErrorCopy("not_approvable", ctx)).toContain("You can only decline it here.");
		expect(approvalErrorCopy("expired", ctx)).toContain("nothing ran");
		expect(approvalErrorCopy("bad_origin", ctx)).toContain("PUBLIC_URL");
	});

	test("a code outside the table is unconfirmed, and never claims nothing was sent", () => {
		for (const err of [
			new ApiError(500, "boom", { error: "kaboom" }),
			new ApiError(502, "bad gateway", null),
			new ApiError(400, "bad", { error: "invalid_body" }),
			new TypeError("Failed to fetch"),
			new Error("Session expired; reloading to reauthenticate."),
		]) {
			const view = describeApprovalError(err, {
				host: "H",
				owner: "O",
				declinesAt: null,
				reason: null,
			});
			expect(view.text).toBe(UNCONFIRMED_COPY);
			expect(view.unconfirmed).toBe(true);
			expect(view.stale).toBe(true);
			expect(view.text).not.toMatch(/nothing was sent/i);
		}
	});

	test("a known refusal says so, keeps its meaning, and busy keeps the shared sentence", () => {
		const ctx = { host: null, owner: null, declinesAt: null, reason: null };
		const stale = describeApprovalError(new ApiError(409, "x", { error: "already_resolved" }), ctx);
		expect(stale).toMatchObject({ unconfirmed: false, stale: true });
		const notOwner = describeApprovalError(new ApiError(403, "x", { error: "not_owner" }), ctx);
		expect(notOwner.text).toBe(
			`Only ${OWNER_FALLBACK} or an admin can answer this. Nothing was sent.`,
		);
		expect(notOwner.stale).toBe(false);
		const busy = describeApprovalError(new ApiError(503, "x", { error: "busy" }), ctx);
		expect(busy.unconfirmed).toBe(false);
		expect(busy.text).toContain("busy");
	});

	test("{host} and {owner} fall back, never to a literal", () => {
		expect(metaLine(null, null)).toBe(HOST_FALLBACK);
		expect(metaLine("   ", null)).toBe(HOST_FALLBACK);
		expect(hostOfflineText(null, "T")).toContain(HOST_FALLBACK);
		expect(teamNotOwnerHeading(null)).toBe(`Codex is asking ${OWNER_FALLBACK} for approval.`);
		expect(teamNotOwnerLine(" ")).toBe(`Only ${OWNER_FALLBACK} or an admin can answer.`);
		expect(teamNotOwnerHeading("O")).toBe("Codex is asking O for approval.");
		expect(
			confirmCopy({ requestKind: "command", fileCount: 0, host: null, declinesAt: "T" }).title,
		).toBe(`Run this on ${HOST_FALLBACK}?`);
	});

	test("every string avoids working, waiting, idle and error as state words", () => {
		const ctx = {
			host: "H",
			owner: "O",
			declinesAt: "T",
			reason: "network" as const,
			grantRoot: "/r",
		};
		const strings: string[] = [
			CANNOT_ACCEPT_TEXT,
			HOST_GONE_TEXT,
			NON_ASCII_HINT,
			STOP_CONFIRM_BODY,
			STOP_CONFIRM_TITLE,
			UNCONFIRMED_COPY,
			hostOfflineText("H", "T"),
			teamNotOwnerHeading("O"),
			teamNotOwnerLine("O"),
			outsideCwdText("/w"),
			outsideCwdText(null),
			twoMinuteAnnouncement("T"),
			arrivalAnnouncement({
				requestKind: "command",
				fileCount: 0,
				declinesAt: "T",
				pendingCount: 1,
			}),
			arrivalAnnouncement({
				requestKind: "file_change",
				fileCount: 3,
				declinesAt: "T",
				pendingCount: 1,
			}),
			arrivalAnnouncement({
				requestKind: "command",
				fileCount: 0,
				declinesAt: "T",
				pendingCount: 2,
			}),
			requestHeading(row()),
			requestHeading(row({ requestKind: "file_change", preview: { fileCount: 2 } as never })),
			countdownText("T", 600),
			countdownText("T", 30),
			countdownText("T", 0),
		];
		for (const o of CODEX_APPROVAL_OUTCOMES) strings.push(outcomeLine(o, "H", "T"));
		for (const r of NOT_APPROVABLE_REASONS) strings.push(notApprovableText(r, "H", "/r"));
		for (const code of [...APPROVAL_ANSWER_REFUSALS, "bad_origin"]) {
			strings.push(approvalErrorCopy(code, ctx) as string);
		}
		for (const v of [undefined, "supported", "unsupported", "insecure_transport"]) {
			const h = availabilityHint(v === undefined ? {} : { agentpulseApprovals: v }, "H");
			if (h) strings.push(h);
		}
		for (const e of ["time_up", "revision_changed", "closed"] as const) {
			strings.push(midConfirmView(e, null, "H", () => "T").text);
		}
		strings.push(
			outcomeLine("turn_ended", "H", null, "accept"),
			outcomeLine("codex_shut_down", "H", null, "accept"),
			REVISION_CHANGED_LINE,
			NEXT_REQUEST_LINE,
			STILL_OPEN_TEXT,
			CHECK_FAILED_TEXT,
			NON_ASCII_HINT,
		);
		for (const kind of ["command", "file_change"] as const) {
			const c = confirmCopy({
				requestKind: kind,
				fileCount: 2,
				host: "H",
				declinesAt: "T",
				owner: "O",
			});
			strings.push(c.title, c.confirmLabel, ...c.closing);
		}
		expect(strings.length).toBeGreaterThan(60);
		for (const s of strings) expect(s, s).not.toMatch(STATE_WORDS);
	});
});

describe("availability hint", () => {
	test("every value of agentpulseApprovals, absent included, gives its hint", () => {
		expect(availabilityHint({ agentpulseApprovals: "supported" }, "H")).toBeNull();
		expect(availabilityHint({ agentpulseApprovals: "unsupported" }, "H")).toBe(
			"Codex on H isn't a version AgentPulse can answer approvals for, so its approval requests are declined automatically.",
		);
		expect(availabilityHint({ agentpulseApprovals: "insecure_transport" }, "H")).toBe(
			"H doesn't reach AgentPulse over https, so its approval requests are declined automatically.",
		);
		const absent = "Update the AgentPulse supervisor on H to answer Codex approvals here.";
		expect(availabilityHint({}, "H")).toBe(absent);
		expect(availabilityHint(null, "H")).toBe(absent);
		expect(availabilityHint(undefined, "H")).toBe(absent);
		expect(availabilityHint({ initResult: 1 }, "H")).toBe(absent);
	});

	test("no host name falls back; a value this build doesn't know claims nothing", () => {
		expect(availabilityHint({ agentpulseApprovals: "unsupported" }, null)).toContain(HOST_FALLBACK);
		expect(availabilityHint({ agentpulseApprovals: "from_the_future" }, "H")).toBeNull();
	});
});

describe("mid-confirm events", () => {
	const frozen = { hash: "h1", revision: 1 };
	const live = (over: Partial<CodexApprovalSummary> = {}) => row(over);

	test("nothing changed", () => {
		expect(midConfirmEvent(frozen, live(), 600)).toBeNull();
	});

	test("the clock reaching zero on a row that is still open is time_up, never a claim about the answer", () => {
		expect(midConfirmEvent(frozen, live(), 0)).toBe("time_up");
		expect(midConfirmView("time_up", null, "H", () => null)).toEqual({
			text: "Time ran out. Checking what happened.",
			cancelLabel: "Close",
		});
	});

	test("revision changed: a new hash or a new revision on a row that is still open", () => {
		expect(midConfirmEvent(frozen, live({ presentationHash: "h2" }), 600)).toBe("revision_changed");
		expect(midConfirmEvent(frozen, live({ revision: 2 }), 600)).toBe("revision_changed");
		expect(midConfirmView("revision_changed", null, "H", () => null)).toEqual({
			text: "Codex changed what it's asking. Nothing was sent. Review the new version.",
			cancelLabel: "Back",
		});
	});

	test("closed: a row that is no longer open, or no longer listed, speaks in its own outcome", () => {
		for (const outcome of ["expired", "declined", "session_stopped", "sending_accept"] as const) {
			expect(midConfirmEvent(frozen, live({ state: "closed", outcome }), 600)).toBe("closed");
		}
		expect(
			midConfirmEvent(frozen, live({ state: "answered", outcome: "sending_accept" }), 600),
		).toBe("closed");
		expect(midConfirmEvent(frozen, null, 600)).toBe("closed");
		const view = (over: Partial<CodexApprovalSummary>) =>
			midConfirmView("closed", row(over), "H", (stored) => stored && "T");
		expect(view({ outcome: "expired", expiresAt: "E" }).text).toBe(
			"Nobody answered by T, so this was declined. Nothing ran.",
		);
		// The server's row, not a guess: an accept in flight is never "already answered" or "nothing ran".
		expect(view({ outcome: "sending_accept" }).text).toBe(
			"Approved and on its way to H. It may already be running. The result appears in the timeline.",
		);
		expect(view({ outcome: "turn_ended", decision: "accept" }).text).toBe(
			"You approved this, but the turn ended before it was sent. Nothing ran.",
		);
		expect(view({ outcome: "codex_shut_down", decision: "accept" }).text).toBe(
			"You approved this, but Codex shut down before it was sent. Nothing ran.",
		);
		expect(view({ outcome: "turn_ended", decision: "decline" }).text).toBe(
			"The turn ended before this was answered. Nothing ran.",
		);
		expect(midConfirmView("closed", null, "H", () => null).text).toBe(CLOSED_TEXT);
	});

	test("closed reasons the server can send all land on a known event", () => {
		expect(APPROVAL_CLOSED_REASONS.length).toBeGreaterThan(0);
		for (const outcome of CODEX_APPROVAL_OUTCOMES) {
			const event = midConfirmEvent(frozen, live({ state: "closed", outcome }), 600);
			expect(event, outcome).not.toBeNull();
		}
	});
});

describe("the confirm step", () => {
	test("the command dialog, with a host and without", () => {
		const named = confirmCopy({ requestKind: "command", fileCount: 0, host: "H", declinesAt: "T" });
		expect(named).toEqual({
			title: "Run this on H?",
			confirmLabel: "Run on H",
			cancelLabel: "Back",
			closing: ["Runs once. AgentPulse can't undo it.", "If nobody answers, it's declined at T."],
		});
		const bare = confirmCopy({ requestKind: "command", fileCount: 0, host: null, declinesAt: "T" });
		expect(bare.confirmLabel).toBe("Run it");
		expect(bare.title).toBe("Run this on this session's machine?");
	});

	test("the file-change dialog", () => {
		const c = confirmCopy({ requestKind: "file_change", fileCount: 3, host: "H", declinesAt: "T" });
		expect(c.title).toBe("Change 3 files on H?");
		expect(c.confirmLabel).toBe("Change 3 files");
		expect(
			confirmCopy({ requestKind: "file_change", fileCount: 1, host: "H", declinesAt: "T" }).title,
		).toBe("Change 1 file on H?");
	});

	test("an admin answering someone else's session is told whose it is", () => {
		const c = confirmCopy({
			requestKind: "command",
			fileCount: 0,
			host: "H",
			declinesAt: "T",
			owner: "O",
		});
		expect(c.closing[0]).toBe("This is O's session.");
	});

	test("paths with kinds, the first five, then how many more", () => {
		const changes = Array.from({ length: 7 }, (_, i) => ({
			path: `/w/f${i}`,
			kind: i === 0 ? "add" : "update",
			movePath: i === 1 ? "/w/g" : null,
		}));
		const { listed, more } = filesSummary(changes);
		expect(listed).toHaveLength(5);
		expect(listed[0]).toBe("New file /w/f0");
		expect(listed[1]).toBe("Edit /w/f1, moved to /w/g");
		expect(more).toBe("and 2 more");
		expect(filesSummary(changes.slice(0, 5)).more).toBeNull();
	});

	test("the dialog shows the last lines, blank runs marked, and says how much it is", () => {
		const command = `npm test${"\n".repeat(41)}rm -rf build`;
		expect(commandTail(command)).toEqual({
			text: "npm test\n[40 blank lines]\nrm -rf build",
			label: null,
		});
		expect(commandTail("a\nb\nc\nd\ne")).toEqual({ text: "c\nd\ne", label: "Last 3 of 5 lines:" });
		expect(commandTail("one line")).toEqual({ text: "one line", label: null });
	});

	test("a long last line is cut to its last 600 characters, with a mark, so the box never scrolls", () => {
		const long = `${"a".repeat(3000)}TAIL`;
		const one = commandTail(long);
		expect(one.text.startsWith("…")).toBe(true);
		expect(one.text.endsWith("aTAIL")).toBe(true);
		expect(one.text.length).toBe(TAIL_MAX_CHARS + 1);
		expect(one.label).toBe("End of the line:");
		const many = commandTail(`x\ny\nz\nw\n${long}`);
		expect(many.text.length).toBeLessThanOrEqual(TAIL_MAX_CHARS + 1);
		expect(many.text.endsWith("TAIL")).toBe(true);
		expect(many.label).toBe("End of the last lines:");
		// Exactly at the limit is not cut.
		expect(commandTail("b".repeat(TAIL_MAX_CHARS))).toEqual({
			text: "b".repeat(TAIL_MAX_CHARS),
			label: null,
		});
	});

	test("files outside the working directory are listed first and marked; no flags, no change", () => {
		const changes = Array.from({ length: 8 }, (_, i) => ({
			path: `/w/f${i}`,
			kind: "update",
			movePath: null,
		}));
		const flags = changes.map((_, i) => i === 7);
		const flagged = filesSummary(changes, flags);
		expect(flagged.listed[0]).toBe("Outside the working directory: Edit /w/f7");
		expect(flagged.listed[1]).toBe("Edit /w/f0");
		expect(flagged.more).toBe("and 3 more");
		expect(filesSummary(changes, null)).toEqual(filesSummary(changes));
		expect(filesSummary(changes, [true]).listed[0]).toBe("Edit /w/f0");
		expect(outsideFirst(3, [false, true, true])).toEqual([1, 2, 0]);
		expect(outsideFirst(3, null)).toEqual([0, 1, 2]);
	});

	test("a diff's size is counted on what is drawn, and a short request opens every diff", () => {
		expect(diffDeltaLabel("update", "@@ -1 +1 @@\n-a\n+b\n+c\n context\n")).toBe("+2 \u22121");
		expect(diffDeltaLabel("add", "x\ny\n")).toBe("+2 \u22120");
		expect(diffDeltaLabel("delete", "x\n")).toBe("+0 \u22121");
		expect(diffDeltaLabel("update", "")).toBeNull();
		const small = (n: number) => Array.from({ length: n }, () => ({ diff: "+x\n" }));
		expect(defaultDiffsOpen(small(3))).toEqual([true, true, true]);
		expect(defaultDiffsOpen(small(9))).toEqual(Array(9).fill(true));
		const big = Array.from({ length: 5 }, () => ({ diff: "+x\n".repeat(900) }));
		expect(defaultDiffsOpen(big)).toEqual([true, false, false, false, false]);
	});

	test("the foreign frozen flags come from the detail, and are null when an older server sent none", () => {
		const detail = {
			v: 1,
			approval: row({ requestKind: "file_change" }),
			presentation: {
				v: 1,
				requestKind: "file_change",
				changes: [],
				cwd: null,
				reason: null,
				grantRoot: null,
			},
			reasonText: null,
		} as unknown as CodexApprovalDetail;
		expect(freezeConfirm(detail)?.outsideCwd).toBeNull();
		expect(freezeConfirm({ ...detail, outsideCwd: [true] })?.outsideCwd).toEqual([true]);
	});

	test("the stats line counts lines and characters", () => {
		expect(commandStats("a\nb\nc")).toBe("3 lines, 5 characters");
		expect(commandStats("x")).toBe("1 line, 1 character");
		expect(commandStats("")).toBe("0 lines, 0 characters");
	});

	test("only an accept carries a hash, and it is the frozen one", () => {
		expect(decisionBody("accept", { hash: "frozen" })).toEqual({
			decision: "accept",
			presentationHash: "frozen",
		});
		expect(decisionBody("decline", { hash: "frozen" })).toEqual({ decision: "decline" });
		expect(decisionBody("cancel", null)).toEqual({ decision: "cancel" });
		expect(decisionBody("accept", null)).toEqual({ decision: "accept" });
	});

	test("freezing takes the hash and revision of the detail that was read", () => {
		const detail: CodexApprovalDetail = {
			v: 1,
			approval: row({ presentationHash: "H9", revision: 4 }),
			presentation: {
				v: 1,
				requestKind: "command",
				command: "ls",
				cwd: "/w",
				reason: null,
				grantRoot: null,
			},
			reasonText: null,
		};
		expect(freezeConfirm(detail)).toMatchObject({ approvalId: "a1", hash: "H9", revision: 4 });
		expect(freezeConfirm({ ...detail, presentation: null })).toBeNull();
	});

	test("the detail answers for the list's version only when id, hash and revision all match", () => {
		const detail: CodexApprovalDetail = {
			v: 1,
			approval: row({ presentationHash: "H", revision: 2 }),
			presentation: {
				v: 1,
				requestKind: "command",
				command: "ls",
				cwd: "/w",
				reason: null,
				grantRoot: null,
			},
			reasonText: null,
		};
		const base = { id: "a1", presentationHash: "H", revision: 2 };
		expect(detailMatchesRow(detail, base)).toBe(true);
		expect(detailMatchesRow(detail, { ...base, presentationHash: "X" })).toBe(false);
		expect(detailMatchesRow(detail, { ...base, revision: 3 })).toBe(false);
		expect(detailMatchesRow(detail, { ...base, id: "b" })).toBe(false);
		expect(detailMatchesRow(null, base)).toBe(false);
		expect(detailMatchesRow({ ...detail, presentation: null }, base)).toBe(false);
	});
});

describe("what a request shows", () => {
	test("headings are neither state words nor the command", () => {
		expect(requestHeading(row())).toBe("Codex asks to run a command");
		expect(
			requestHeading(row({ requestKind: "file_change", preview: { fileCount: 3 } as never })),
		).toBe("Codex asks to change 3 files");
		expect(
			requestHeading(row({ requestKind: "file_change", preview: { fileCount: 1 } as never })),
		).toBe("Codex asks to change 1 file");
	});

	test("one truncated line: host and the last directory", () => {
		expect(metaLine("H", "/Users/me/dev/project")).toBe("H · …/project");
		expect(metaLine("H", "/work")).toBe("H · /work");
		expect(metaLine("H", "C:\\code\\app")).toBe("H · …/app");
		expect(metaLine("H", null)).toBe("H");
		expect(metaLine("H", "/")).toBe("H · /");
	});

	test("blank runs are marked and nothing but blanks is replaced", () => {
		expect(markBlankRuns("a\n\n\n\n\nb")).toBe("a\n[4 blank lines]\nb");
		expect(markBlankRuns(`a${"\n \t".repeat(40)}\nb`)).toContain("[40 blank lines]");
		expect(markBlankRuns("a\n\n\nb")).toBe("a\n\n\nb");
		expect(markBlankRuns("a\n\nb")).toBe("a\n\nb");
		const text = "x = 1\n\n\n\n\n\ny = $(curl evil)";
		expect(markBlankRuns(text)).toContain("y = $(curl evil)");
	});

	test("a path outside the directory is loud and says which directory", () => {
		expect(outsideCwdText("/w")).toBe("This changes files outside /w.");
	});

	test("every diff line carries its sign", () => {
		expect(signedDiffLines("add", "one\ntwo\n")).toEqual(["+one", "+two"]);
		expect(signedDiffLines("delete", "gone\n")).toEqual(["-gone"]);
		expect(signedDiffLines("update", "@@ -1 +1 @@\n-a\n+b\n c\n")).toEqual([
			"@@ -1 +1 @@",
			"-a",
			"+b",
			" c",
		]);
		expect(signedDiffLines("update", "stray")).toEqual(["?stray"]);
		expect(signedDiffLines("add", "")).toEqual([]);
		expect(signedDiffLines("add", "-looks like a removal")).toEqual(["+-looks like a removal"]);
	});

	test("a kind and a move are said as words", () => {
		expect(changeSummary({ path: "/a", kind: "delete", movePath: null })).toBe("Delete /a");
		expect(changeSummary({ path: "/a", kind: "rename-ish", movePath: null })).toBe("rename-ish /a");
		expect(changeSummary({ path: "/a", kind: "", movePath: null })).toBe("Change /a");
	});
});

describe("countdown", () => {
	test("seconds left come from the server's figure and the monotonic clock, not the wall clock", () => {
		expect(secondsLeft(1200, 1000, 1000)).toBe(1200);
		expect(secondsLeft(1200, 1000, 31_000)).toBe(1170);
		expect(secondsLeft(10, 0, 20_000)).toBe(0);
		expect(secondsLeft(Number.NaN, 0, 0)).toBe(0);
	});

	test("minutes above two minutes, seconds below, in words as well as colour", () => {
		expect(remainingLabel(1080)).toBe("18 min");
		expect(remainingLabel(121)).toBe("3 min");
		expect(remainingLabel(119)).toBe("119 seconds");
		expect(remainingLabel(1)).toBe("1 second");
		expect(remainingLabel(0)).toBe("now");
		expect(countdownText("3:42 PM", 1080)).toBe("Declines at 3:42 PM (18 min)");
		expect(countdownText("3:42 PM", 45)).toBe("Declines at 3:42 PM (45 seconds)");
		expect(countdownText("3:42 PM", 0)).toBe("Declining now");
	});

	test("the two-minute announcement fires on the crossing only", () => {
		expect(crossedTwoMinutes(121, 120)).toBe(true);
		expect(crossedTwoMinutes(300, 119)).toBe(true);
		expect(crossedTwoMinutes(120, 119)).toBe(false);
		expect(crossedTwoMinutes(500, 400)).toBe(false);
		expect(crossedTwoMinutes(5, 0)).toBe(false);
	});
});

describe("which rows stay on screen", () => {
	const pending = (id: string, createdAt: string) => row({ id, createdAt });
	const closed = (id: string, outcome: CodexApprovalSummary["outcome"]) =>
		row({ id, state: "closed", outcome });

	test("open requests queue oldest first; settled ones follow", () => {
		const { pending: p, settled } = splitRows(
			[
				pending("b", "2026-11-03T10:05:00Z"),
				pending("a", "2026-11-03T10:00:00Z"),
				closed("c", "declined"),
			],
			new Map(),
			new Set(),
		);
		expect(p.map((r) => r.id)).toEqual(["a", "b"]);
		expect(settled.map((r) => r.id)).toEqual(["c"]);
	});

	test("a dismissed closed row goes; a dismissed open row cannot", () => {
		const { pending: p, settled } = splitRows(
			[pending("a", "2026-11-03T10:00:00Z"), closed("c", "declined")],
			new Map(),
			new Set(["a", "c"]),
		);
		expect(p.map((r) => r.id)).toEqual(["a"]);
		expect(settled).toEqual([]);
	});

	test("may_have_run stays after the server stops listing it, until dismissed", () => {
		const unknown = closed("m", "may_have_run");
		let kept = updateKept(new Map(), [unknown, closed("d", "declined")], new Set());
		expect([...kept.keys()]).toEqual(["m"]);
		kept = updateKept(kept, [], new Set());
		expect(splitRows([], kept, new Set()).settled.map((r) => r.id)).toEqual(["m"]);
		kept = updateKept(kept, [], new Set(["m"]));
		expect(splitRows([], kept, new Set(["m"])).settled).toEqual([]);
	});

	test("the server's later answer for a kept row replaces the kept copy", () => {
		const kept = updateKept(new Map(), [closed("m", "may_have_run")], new Set());
		const { settled } = splitRows([closed("m", "may_have_run")], kept, new Set());
		expect(settled).toHaveLength(1);
		expect(updateKept(kept, [closed("m", "approved_sent")], new Set()).size).toBe(0);
	});

	test("a request not announced before is new", () => {
		const a = pending("a", "x");
		const b = pending("b", "y");
		expect(newlyPending(new Set(["a"]), [a, b]).map((r) => r.id)).toEqual(["b"]);
	});
});

describe("announcements never read the command", () => {
	test("arrival, and a second request", () => {
		expect(
			arrivalAnnouncement({
				requestKind: "command",
				fileCount: 0,
				declinesAt: "T",
				pendingCount: 1,
			}),
		).toBe("Codex asks to run a command. Declines at T.");
		expect(
			arrivalAnnouncement({
				requestKind: "file_change",
				fileCount: 2,
				declinesAt: "T",
				pendingCount: 1,
			}),
		).toBe("Codex asks to change 2 files. Declines at T.");
		expect(
			arrivalAnnouncement({
				requestKind: "command",
				fileCount: 0,
				declinesAt: "T",
				pendingCount: 3,
			}),
		).toBe("3 requests need an answer.");
		expect(twoMinuteAnnouncement("T")).toBe("Two minutes left to answer. Declines at T.");
	});
});

describe("refresh rules", () => {
	test("an unchanged set of open requests and an empty list is no reason to fetch", () => {
		expect(
			shouldRefetchOnSession({ previousIds: [], ids: [], listHasRows: false, notOwner: false }),
		).toBe(false);
		expect(
			shouldRefetchOnSession({
				previousIds: ["a"],
				ids: ["a"],
				listHasRows: false,
				notOwner: false,
			}),
		).toBe(false);
	});

	test("a changed set is; so is anything on the list", () => {
		expect(
			shouldRefetchOnSession({ previousIds: [], ids: ["a"], listHasRows: false, notOwner: false }),
		).toBe(true);
		expect(
			shouldRefetchOnSession({ previousIds: ["a"], ids: [], listHasRows: false, notOwner: false }),
		).toBe(true);
		expect(
			shouldRefetchOnSession({
				previousIds: ["a"],
				ids: ["b"],
				listHasRows: false,
				notOwner: false,
			}),
		).toBe(true);
		expect(
			shouldRefetchOnSession({ previousIds: [], ids: [], listHasRows: true, notOwner: false }),
		).toBe(true);
	});

	test("a viewer who can't read the list stops fetching", () => {
		expect(
			shouldRefetchOnSession({ previousIds: [], ids: ["a"], listHasRows: true, notOwner: true }),
		).toBe(false);
	});

	test("at most one fetch every 2 s, unless forced", () => {
		expect(fetchDelayMs(0, false)).toBe(2000);
		expect(fetchDelayMs(500, false)).toBe(1500);
		expect(fetchDelayMs(2000, false)).toBe(0);
		expect(fetchDelayMs(60_000, false)).toBe(0);
		expect(fetchDelayMs(0, true)).toBe(0);
	});
});

describe("the numbering, honest", () => {
	test("answering one of three moves the next to 2 of 3, and a new arrival grows the total", () => {
		const first = queuePosition(new Set(), ["a", "b", "c"]);
		expect(first).toMatchObject({ index: 1, total: 3 });
		const second = queuePosition(first.universe, ["b", "c"]);
		expect(second).toMatchObject({ index: 2, total: 3 });
		const grown = queuePosition(second.universe, ["b", "c", "d"]);
		expect(grown).toMatchObject({ index: 2, total: 4 });
		expect(queuePosition(new Set(), ["x"])).toMatchObject({ index: 1, total: 1 });
	});
});

describe("what was dismissed is remembered, and a store that fails changes nothing", () => {
	const memory = () => {
		const data = new Map<string, string>();
		return {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => void data.set(k, v),
		};
	};

	test("round trip, per session, newest hundred", () => {
		const store = memory();
		writeDismissed(store, "s1", ["a", "b"]);
		expect([...readDismissed(store, "s1")]).toEqual(["a", "b"]);
		expect(readDismissed(store, "s2").size).toBe(0);
		writeDismissed(
			store,
			"s1",
			Array.from({ length: 150 }, (_, i) => `id${i}`),
		);
		const kept = readDismissed(store, "s1");
		expect(kept.size).toBe(100);
		expect(kept.has("id149")).toBe(true);
		expect(kept.has("id0")).toBe(false);
	});

	test("unreadable, wrong-shaped, throwing or missing storage is nothing dismissed, and never throws", () => {
		const bad = { getItem: () => "{not json", setItem: () => undefined };
		expect(readDismissed(bad, "s").size).toBe(0);
		const odd = { getItem: () => JSON.stringify({ a: 1 }) };
		expect(readDismissed(odd, "s").size).toBe(0);
		const mixed = { getItem: () => JSON.stringify(["a", 3, null, "b"]) };
		expect([...readDismissed(mixed, "s")]).toEqual(["a", "b"]);
		const full = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(readDismissed(full, "s").size).toBe(0);
		expect(() => writeDismissed(full, "s", ["a"])).not.toThrow();
		expect(readDismissed(null, "s").size).toBe(0);
		expect(() => writeDismissed(null, "s", ["a"])).not.toThrow();
		expect(dismissedStorageKey("s")).toContain("s");
	});
});

describe("the new fixed words", () => {
	test("they say what is true and no state word", () => {
		expect(REVISION_CHANGED_LINE).toBe("Codex changed what it's asking. Read it again.");
		expect(NEXT_REQUEST_LINE).toBe("Next request. The last one is shown below.");
		expect(ARM_AFTER_MS).toBe(700);
	});
});

describe("showsAvailabilityHint: no 'update the supervisor' while the slot owns the state", () => {
	test("hidden while pending (a takeover or resume in flight) and degraded, shown otherwise", () => {
		expect(showsAvailabilityHint({ managedState: "pending" })).toBe(false);
		expect(showsAvailabilityHint({ managedState: "degraded" })).toBe(false);
		expect(showsAvailabilityHint({ managedState: "managed" })).toBe(true);
		expect(showsAvailabilityHint(null)).toBe(true);
		expect(showsAvailabilityHint(undefined)).toBe(true);
	});
});
