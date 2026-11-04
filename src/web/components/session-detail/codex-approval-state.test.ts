/**
 * A state is said once (AGEN-87). While Codex is asking, the operational badge says the session
 * needs someone; nothing beside it says it again, and the intelligence badge's "blocked" doesn't
 * sit next to it. These read the sources, since there is no DOM harness.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CODEX_APPROVAL_NOTE_CAN_ANSWER,
	codexApprovalNoteOtherOwner,
} from "../../lib/codex-approval-wait.js";

const WEB = join(import.meta.dir, "..", "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf-8");
const STATE_WORDS = /\b(working|waiting|idle|error)\b/i;

describe("the card says no state of its own", () => {
	const card = read("components/session-detail/CodexApprovalCard.tsx");

	test("no status badge, intelligence badge or state chip in the card", () => {
		expect(card).not.toMatch(
			/StatusBadge|IntelligenceBadge|OperationalStatus|getOperationalStatus/,
		);
		expect(card).not.toMatch(/isWorking|semanticStatus/);
	});
});

describe("the dashboard card", () => {
	const dashboardCard = read("components/SessionCard.tsx");

	test("the intelligence badge is hidden while Codex is asking", () => {
		expect(dashboardCard).toMatch(
			/intelligenceEnabled && intelligence && !hasPendingCodexApproval\(session\)/,
		);
	});

	test("the note is text, with no state chip beside it", () => {
		const note = dashboardCard.slice(
			dashboardCard.indexOf("ackAction.permissionWaitNote || askingOwner"),
		);
		const paragraph = note.slice(0, note.indexOf("</p>"));
		expect(paragraph).not.toMatch(/StatusBadge|IntelligenceBadge/);
		expect(CODEX_APPROVAL_NOTE_CAN_ANSWER).not.toMatch(STATE_WORDS);
		expect(codexApprovalNoteOtherOwner("O")).not.toMatch(STATE_WORDS);
		expect(CODEX_APPROVAL_NOTE_CAN_ANSWER).not.toMatch(/terminal/i);
	});

	test("the note names the owner as a field, with a fallback", () => {
		expect(codexApprovalNoteOtherOwner("O")).toBe("Codex is asking O for approval.");
		expect(codexApprovalNoteOtherOwner("O", true)).toBe(
			"Codex is asking O for approval. Open the session to answer.",
		);
		expect(codexApprovalNoteOtherOwner(null)).toBe(
			"Codex is asking the session's owner for approval.",
		);
		expect(codexApprovalNoteOtherOwner("  ")).toBe(
			"Codex is asking the session's owner for approval.",
		);
	});

	test("the owner is read from the chip, which team mode alone draws", () => {
		expect(dashboardCard).toMatch(/ownerChip\?\.kind === "user" \? ownerChip\.text : null/);
	});
});

describe("the session page", () => {
	const page = read("pages/SessionDetailPage.tsx");

	test("the header shows no note while Codex is asking: the approval card says it", () => {
		expect(page).toMatch(
			/hasPendingCodexApproval\(session\) \? null : ackDerivation\.permissionWaitNote/,
		);
	});

	test("the polite region is the page's own and the card is handed it", () => {
		expect(page).toMatch(/<CodexApprovalCard session=\{session\} announce=\{setLiveAnnouncement\}/);
	});
});

// Built from pieces so this file does not itself look like a mode comparison to the guard that scans src/web.
const MODE_COMPARISON = new RegExp(
	['=== "te' + 'am"', '!== "te' + 'am"', '=== "so' + 'lo"', "\\.mo" + "de\\b"].join("|"),
);

describe("the team-only display is decided by ownership-ui", () => {
	test("the card never compares the instance mode", () => {
		const card = read("components/session-detail/CodexApprovalCard.tsx");
		const hook = read("hooks/useCodexApprovals.ts");
		for (const text of [card, hook]) {
			expect(text).not.toMatch(MODE_COMPARISON);
		}
		expect(card).toMatch(/useOwnershipUi\(\)/);
		expect(card).toMatch(/ownership\.ownerGatesSessionActions/);
	});
});
