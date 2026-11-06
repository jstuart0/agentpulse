/**
 * AGEN-117 P4, web half: the approval card's words for a takeover fork of a Claude Code session (T9, T10). The
 * harness has no DOM, so this holds the pure functions and a read of the card's source: every state a Claude
 * request can be in, rendered for `claude`, must not say Codex; the Codex words stay as they were.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	CODEX_APPROVAL_OUTCOMES,
	type CodexApprovalSummary,
	NOT_APPROVABLE_REASONS,
} from "../../../shared/codex-approvals.js";
import { describeApprovalError } from "../../lib/approval-errors.js";
import {
	approvalNoteCanAnswer,
	chunkLoadFailedCopy,
	codexApprovalNoteOtherOwner,
	showsApprovalCard,
} from "../../lib/codex-approval-wait.js";
import { PeerTurnNotice } from "./CodexApprovalCard.js";
import {
	MAY_HAVE_RUN_LEAD,
	agentOfSession,
	arrivalAnnouncement,
	availabilityHint,
	confirmCopy,
	focusAfterClose,
	forkModeOf,
	kindWord,
	midConfirmView,
	notApprovableText,
	outcomeLine,
	peerTurnLines,
	requestHeading,
	revisionChangedLine,
	signedDiffLines,
	stopConfirmBody,
	teamNotOwnerHeading,
	updateKept,
	writeKindNote,
} from "./codex-approval-view.js";
import { launchSummaryLine, overviewOriginField } from "./session-takeover-view.js";

const HOST = "build-host";
const row = (over: Partial<CodexApprovalSummary> = {}): CodexApprovalSummary => ({
	id: "a1",
	requestKind: "command",
	state: "closed",
	outcome: "decided_elsewhere",
	decision: null,
	answeredAt: null,
	revision: 1,
	presentationHash: "h",
	approvable: false,
	notApprovableReason: null,
	canCancel: true,
	createdAt: "2026-11-05T10:00:00.000Z",
	expiresAt: "2026-11-05T10:20:00.000Z",
	expiresInSeconds: 0,
	preview: null,
	...over,
});

describe("every state, for Claude, never says Codex", () => {
	test("each outcome in both modes", () => {
		expect(CODEX_APPROVAL_OUTCOMES.length).toBeGreaterThanOrEqual(15);
		for (const outcome of CODEX_APPROVAL_OUTCOMES) {
			for (const mode of ["ask", "restricted", undefined] as const) {
				for (const decision of ["accept", "decline", "cancel", null] as const) {
					const text = outcomeLine(outcome, HOST, "10:00 AM", decision, "claude", mode);
					expect(text, `${outcome}/${mode}/${decision}`).not.toMatch(/Codex/);
					expect(text).not.toMatch(/take over|headless/i);
				}
			}
		}
	});

	test("each reason a request can only be declined", () => {
		for (const reason of NOT_APPROVABLE_REASONS) {
			const text = notApprovableText(reason, HOST, "/root", "claude");
			expect(text, reason).not.toMatch(/Codex/);
			expect(text).toContain("You can only decline it here.");
		}
	});

	test("headings, announcements, hints, errors, mid-confirm and stop words", () => {
		const lines = [
			requestHeading({ requestKind: "command", preview: null }, "claude"),
			requestHeading({ requestKind: "file_change", preview: null }, "claude"),
			requestHeading(
				{
					requestKind: "claude_tool",
					preview: {
						cwd: null,
						tool: "WebFetch",
						target: "https://example.com",
						pathOutsideCwd: false,
						nonAscii: false,
					},
				},
				"claude",
			),
			arrivalAnnouncement({
				requestKind: "command",
				fileCount: 0,
				declinesAt: "10:20",
				pendingCount: 1,
				agent: "claude",
			}),
			arrivalAnnouncement({
				requestKind: "claude_tool",
				fileCount: 0,
				declinesAt: null,
				pendingCount: 1,
				agent: "claude",
				tool: "Read",
			}),
			arrivalAnnouncement({
				requestKind: "file_change",
				fileCount: 1,
				declinesAt: null,
				pendingCount: 1,
				agent: "claude",
			}),
			revisionChangedLine("claude"),
			stopConfirmBody("claude"),
			teamNotOwnerHeading("Sam", "claude"),
			midConfirmView("revision_changed", null, HOST, () => null, "claude").text,
			midConfirmView(
				"closed",
				{
					outcome: "decided_elsewhere",
					decision: null,
					answeredAt: null,
					expiresAt: "2026-11-05T10:20:00.000Z",
				},
				HOST,
				() => null,
				"claude",
				"ask",
			).text,
			describeApprovalError(Object.assign(new Error("x"), { code: "presentation_changed" }), {
				host: HOST,
				owner: null,
				declinesAt: null,
				reason: null,
				agent: "claude",
			}).text,
			approvalNoteCanAnswer("claude_code"),
			chunkLoadFailedCopy("claude_code"),
			codexApprovalNoteOtherOwner("Sam", true, "claude_code"),
		];
		for (const line of lines) expect(line).not.toMatch(/Codex/);
		expect(availabilityHint(undefined, HOST, "claude")).toBeNull();
		expect(availabilityHint({ agentpulseApprovals: "unsupported" }, HOST, "claude")).toBeNull();
	});

	test("the Codex words are what they were", () => {
		expect(requestHeading({ requestKind: "command", preview: null })).toBe(
			"Codex asks to run a command",
		);
		expect(outcomeLine("codex_shut_down", HOST, null, "accept")).toBe(
			"You approved this, but Codex shut down before it was sent. Nothing ran.",
		);
		expect(revisionChangedLine()).toBe("Codex changed what it's asking. Read it again.");
		expect(approvalNoteCanAnswer("codex_cli")).toBe(
			"Codex is asking for approval. Open the session to answer.",
		);
		expect(notApprovableText("no_diff", HOST)).toBe(
			`Codex didn't share the changes, so there's nothing to review. You can only decline it here. If you want it done, run it yourself on ${HOST}.`,
		);
	});

	test("the card's source names Codex only in the one branch gated on the agent", () => {
		const source = readFileSync(join(import.meta.dir, "CodexApprovalCard.tsx"), "utf8")
			.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|[^:])\/\/.*$/gm, "$1");
		const lines = source.split("\n").filter((l) => /Codex/.test(l) && /["'`]/.test(l));
		const bare = lines.filter(
			(l) => !/agent === "claude"/.test(l) && /"[^"]*\bCodex\b[^"]*"|`[^`]*\bCodex\b[^`]*`/.test(l),
		);
		expect(bare).toEqual([]);
	});
});

describe("the exact copy", () => {
	test("decided elsewhere, by mode, with the bold lead the card draws", () => {
		expect(outcomeLine("decided_elsewhere", HOST, null, null, "claude", "ask")).toBe(
			`${MAY_HAVE_RUN_LEAD} Something on ${HOST} answered before you did, most likely a rule or hook in your Claude settings. Check the machine before asking again.`,
		);
		expect(outcomeLine("decided_elsewhere", HOST, null, null, "claude", "restricted")).toBe(
			`${MAY_HAVE_RUN_LEAD} Something on ${HOST} answered before you did. Check the machine before asking again.`,
		);
		expect(outcomeLine("codex_shut_down", HOST, null, null, "claude")).toBe(
			"Claude stopped running before this was answered. That request didn't run.",
		);
	});

	test("the decline-only sentences", () => {
		expect(notApprovableText("unknown_tool", HOST, null, "claude")).toBe(
			"AgentPulse hasn't seen this tool, so it can't show what approving would mean. You can only decline it here.",
		);
		expect(notApprovableText("requires_interaction", HOST, null, "claude")).toBe(
			"This tool needs someone at the machine to work with it, which AgentPulse can't do. You can only decline it here.",
		);
		expect(notApprovableText("symlink_target", HOST, null, "claude")).toBe(
			`This path points somewhere else on ${HOST}. You can only decline it here.`,
		);
		expect(notApprovableText("agent_memory", HOST, null, "claude")).toBe(
			"Claude can't save memories in this session. You can only decline it here.",
		);
	});

	test("every confirm title: no '0 files', and the Claude cards say what approving does", () => {
		for (const kind of ["command", "file_change", "claude_tool"] as const) {
			for (const fileCount of [0, 1, 2]) {
				const copy = confirmCopy({ requestKind: kind, fileCount, host: HOST, declinesAt: null });
				expect(`${copy.title} ${copy.confirmLabel}`, `${kind}/${fileCount}`).not.toMatch(
					/\b0 files?\b/,
				);
			}
		}
		expect(
			confirmCopy({
				requestKind: "claude_tool",
				tool: "WebFetch",
				fileCount: 0,
				host: HOST,
				declinesAt: null,
			}),
		).toMatchObject({
			title: `Fetch this URL from ${HOST}?`,
			confirmLabel: "Fetch it",
		});
		expect(
			confirmCopy({
				requestKind: "claude_tool",
				tool: "WebFetch",
				fileCount: 0,
				host: HOST,
				declinesAt: null,
			}).closing[0],
		).toBe("A URL can carry data out. Runs once.");
		expect(
			confirmCopy({
				requestKind: "claude_tool",
				tool: "Read",
				fileCount: 0,
				host: HOST,
				declinesAt: null,
			}),
		).toMatchObject({
			title: "Let Claude read this file?",
			confirmLabel: "Allow reading it",
		});
		expect(
			confirmCopy({
				requestKind: "claude_tool",
				tool: "Read",
				fileCount: 0,
				host: HOST,
				declinesAt: null,
			}).closing[0],
		).toBe("Claude will see what's in it. Runs once.");
		const write = (writeKind: string) =>
			confirmCopy({
				requestKind: "file_change",
				fileCount: 1,
				host: HOST,
				declinesAt: null,
				writeKind,
			});
		expect(write("write")).toMatchObject({
			title: `Replace this file on ${HOST}?`,
			confirmLabel: "Replace it",
		});
		expect(write("add")).toMatchObject({
			title: `Create this file on ${HOST}?`,
			confirmLabel: "Create it",
		});
		expect(write("write_unchecked")).toMatchObject({
			title: `Write this file on ${HOST}?`,
			confirmLabel: "Write it",
		});
	});

	test("a Write is drawn as additions and says what it does to the file", () => {
		expect(kindWord("write")).toBe("Replace");
		expect(signedDiffLines("write", "a\nb")).toEqual(["+a", "+b"]);
		expect(signedDiffLines("write_unchecked", "a")).toEqual(["+a"]);
		expect(writeKindNote("write")).toBe("Replaces this file. What it replaces isn't shown.");
		expect(writeKindNote("add")).toBe("New file.");
		expect(writeKindNote("write_unchecked")).toBe("Writes this file, replacing it if it exists.");
		expect(writeKindNote("update")).toBeNull();
	});
});

describe("decided_elsewhere outlives the five minutes", () => {
	test("it is kept until dismissed, once; other closed rows are not kept", () => {
		const elsewhere = row();
		const stopped = row({ id: "a2", outcome: "session_stopped" });
		const kept = updateKept(new Map(), [elsewhere, stopped], new Set());
		expect([...kept.keys()]).toEqual(["a1"]);
		// The server stops listing it (past its 24 h): the page still shows it until it is dismissed.
		expect([...updateKept(kept, [], new Set()).keys()]).toEqual(["a1"]);
		expect([...updateKept(kept, [], new Set(["a1"])).keys()]).toEqual([]);
	});
});

describe("which session shows the card, and who it's about", () => {
	test("a managed Codex session and a managed fork do; a launched Claude session does not", () => {
		expect(showsApprovalCard({ agentType: "codex_cli", managedSession: {} })).toBe(true);
		expect(
			showsApprovalCard({
				agentType: "claude_code",
				managedSession: {},
				metadata: { forkedFromSessionId: "s" },
			}),
		).toBe(true);
		expect(showsApprovalCard({ agentType: "claude_code", managedSession: {}, metadata: {} })).toBe(
			false,
		);
		expect(
			showsApprovalCard({
				agentType: "claude_code",
				managedSession: null,
				metadata: { forkedFromSessionId: "s" },
			}),
		).toBe(false);
		expect(showsApprovalCard({ agentType: "copilot_cli", managedSession: {} })).toBe(false);
		expect(agentOfSession("claude_code")).toBe("claude");
		expect(agentOfSession("codex_cli")).toBe("codex");
		expect(forkModeOf({ forkPermissionBranch: "restricted" })).toBe("restricted");
		expect(forkModeOf({ forkPermissionBranch: "bypass" })).toBeUndefined();
		expect(forkModeOf(null)).toBeUndefined();
	});
});

describe("a message something else sent the fork", () => {
	test("the owner's read shows the text, or says why it is hidden", () => {
		expect(peerTurnLines({ text: "do the thing", hidden: false }, HOST)).toEqual([
			`Something else on ${HOST} sent this session a message, so AgentPulse stopped it.`,
			"The message: do the thing",
		]);
		expect(peerTurnLines({ text: null, hidden: true }, HOST)?.[1]).toBe(
			"AgentPulse is hiding it because it may hold a secret.",
		);
		expect(peerTurnLines(undefined, HOST)).toBeNull();
	});
});

describe("the session page's own words for a continued Claude session", () => {
	test("the launch line and the origin label never say Codex, take over or headless", () => {
		const lines = [
			launchSummaryLine(true, "completed", "Headless task", "claude_code"),
			overviewOriginField(
				true,
				{ requestedByUserId: "u", metadata: { boundByUserId: "admin" } },
				"claude_code",
			)?.label ?? "",
		];
		expect(lines).toEqual(["Continued · Claude", "Continued by"]);
		for (const line of lines) expect(line).not.toMatch(/Codex|take[nr]? over|taken over|headless/i);
		// Codex and a launched session read as before.
		expect(launchSummaryLine(true, "completed", "Managed Codex")).toBe("Taken over · Codex");
		expect(launchSummaryLine(false, "running", "Headless task", "claude_code")).toBe(
			"running · Headless task",
		);
		expect(
			overviewOriginField(true, { requestedByUserId: "u", metadata: { boundByUserId: "admin" } })
				?.label,
		).toBe("Taken over by");
	});
});

describe("a value this build doesn't know still reads whole", () => {
	test("an unknown outcome, reason and kind fall back to generic copy instead of throwing", () => {
		const unknown = "from_a_newer_server" as never;
		expect(() => outcomeLine(unknown, HOST, null, null, "claude")).not.toThrow();
		expect(outcomeLine(unknown, HOST, null, null, "claude")).toBe(
			"This request has closed. Check the machine before asking again.",
		);
		expect(notApprovableText(unknown, HOST, null, "claude")).toBe(
			"AgentPulse can't show this in a way that's safe to approve. You can only decline it here.",
		);
		expect(kindWord("from_a_newer_server")).toBe("from_a_newer_server");
		expect(notApprovableText("path_not_absolute", HOST, null, "claude")).toBe(
			"This path isn't a full path, so AgentPulse can't tell which file it means. You can only decline it here.",
		);
	});
});

// ── P4-T7: the two things the harness could not drive, split so they can be held without a DOM ──────────

describe("focus when a request closes by itself (the card's effect, as a pure plan)", () => {
	const base = {
		previousPendingIds: ["a1", "a2"],
		pendingIds: ["a2"],
		focusWasInside: true,
		landingRequested: false,
		focusLost: true,
		currentId: "a2",
	};

	test("a request that closed under the person's focus lands on its outcome line, with the next heading as the fallback", () => {
		expect(focusAfterClose(base)).toEqual({
			outcomeId: "codex-approval-outcome-a1",
			fallbackHeadingId: "codex-approval-heading-a2",
		});
		expect(focusAfterClose({ ...base, pendingIds: [], currentId: null })).toEqual({
			outcomeId: "codex-approval-outcome-a1",
			fallbackHeadingId: null,
		});
	});

	test("nothing moves when nothing closed, when focus wasn't in the card, when an answer asked for a landing, or when focus is still somewhere real", () => {
		expect(focusAfterClose({ ...base, pendingIds: ["a1", "a2"] })).toBeNull();
		expect(focusAfterClose({ ...base, focusWasInside: false })).toBeNull();
		expect(focusAfterClose({ ...base, landingRequested: true })).toBeNull();
		expect(focusAfterClose({ ...base, focusLost: false })).toBeNull();
	});

	test("with two closed at once the first closed is the one landed on", () => {
		expect(
			focusAfterClose({ ...base, previousPendingIds: ["a1", "a2", "a3"], pendingIds: ["a3"] })
				?.outcomeId,
		).toBe("codex-approval-outcome-a1");
	});

	test("the card uses the plan and keeps no copy of the rule", () => {
		const card = readFileSync(join(import.meta.dir, "CodexApprovalCard.tsx"), "utf8");
		expect(card).toContain("focusAfterClose({");
		expect(card).not.toMatch(/filter\(\(id\) => !ids\.includes\(id\)\)/);
	});
});

describe("the notice for a message something else sent the session", () => {
	const html = (lines: readonly string[]) =>
		renderToStaticMarkup(createElement(PeerTurnNotice, { lines }));

	test("each line is its own paragraph inside one status region, as text", () => {
		const out = html(
			peerTurnLines({ text: "<img src=x onerror=alert(1)>", hidden: false }, HOST) ?? [],
		);
		expect(out).toContain("<output");
		expect(out.match(/<p /g)).toHaveLength(2);
		expect(out).toContain(
			"Something else on build-host sent this session a message, so AgentPulse stopped it.",
		);
		expect(out).toContain("The message: &lt;img src=x onerror=alert(1)&gt;");
		expect(out).not.toContain("<img");
	});

	test("a message redaction changed is never shown, only that it is hidden", () => {
		const out = html(peerTurnLines({ text: null, hidden: true }, HOST) ?? []);
		expect(out).toContain("AgentPulse is hiding it because it may hold a secret.");
		expect(out).not.toContain("The message:");
	});

	test("the card renders the notice from the approvals list's `peerTurn` and from nothing else", () => {
		const card = readFileSync(join(import.meta.dir, "CodexApprovalCard.tsx"), "utf8");
		expect(card).toMatch(/peerTurnLines\(data\.list\?\.peerTurn, host\)/);
		expect(card).toContain("<PeerTurnNotice lines={peerLines} />");
	});
});
