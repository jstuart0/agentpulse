/**
 * TC-4.9c (tightened, P4-12 / P4-F1 / P4-F3): phase 4 codes against structural
 * interfaces (`LedgerForPrompt`, `LedgerForVerify`). This is the one place the
 * real ledger meets them: the ledger is built by `buildLedgerAsync` from rows
 * covering every fact kind and every one-liner category, handed over as is, and
 * what verification does with each id is asserted.
 */
import { describe, expect, test } from "bun:test";
import { IDLE, draftOf } from "./__fixtures__/summary-test-support.js";
import { type EvidenceRow, type Ledger, buildLedgerAsync, userPromptTexts } from "./ledger.js";
import { type LedgerForPrompt, buildSummaryPrompt, sessionForPrompt } from "./prompt.js";
import { collectUserPromptUrls } from "./tripwire.js";
import { type LedgerForVerify, verifySummary } from "./verify.js";

function row(over: Partial<EvidenceRow> & { id: number }): EvidenceRow {
	return {
		createdAt: `2026-10-03 10:00:${String(over.id).padStart(2, "0")}`,
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
const oneLiner = (id: number, category: string, eventType: string): EvidenceRow =>
	row({ id, category, eventType, content: `text ${id}` });
const bash = (id: number, command: string, response: string | null, over = {}): EvidenceRow =>
	row({ id, toolName: "Bash", command, response, ...over });

/** Every kind of fact the ledger produces, one id each (E9 and E10 collapse into one entry). */
const ROWS: EvidenceRow[] = [
	row({ id: 1, eventType: "UserPromptSubmit", category: "prompt", content: "Add retry." }),
	row({ id: 2, eventType: "AssistantMessage", category: "assistant_message", content: "Done." }),
	oneLiner(3, "permission_event", "PermissionRequest"),
	oneLiner(4, "plan_update", "SemanticStatusUpdate"),
	oneLiner(5, "status_update", "SemanticStatusUpdate"),
	oneLiner(6, "ai_report", "AiReport"),
	oneLiner(7, "ai_hitl_response", "AiHitlResponse"),
	row({ id: 8, toolName: "Edit", filePath: "src/a.ts" }),
	row({ id: 9, toolName: "Edit", filePath: "src/b.ts" }),
	row({ id: 10, toolName: "Edit", filePath: "src/b.ts" }),
	row({ id: 11, toolName: "Edit", filePath: "src/c.ts", eventType: "PostToolUseFailure" }),
	bash(12, "bun test", "4 pass\n0 fail"),
	bash(13, "bun test src/x.test.ts", "FAIL src/x.test.ts\n1 fail"),
	bash(14, "tsc --noEmit", "compiled"),
	bash(15, "git status", "clean"),
	row({ id: 16, toolName: "WebFetch" }),
	bash(17, "cat .env", "X=1"),
];

/** What R-E prescribes for an accomplishment that cites each id alone: true means "agent's claim only". */
const EXPECTED_UNVERIFIED: Record<string, boolean> = {
	E1: true, // prompt, CLAIMED
	E2: true, // agent message, CLAIMED
	E3: true, // permission: OBSERVED, but an event is not a result
	E4: true, // plan, CLAIMED
	E5: true, // status, CLAIMED
	E6: true, // ai_report, CLAIMED
	E7: true, // ai_hitl_response: OBSERVED event
	E8: false, // an edit
	E9: false, // a collapsed edit: the first id
	E10: false, // and the last
	E11: true, // a failed edit
	E12: false, // a validation that passed
	E13: true, // a validation that failed
	E14: true, // a validation with an unknown result
	E15: false, // a plain command that finished ok
	E16: true, // a tool entry
	E17: false, // a withheld command that finished ok is a command that ran ok: it backs a claim
};

const SESSION = {
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

function buildFrom(rows: EvidenceRow[], agentType: string): Promise<Ledger> {
	return buildLedgerAsync({
		rows,
		firstPromptRows: [],
		agentType,
		scan: {
			eventsTotal: rows.length,
			eventsRead: rows.length,
			eligibleRead: rows.length,
			droppedByCap: 0,
			reachedFirstEvent: true,
			oldestReadAt: "2026-10-03 10:00:00",
		},
	});
}

const verifyCiting = (ledger: LedgerForVerify, ids: string[]) =>
	verifySummary({
		draft: draftOf({ accomplishments: [{ text: "x", evidence: ids }] }),
		ledger,
		session: IDLE,
		userPromptUrls: new Set(),
		nonce: "n",
	});

describe("adapter conformance", () => {
	test("TC-4.9c a real ledger is accepted as is by prompt and verify, and the prompt shows what verify uses", async () => {
		const ledger = await buildFrom(ROWS, "claude_code");
		const forPrompt: LedgerForPrompt = ledger;
		const forVerify: LedgerForVerify = ledger;
		const built = buildSummaryPrompt(sessionForPrompt(SESSION), forPrompt);
		expect(built.transcriptPrompt).toContain("E8 ");
		expect(forVerify.recorded.paths).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]));
		expect(forVerify.recorded.commands).toEqual(expect.arrayContaining(["bun test", "git status"]));
		expect(forVerify.recorded.commands.join(" ")).not.toContain(".env");
	});

	test("TC-4.9d (1) every id in the real ledger carries a boolean `observed`, and the ids cover all the rows' entries", async () => {
		const ledger = await buildFrom(ROWS, "claude_code");
		expect(ledger.ids.size).toBe(ROWS.length);
		for (const [id, info] of ledger.ids) {
			expect(typeof info.observed, id).toBe("boolean");
		}
	});

	test("TC-4.9e (2) the OBSERVED / CLAIMED word on each id's line equals the fact's `observed`", async () => {
		const ledger = await buildFrom(ROWS, "claude_code");
		for (const [id, info] of ledger.ids) {
			const line = ledger.text
				.split("\n")
				.find((l) => (l.split(" ")[0] as string).split(",").includes(id));
			expect(line, id).toBeDefined();
			const word = (line as string).split(" ")[2];
			expect(word, `${id}: ${line}`).toBe(info.observed ? "OBSERVED" : "CLAIMED");
		}
	});

	test("TC-4.9f (3) citing each id alone in an accomplishment gives the label R-E prescribes", async () => {
		const ledger = await buildFrom(ROWS, "claude_code");
		for (const id of ledger.ids.keys()) {
			const out = verifyCiting(ledger, [id]);
			expect(out.summary.accomplishments[0]?.unverified, id).toBe(EXPECTED_UNVERIFIED[id]);
		}
		expect(Object.keys(EXPECTED_UNVERIFIED).sort()).toEqual([...ledger.ids.keys()].sort());
	});

	test("TC-4.9g (4) a validation cited as passed stays passed for ok and becomes cited_unknown for unknown; its class is returned", async () => {
		const ledger = await buildFrom(ROWS, "claude_code");
		const verify = (ids: string[]) =>
			verifySummary({
				draft: draftOf({
					validation: [{ what: "checks", result: "passed", detail: "d", evidence: ids }],
				}),
				ledger,
				session: IDLE,
				userPromptUrls: new Set(),
				nonce: "n",
			});
		const ok = verify(["E12"]);
		expect(ok.summary.validation[0]?.result).toBe("passed");
		expect(ok.summary.validation[0]?.classes).toEqual(["bun test"]);
		expect(ok.evidence.E12?.validationClass).toBe("bun test");
		const unknown = verify(["E14"]);
		expect(unknown.summary.validation[0]?.result).toBe("unknown");
		expect(unknown.adjustments).toContainEqual({
			code: "validation_adjusted",
			index: 0,
			from: "passed",
			reason: "cited_unknown",
		});
	});

	test("TC-4.9h Codex rows without an exit code: a completed command and a validation with a pass pattern back nothing", async () => {
		const rows = [
			bash(1, "echo hi", "hi"),
			bash(2, "bun test", "4 pass\n0 fail"),
			bash(3, "bun test", JSON.stringify({ output: "4 pass", metadata: { exit_code: 0 } })),
		];
		const ledger = await buildFrom(rows, "codex_cli");
		expect(ledger.ids.get("E1")?.result).toBe("completed");
		expect(ledger.ids.get("E2")?.result).toBe("unknown");
		expect(ledger.ids.get("E3")?.result).toBe("ok");
		expect(verifyCiting(ledger, ["E1"]).summary.accomplishments[0]?.unverified).toBe(true);
		expect(verifyCiting(ledger, ["E2"]).summary.accomplishments[0]?.unverified).toBe(true);
		expect(verifyCiting(ledger, ["E3"]).summary.accomplishments[0]?.unverified).toBe(false);
	});

	test("TC-4.9i userPromptTexts yields the prompts of both row lists once each, oldest first", async () => {
		const first = row({
			id: 1,
			eventType: "UserPromptSubmit",
			category: "prompt",
			content: "see https://docs.example.org/a",
		});
		const later = row({
			id: 5,
			eventType: "UserPromptSubmit",
			category: "prompt",
			content: "and www.typed.test/x",
		});
		const texts = userPromptTexts({
			rows: [later, row({ id: 6, toolName: "Edit", filePath: "a.ts" }), first],
			firstPromptRows: [first],
		});
		expect(texts).toEqual(["see https://docs.example.org/a", "and www.typed.test/x"]);
		expect([...collectUserPromptUrls(texts)].sort()).toEqual([
			"docs.example.org/a",
			"typed.test/x",
		]);
	});
});
