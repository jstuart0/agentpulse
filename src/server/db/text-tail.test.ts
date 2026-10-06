/**
 * AGEN-69 phase 2a, TC-2.12: `textTail` on a real database, both dialects.
 * It counts characters (code points), never bytes, and never splits an
 * astral pair.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import "../services/ai/__test_db.js";

const { getDb, initializeDatabase } = await import("./client.js");
const { executeRows, textTail } = await import("./sql-helpers.js");

await initializeDatabase();

async function tailOf(value: string | null, n: number): Promise<string | null> {
	const literal = value === null ? sql`CAST(NULL AS TEXT)` : sql`CAST(${value} AS TEXT)`;
	const rows = await executeRows<{ t: string | null }>(
		getDb(),
		sql`SELECT ${textTail(literal, n)} AS t`,
	);
	return rows[0].t;
}

describe("TC-2.12 textTail on a real database", () => {
	test("TC-2.12 returns the last n characters", async () => {
		expect(await tailOf("abcdefghij", 3)).toBe("hij");
		expect(await tailOf("abcdefghij", 10)).toBe("abcdefghij");
	});

	test("TC-2.12 an n larger than the value returns it whole", async () => {
		expect(await tailOf("abc", 100)).toBe("abc");
		expect(await tailOf("", 5)).toBe("");
	});

	test("TC-2.12 NULL gives NULL", async () => {
		expect(await tailOf(null, 5)).toBeNull();
	});

	test("TC-2.12 counts characters, not bytes", async () => {
		expect(await tailOf("日本語テキスト", 3)).toBe("キスト");
		expect(await tailOf("café", 2)).toBe("fé");
	});

	test("TC-2.12 an astral character at the boundary leaves no half pair", async () => {
		const face = "🙂"; // two UTF-16 units, four UTF-8 bytes
		expect(await tailOf(`ab${face}cd`, 3)).toBe(`${face}cd`);
		expect(await tailOf(`ab${face}cd`, 2)).toBe("cd");
		expect(await tailOf(`${face}${face}${face}`, 2)).toBe(`${face}${face}`);
		const tail = (await tailOf(`xx${face}yy`, 4)) as string;
		expect(tail).toBe(`x${face}yy`);
		expect(tail).not.toMatch(
			/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
		);
	});
});
