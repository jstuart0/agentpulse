/**
 * The candidate scan behind the stats poll reads only what the classifier
 * needs, and the permission-wait part of the metadata through a JSON-path
 * extraction instead of decoding every row's whole metadata. The classifier
 * stays the single judge: over a few thousand randomised rows the scan must
 * classify every row exactly as classifying the full row would.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import "./ai/__test_db.js";
import { ACTIVE_OPERATIONAL_STATUSES, getOperationalStatus } from "../../shared/session-state.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { executeRows } = await import("../db/sql-helpers.js");
const { sql } = await import("drizzle-orm");
const { sessions } = await import("../db/schema/index.js");
const { BASE, insertAll, prng, randomRow } = await import("../test-utils/random-sessions.js");
const { getSessions, getStats, getStatsByOwner, _setOperationalCandidateCapForTest } = await import(
	"./session-tracker.js"
);

const HEAVY_MS = 60_000;

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
});
// Deleting thousands of sessions runs the full-text triggers per row (seconds),
// so the heavy test cleans up after itself under its own generous limit instead
// of leaving it to the next test's setup.
afterEach(async () => {
	_setOperationalCandidateCapForTest(null);
	await getDb().delete(sessions).execute();
}, HEAVY_MS);

describe("the candidate scan classifies exactly as the full row does", () => {
	test(
		"3000 randomised rows: every active state's id set matches the classifier over the full rows",
		async () => {
			const rand = prng(20261002);
			await insertAll(Array.from({ length: 3000 }, (_, i) => randomRow(rand, i)));

			const fullRows = await getDb().select().from(sessions);
			const expected = new Map<string, Set<string>>(
				ACTIVE_OPERATIONAL_STATUSES.map((status) => [status, new Set<string>()]),
			);
			for (const row of fullRows) {
				const status = getOperationalStatus(row);
				if (status !== "completed") expected.get(status)?.add(row.sessionId);
			}
			// The seed must exercise every state, or the comparison proves little.
			for (const status of ACTIVE_OPERATIONAL_STATUSES) {
				expect(expected.get(status)?.size ?? 0).toBeGreaterThan(50);
			}

			const stats = await getStats();
			expect(stats.truncated).toBe(false);
			for (const status of ACTIVE_OPERATIONAL_STATUSES) {
				const listed = await getSessions({ operational: status, limit: 100000 });
				expect(new Set(listed.sessions.map((s) => s.sessionId))).toEqual(
					expected.get(status) as Set<string>,
				);
				expect(stats.operational[status]).toBe(expected.get(status)?.size ?? -1);
			}

			const byOwner = await getStatsByOwner();
			const summed = { waiting: 0, working: 0, idle: 0, error: 0 };
			for (const group of byOwner.groups) {
				summed.waiting += group.waiting;
				summed.working += group.working;
				summed.idle += group.idle;
				summed.error += group.error;
			}
			expect(summed).toEqual(stats.operational);
		},
		HEAVY_MS,
	);
});

describe("the candidate scan does not decode every row's metadata", () => {
	test("only rows carrying a permission wait are parsed", async () => {
		const rows = Array.from({ length: 300 }, (_, i) => ({
			sessionId: `meta-${i}`,
			displayName: `meta-${i}`,
			agentType: "claude_code",
			status: "active",
			metadata: i < 3 ? { permissionWait: { ids: ["t"], anon: 0 } } : { note: "x".repeat(200) },
			lastActivityAt: new Date(BASE - i * 1000).toISOString(),
		}));
		await insertAll(rows);

		const parse = spyOn(JSON, "parse");
		try {
			const stats = await getStats();
			expect(stats.operational.waiting).toBe(3);
			expect(stats.operational.idle).toBe(297);
			expect(parse.mock.calls.length).toBeLessThanOrEqual(20);
		} finally {
			parse.mockRestore();
		}
	});
});

/**
 * The same comparison over hand-written metadata documents: every shape the
 * classifier could meet (decoys of the key's name inside values and JSON text,
 * top-level non-objects, odd `anon` and `ids` values, 2 MB documents, non-ASCII
 * text). The narrowed scan must classify each exactly as classifying the
 * fully decoded row would, except for the documents PINNED below: ones the app
 * never writes, where the two readings legitimately differ.
 */
describe("the candidate scan on hand-written metadata documents", () => {
	const KEY = '"permissionWait"';
	const BIG = "x".repeat(2_000_000);
	const DOCUMENTS: Array<[string, string]> = [
		["a wait", `{${KEY}:{"ids":["a"],"anon":0}}`],
		["an empty wait", `{${KEY}:{"ids":[],"anon":0}}`],
		["anon only", `{${KEY}:{"anon":2}}`],
		["anon fractional", `{${KEY}:{"anon":0.5}}`],
		["anon negative", `{${KEY}:{"anon":-1}}`],
		["anon a string", `{${KEY}:{"anon":"3"}}`],
		["ids a string", `{${KEY}:{"ids":"abc"}}`],
		["ids an object", `{${KEY}:{"ids":{"0":"a"}}}`],
		["anon overflowing", `{${KEY}:{"anon":1e999}}`],
		["anon exponent", `{${KEY}:{"anon":1E2}}`],
		["anon beyond safe integers", `{${KEY}:{"anon":12345678901234567890123}}`],
		["anon denormal", `{${KEY}:{"anon":1e-320}}`],
		["anon negative zero", `{${KEY}:{"anon":-0}}`],
		["wait null", `{${KEY}:null}`],
		["wait a string", `{${KEY}:"yes"}`],
		["wait a number", `{${KEY}:3}`],
		["wait true", `{${KEY}:true}`],
		["wait an array", `{${KEY}:["a"]}`],
		["key name in a native name", `{"nativeName":"fix permissionWait bug","renameSource":"user"}`],
		[
			"JSON text holding the key, in a string",
			`{"note":"{\\"permissionWait\\":{\\"ids\\":[\\"x\\"]}}"}`,
		],
		["decoy and the real key", `{"nativeName":"permissionWait","permissionWait":{"ids":["a"]}}`],
		["key nested one level down", `{"a":{"permissionWait":{"ids":["a"]}}}`],
		["top-level array", `[{"permissionWait":{"ids":["a"]}}]`],
		["top-level string", `"permissionWait"`],
		["top-level number", "5"],
		["top-level null", "null"],
		["empty object", "{}"],
		["pretty printed", `{\n  "permissionWait" : {\n    "ids" : [ "a" ]\n  }\n}`],
		["key in another case", `{"PermissionWait":{"ids":["a"]}}`],
		["key all lower case", `{"permissionwait":{"ids":["a"]}}`],
		["non-ASCII ids", `{${KEY}:{"ids":["日本語","😀","é"],"anon":0}}`],
		["non-ASCII elsewhere", `{"nativeName":"日本語 permissionWait 😀"}`],
		["an escaped surrogate pair", `{${KEY}:{"ids":["\\ud83d\\ude00"]}}`],
		["a NUL elsewhere", `{"x":"a\\u0000b","permissionWait":{"ids":["a"]}}`],
		["2 MB before the key", `{"blob":"${BIG}",${KEY}:{"ids":["a"]}}`],
		["2 MB after the key", `{${KEY}:{"ids":["a"]},"blob":"${BIG}"}`],
		["2 MB and no key", `{"blob":"${BIG}"}`],
		["2 MB holding the key's name only", `{"blob":"${BIG} permissionWait"}`],
		["a deeply nested value", `{${KEY}:{"ids":["a"],"x":${"[".repeat(150)}${"]".repeat(150)}}}`],
		["leading whitespace", `  {${KEY}:{"ids":["a"]}}`],
		["ids with LIKE metacharacters", `{${KEY}:{"ids":["100%_done"]}}`],
	];

	// Documents the app never writes, where the narrowed read differs from a full
	// decode, pinned so a change in the narrowed answer is a decision:
	//   - the key spelled with an escape: the full decode sees the key, the text
	//     test for its name does not, so the row reads as no wait (both dialects);
	//   - duplicate keys: JSON.parse keeps the last; Postgres's extraction does
	//     too, SQLite's keeps the first;
	//   - a NUL or surrogate-range escape in a Postgres document: unreadable by
	//     key, read as no wait (SQLite reads them like the full decode).
	type Bucket = "waiting" | "idle";
	const PINNED: Array<[string, string, { sqlite: Bucket; postgres: Bucket }]> = [
		[
			"the key spelled with an escape",
			`{"permission\\u0057ait":{"ids":["a"]}}`,
			{ sqlite: "idle", postgres: "idle" },
		],
		[
			"duplicate keys, the real one last",
			`{${KEY}:{"ids":[]},${KEY}:{"ids":["a"]}}`,
			{ sqlite: "idle", postgres: "waiting" },
		],
		[
			"duplicate keys, the real one first",
			`{${KEY}:{"ids":["a"]},${KEY}:{"ids":[]}}`,
			{ sqlite: "waiting", postgres: "idle" },
		],
	];
	const UNREADABLE_ON_POSTGRES = new Set(["an escaped surrogate pair", "a NUL elsewhere"]);

	async function setMetadata(sessionId: string, text: string) {
		const store =
			config.dialect === "postgres"
				? sql`UPDATE sessions SET metadata = ${text}::json WHERE session_id = ${sessionId}`
				: sql`UPDATE sessions SET metadata = ${text} WHERE session_id = ${sessionId}`;
		await executeRows(getDb(), store);
	}

	/** The bucket a lone session lands in through the poll (its candidate scan). */
	async function polledBucket(sessionId: string, working: boolean, text: string) {
		await getDb().delete(sessions).execute();
		await getDb()
			.insert(sessions)
			.values({
				sessionId,
				displayName: sessionId,
				agentType: "claude_code",
				status: "active",
				isWorking: working,
				metadata: {},
				lastActivityAt: new Date().toISOString(),
			} as never)
			.execute();
		await setMetadata(sessionId, text);
		const stats = await getStats();
		const bucket = ACTIVE_OPERATIONAL_STATUSES.filter((status) => stats.operational[status] === 1);
		expect(bucket).toHaveLength(1);
		return bucket[0];
	}

	function fullDecodeBucket(text: string, working: boolean) {
		return getOperationalStatus({
			isArchived: false,
			status: "active",
			isWorking: working,
			endedAt: null,
			semanticStatus: null,
			lastAgentTurnCompletedAt: null,
			lastUserAcknowledgedAt: null,
			metadata: JSON.parse(text),
		} as never);
	}

	test(
		"every document is classified as the full decode classifies it",
		async () => {
			const differences: string[] = [];
			for (const working of [false, true]) {
				for (const [name, text] of DOCUMENTS) {
					if (config.dialect === "postgres" && UNREADABLE_ON_POSTGRES.has(name)) continue;
					const got = await polledBucket("doc-1", working, text);
					const expected = fullDecodeBucket(text, working);
					if (got !== expected)
						differences.push(`${name} (working=${working}): ${expected} vs ${got}`);
				}
			}
			expect(differences).toEqual([]);
		},
		HEAVY_MS,
	);

	test("the pinned documents read the way the narrowed scan reads them", async () => {
		const unreadable = DOCUMENTS.filter(([name]) => UNREADABLE_ON_POSTGRES.has(name));
		const pinned: Array<[string, string, Bucket]> = [
			...PINNED.map(
				([name, text, buckets]) =>
					[name, text, buckets[config.dialect]] as [string, string, Bucket],
			),
			...(config.dialect === "postgres"
				? unreadable.map(([name, text]) => [name, text, "idle"] as [string, string, Bucket])
				: []),
		];
		expect(pinned.length).toBeGreaterThanOrEqual(PINNED.length);
		for (const [name, text, expected] of pinned) {
			expect({ name, bucket: await polledBucket("doc-pinned", false, text) }).toEqual({
				name,
				bucket: expected,
			});
		}
	});
});
