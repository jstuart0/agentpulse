import { describe, expect, test } from "bun:test";
import type { AgentType } from "../../shared/types.js";
import { parseTranscriptDelta } from "./transcript-sync.js";

const codexAgentMessageLine = JSON.stringify({
	type: "event_msg",
	timestamp: "2026-09-28T00:00:00Z",
	payload: { type: "agent_message", message: "hello from codex", phase: "final" },
});

describe("parseTranscriptDelta — D5 Pattern A' TRANSCRIPT_PARSERS map", () => {
	test("codex_cli parses a real Codex-shaped line into an event", () => {
		const events = parseTranscriptDelta("codex_cli", [codexAgentMessageLine]);
		expect(events.length).toBe(1);
	});

	test("an agent type with no registered parser gets zero events, even on Codex-shaped content — proving the Codex parser is not invoked as a fallback", () => {
		// biome-ignore lint/suspicious/noExplicitAny: simulating a future observed-only agent type not yet in AgentType
		const events = parseTranscriptDelta("copilot_cli" as any as AgentType, [codexAgentMessageLine]);
		expect(events).toEqual([]);
	});
});

// AGEN-146: a batch whose insert throws is skipped, counted and logged redacted; the cursor moves on.
describe("transcript sync insert failure", () => {
	test("the cursor advances, the failure is counted and its log carries no secret", async () => {
		await import("./ai/__test_db.js");
		const { mkdtempSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { eq } = await import("drizzle-orm");
		const { spyOn } = await import("bun:test");
		const { getDb, initializeDatabase } = await import("../db/client.js");
		const { sessions } = await import("../db/schema/index.js");
		const processor = await import("./event-processor.js");
		const { transcriptSyncWorker } = await import("./transcript-sync.js");
		const { getIngestRedactionCounters } = await import("./ingest-redaction.js");
		await initializeDatabase();
		const dir = mkdtempSync(join(tmpdir(), "ts-fail-"));
		const file = join(dir, "t.jsonl");
		const line = `${codexAgentMessageLine}\n`;
		writeFileSync(file, line);
		const id = `ts-fail-${Date.now()}`;
		await getDb()
			.insert(sessions)
			.values({
				sessionId: id,
				displayName: id,
				agentType: "codex_cli",
				status: "active",
				transcriptPath: file,
				lastActivityAt: new Date().toISOString(),
				metadata: {},
			})
			.execute();
		const KEY = `sk-ant-${"api03-"}${"A".repeat(40)}`;
		const insert = spyOn(processor, "insertNormalizedEvents").mockImplementation(async () => {
			throw new Error(`insert failed for ${KEY}`);
		});
		const logged: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
		const before = getIngestRedactionCounters().transcriptSyncInsertFailed;
		try {
			await transcriptSyncWorker.tick();
		} finally {
			console.error = original;
			insert.mockRestore();
		}
		expect(getIngestRedactionCounters().transcriptSyncInsertFailed).toBeGreaterThan(before);
		const text = logged.join("\n");
		expect(text).toContain("transcript_sync_insert_failed");
		expect(text).not.toContain("AAAAAAAA");
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, id));
		expect(
			(row?.metadata as { transcriptCursor?: { offset: number } }).transcriptCursor?.offset,
		).toBe(line.length);
	});
});
