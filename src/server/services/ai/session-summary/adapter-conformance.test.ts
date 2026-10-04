/**
 * TC-4.9c: phase 4 codes against structural interfaces (`LedgerForPrompt`,
 * `LedgerForVerify`). This is the one place the real ledger types meet them.
 *
 * TIGHTENS AFTER THE MERGE with the phase 3 fix pass: once every ledger fact
 * carries `observed: boolean` (P3-18), the `observed` assertions below become
 * strict, and `LedgerFactForVerify.observed` in verify.ts can lose its `?`.
 */
import { describe, expect, test } from "bun:test";
import { IDLE, draftOf } from "./__fixtures__/summary-test-support.js";
import { type EvidenceRow, type Ledger, buildLedger } from "./ledger.js";
import { type LedgerForPrompt, buildSummaryPrompt } from "./prompt.js";
import { type LedgerForVerify, verifySummary } from "./verify.js";

function row(over: Partial<EvidenceRow> & { id: number }): EvidenceRow {
	return {
		createdAt: "2026-10-03 10:00:00",
		eventType: "PostToolUse",
		category: "tool_event",
		toolName: null,
		content: null,
		filePath: null,
		command: null,
		description: null,
		response: null,
		responseTail: null,
		...over,
	};
}

describe("adapter conformance", () => {
	test("TC-4.9c a real buildLedger result satisfies both structural interfaces and flows through prompt and verify", () => {
		const ledger: Ledger = buildLedger({
			rows: [
				row({ id: 1, eventType: "UserPromptSubmit", category: "prompt", content: "Add retry." }),
				row({ id: 2, toolName: "Edit", filePath: "src/a.ts" }),
				row({ id: 3, toolName: "Bash", command: "bun test", response: "4 pass 0 fail" }),
			],
			firstPromptRows: [],
			scan: {
				eventsTotal: 3,
				eventsRead: 3,
				eligibleRead: 3,
				droppedByCap: 0,
				reachedFirstEvent: true,
				oldestReadAt: "2026-10-03 10:00:00",
			},
		});
		const forPrompt: LedgerForPrompt = ledger;
		const forVerify: LedgerForVerify = ledger;
		const session = {
			displayName: "s",
			agentType: "claude_code",
			model: "m",
			cwd: "/w",
			gitBranch: "main",
			currentTask: null,
			planSummary: null,
			notes: null,
			startedAt: "2026-10-03 09:59:00",
			endedAt: null,
			status: "active",
			isWorking: false,
			isArchived: false,
			semanticStatus: null,
			lastAgentTurnCompletedAt: null,
			lastUserAcknowledgedAt: null,
			metadata: null,
		};
		const built = buildSummaryPrompt(session, forPrompt);
		expect(built.transcriptPrompt).toContain("E2 ");
		const out = verifySummary({
			draft: draftOf({ accomplishments: [{ text: "Edited a.ts", evidence: ["E2", "E1"] }] }),
			ledger: forVerify,
			session: IDLE,
			userPromptUrls: new Set(),
			nonce: built.nonce,
		});
		expect(out.summary.accomplishments[0]?.evidence).toEqual(["E2", "E1"]);
		expect(out.summary.accomplishments[0]?.unverified).toBe(false);
		const claimedOnly = verifySummary({
			draft: draftOf({ accomplishments: [{ text: "x", evidence: ["E1"] }] }),
			ledger: forVerify,
			session: IDLE,
			userPromptUrls: new Set(),
			nonce: built.nonce,
		});
		expect(claimedOnly.summary.accomplishments[0]?.unverified).toBe(true);
	});
});
