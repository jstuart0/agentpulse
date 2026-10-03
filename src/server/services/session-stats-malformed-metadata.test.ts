/**
 * One session with unreadable metadata must not fail every poll. On SQLite the
 * metadata column is plain text, so a row whose text is not valid JSON would
 * make the JSON extraction throw for the whole statement. On Postgres a JSON
 * document carrying a NUL or a lone surrogate escape is storable but cannot be
 * read back out by key. Such a row is read as "no permission wait" and
 * classified by its other fields, under the cap and past it, while a valid
 * permission wait beside it still counts.
 *
 * On Postgres the guard is a text test on the escape (any \u0000 or surrogate
 * range escape in a document that mentions the key), so a valid document that
 * merely holds that text as data is read as "no wait" too: unreadable beats
 * wrong.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import "./ai/__test_db.js";
import { describePostgresOnly, describeSqliteOnly } from "../test-utils/backend.js";

const { getDb, getSqlite, initializeDatabase } = await import("../db/client.js");
const { executeRows } = await import("../db/sql-helpers.js");
const { sessions } = await import("../db/schema/index.js");
const { getSessions, getStats, _setOperationalCandidateCapForTest } = await import(
	"./session-tracker.js"
);

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
});
afterEach(() => _setOperationalCandidateCapForTest(null));

const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

async function seedNormal(n: number) {
	await getDb()
		.insert(sessions)
		.values(
			Array.from({ length: n }, (_, i) => ({
				sessionId: `ok-${i}`,
				displayName: `ok-${i}`,
				agentType: "claude_code",
				status: "active",
				metadata: {},
				lastActivityAt: iso(i * 10),
			})) as never,
		)
		.execute();
}

const VALID_WAIT = '{"permissionWait":{"ids":["t1"],"anon":0}}';

async function seedWithText(
	sessionId: string,
	text: string,
	overwrite: (text: string) => Promise<void>,
) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			metadata: {},
			lastActivityAt: iso(1),
		} as never)
		.execute();
	await overwrite(text);
}

/** Runs the same expectations on whichever dialect is active, with `unreadable` rows seeded. */
function unreadableRowsDescribe(
	unreadable: string[],
	store: (id: string, text: string) => Promise<void>,
) {
	const seedAll = async (n: number) => {
		await seedNormal(n);
		await seedWithText("valid-wait", VALID_WAIT, (text) => store("valid-wait", text));
		for (const [i, text] of unreadable.entries()) {
			await seedWithText(`unreadable-${i}`, text, (t) => store(`unreadable-${i}`, t));
		}
	};

	test("the poll still answers: unreadable rows by their other fields, a valid wait still waiting", async () => {
		await seedAll(3);
		const stats = await getStats();
		expect(stats.truncated).toBe(false);
		expect(stats.operational.waiting).toBe(1);
		expect(stats.operational.idle).toBe(3 + unreadable.length);
	});

	test("past the cap too (the attention tier reads the same key)", async () => {
		await seedAll(8);
		_setOperationalCandidateCapForTest(5);
		const stats = await getStats();
		expect(stats.truncated).toBe(true);
		expect(stats.operational.waiting).toBe(1);
	});

	// Not an unreadable row's own page: fetching its full row decodes the whole
	// metadata, which only the row itself can break.
	test("the operational list answers for the rows it does show", async () => {
		await seedAll(2);
		const waiting = await getSessions({ operational: "waiting", limit: 50 });
		expect(waiting.total).toBe(1);
		expect(waiting.sessions.map((r) => r.sessionId)).toEqual(["valid-wait"]);
	});
}

describeSqliteOnly("a row whose metadata is not valid JSON (SQLite)", () => {
	unreadableRowsDescribe(
		[
			'{"permissionWait":',
			'{"permissionWait": {"ids": ["a"]',
			"not json at all permissionWait",
			"",
		],
		async (id, text) => {
			getSqlite().prepare("UPDATE sessions SET metadata = ? WHERE session_id = ?").run(text, id);
		},
	);
});

describePostgresOnly("a document with a NUL or lone surrogate escape (Postgres)", () => {
	unreadableRowsDescribe(
		[
			'{"permissionWait":{"ids":["a\\u0000b"],"anon":0}}',
			'{"permissionWait":{"ids":["a\\ud800b"],"anon":0}}',
			'{"permissionWait":"x\\u0000"}',
		],
		async (id, text) => {
			await executeRows(
				getDb(),
				sql`UPDATE sessions SET metadata = ${text}::json WHERE session_id = ${id}`,
			);
		},
	);
});
