import { beforeAll, describe, expect, test } from "bun:test";
/**
 * Ownership ids (owner_user_id, ingest_key_id) must never reach a prompt, a
 * notification, or an Ask answer. Two layers:
 *
 * 1. Structural: no file under src/server/services/ai, src/server/services/ask,
 *    src/server/services/channels, or the notifier may select a whole
 *    `sessions` row and pass it onward — every `.from(sessions)` read in
 *    those files must use an explicit column list (or the SESSION_COLUMNS_
 *    SANS_OWNERSHIP helper, which is an explicit column list with the two
 *    ownership columns structurally removed). A sample-based output check
 *    (the old version of this file) only ever proves the sites it happens
 *    to call are clean; this proves no NEW bare-row read can land in these
 *    directories at all, caught at the source rather than hoped to be
 *    caught at every future output site.
 *
 * 2. Direct: the three highest-risk surfaces — the watcher's LLM prompt
 *    builder, one Ask handler's resolved-session output, and the alert-rule
 *    notification path — are exercised with a session carrying distinctive,
 *    unmistakable owner/key values, and their actual output text is
 *    asserted to contain neither.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import "../../db/__test_db.js";

const { initializeDatabase, getDb } = await import("../../db/client.js");
const { sessions, projectAlertRules, projectAlertRuleFires } = await import(
	"../../db/schema/index.js"
);
const { buildWatcherContext } = await import("./context.js");
const { resolveCandidateSessions } = await import("../ask/resolver.js");
const { evaluateAlertRules } = await import("./alert-rule-evaluator.js");

const LEAK_OWNER_USER_ID = "owner-id-must-never-leak-9f3e7a21";
const LEAK_INGEST_KEY_ID = "ingest-key-id-must-never-leak-4b8c1d05";

function assertNoLeak(label: string, value: unknown) {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	expect(text, `${label} must not contain the owner_user_id`).not.toContain(LEAK_OWNER_USER_ID);
	expect(text, `${label} must not contain the ingest_key_id`).not.toContain(LEAK_INGEST_KEY_ID);
}

// ─── Structural: no bare whole-row sessions select in these directories ────

const REPO_ROOT = join(import.meta.dir, "../../../../");
const SCAN_ROOTS = [
	"src/server/services/ai",
	"src/server/services/ask",
	"src/server/services/channels",
];
const SCAN_SINGLE_FILES = ["src/server/services/notifier.ts"];

// Matches `.select()` (zero-argument — a whole-row select) immediately
// followed by `.from(sessions)`, allowing only whitespace/newlines between
// them (the shape every real call site in this codebase uses). Deliberately
// does NOT match `.select({...})` (explicit column object) or
// `.select(SOME_COLUMNS_CONSTANT)` (a named explicit column list, e.g.
// SESSION_COLUMNS_SANS_OWNERSHIP) — both are the sanctioned forms.
const BARE_SELECT_SESSIONS = /\.select\(\s*\)\s*\.from\(\s*sessions\s*\)/g;

function walkTsFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			results.push(...walkTsFiles(full));
		} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
			results.push(full);
		}
	}
	return results;
}

// Every occurrence below must be justified on its own line — a count here
// is a conscious exception, not a shrug. Empty today: every known call site
// in these directories was converted to an explicit column list (or
// SESSION_COLUMNS_SANS_OWNERSHIP) as part of closing this gap. A future
// change that adds a bare `.select().from(sessions)` in scope must either
// narrow its own select or add a justified entry here — it cannot silently
// pass.
const ALLOWED_BARE_SELECTS: Record<string, number> = {};

describe("no file under ai/, ask/, channels/, or the notifier selects a whole sessions row", () => {
	test("every .select().from(sessions) in scope is an explicit column list", () => {
		const files: string[] = [];
		for (const root of SCAN_ROOTS) {
			files.push(...walkTsFiles(join(REPO_ROOT, root)));
		}
		for (const single of SCAN_SINGLE_FILES) {
			files.push(join(REPO_ROOT, single));
		}
		// Population sanity check — fails loudly if the scan roots stop
		// resolving to real files (e.g. a future directory rename) instead
		// of silently scanning nothing and passing vacuously.
		expect(files.length).toBeGreaterThanOrEqual(15);

		const found: Record<string, number> = {};
		for (const file of files) {
			const content = readFileSync(file, "utf-8");
			const matches = content.match(BARE_SELECT_SESSIONS) ?? [];
			if (matches.length === 0) continue;
			const relPath = file.slice(REPO_ROOT.length).replace(/\\/g, "/");
			found[relPath] = matches.length;
		}

		expect(found).toEqual(ALLOWED_BARE_SELECTS);
	});

	// Named member: a bare select hidden behind irregular whitespace (e.g.
	// everything on one line) must still be caught — a scan anchored to the
	// exact multi-line indentation style this codebase happens to use
	// wouldn't catch it.
	test("the scan catches a bare select regardless of line layout", () => {
		const oneLine = 'await getDb().select().from(sessions).where(eq(sessions.id, "x"));';
		const exact = "await getDb()\n\t.select()\n\t.from(sessions)\n\t.where(...)";
		expect(oneLine.match(BARE_SELECT_SESSIONS)).not.toBeNull();
		expect(exact.match(BARE_SELECT_SESSIONS)).not.toBeNull();
	});

	// Named member: an explicit column object or a named explicit column
	// list (SESSION_COLUMNS_SANS_OWNERSHIP) must never be flagged — the scan
	// targets the zero-argument form specifically.
	test("an explicit column select is never flagged", () => {
		const columnObject = "await getDb().select({ id: sessions.id }).from(sessions);";
		const namedColumns = "await getDb().select(SESSION_COLUMNS_SANS_OWNERSHIP).from(sessions);";
		expect(columnObject.match(BARE_SELECT_SESSIONS)).toBeNull();
		expect(namedColumns.match(BARE_SELECT_SESSIONS)).toBeNull();
	});
});

// ─── Direct: the three highest-risk surfaces ────────────────────────────────

describe("the three highest-risk surfaces never leak owner_user_id or ingest_key_id", () => {
	beforeAll(async () => {
		await initializeDatabase();

		const now = new Date().toISOString();
		await getDb()
			.insert(sessions)
			.values({
				sessionId: `prompt-leak-fixture-${crypto.randomUUID()}`,
				displayName: "prompt-ownership-leak-fixture",
				agentType: "claude_code",
				status: "active",
				cwd: "/tmp/prompt-ownership-leak-fixture",
				currentTask: "a task mentioning nothing sensitive",
				startedAt: now,
				lastActivityAt: now,
				metadata: {},
				ownerUserId: LEAK_OWNER_USER_ID,
				ingestKeyId: LEAK_INGEST_KEY_ID,
			});
	});

	test("the watcher's LLM prompt (buildWatcherContext) contains neither value", async () => {
		const sessionId = `prompt-leak-direct-${crypto.randomUUID()}`;
		const now = new Date().toISOString();
		await getDb().insert(sessions).values({
			sessionId,
			displayName: "watcher-prompt-leak-fixture",
			agentType: "claude_code",
			status: "active",
			cwd: "/tmp/watcher-prompt-leak-fixture",
			gitBranch: "main",
			model: "test-model",
			claudeMdContent: "nothing sensitive here",
			startedAt: now,
			lastActivityAt: now,
			metadata: {},
			ownerUserId: LEAK_OWNER_USER_ID,
			ingestKeyId: LEAK_INGEST_KEY_ID,
		});
		const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
		if (!row) throw new Error("fixture row missing");

		const ctx = buildWatcherContext({
			// Deliberately the full row (not SESSION_COLUMNS_SANS_OWNERSHIP) —
			// the row object handed in here still carries both ownership
			// columns in-process. This is the stronger claim: buildWatcherContext
			// itself must never read them into the built prompt text, even
			// when they're present on the object it's given — not just "the
			// caller happens to narrow its select first."
			session: row as unknown as import("../../../shared/types.js").Session,
			events: [],
			triggerType: "idle",
		});

		assertNoLeak("buildWatcherContext systemPrompt", ctx.systemPrompt);
		assertNoLeak("buildWatcherContext transcriptPrompt", ctx.transcriptPrompt);
	});

	test("an Ask handler's resolved-session output (resolveCandidateSessions) contains neither value", async () => {
		const resolved = await resolveCandidateSessions({
			message: "prompt-ownership-leak-fixture",
			fallbackToActive: true,
		});
		assertNoLeak("resolveCandidateSessions", resolved);
	});

	test("the alert-rule notification path (evaluateAlertRules/dispatchAlertRuleNotification) touches neither value", async () => {
		const sessionId = `prompt-leak-alert-${crypto.randomUUID()}`;
		const projectId = `prompt-leak-project-${crypto.randomUUID()}`;
		const now = new Date().toISOString();
		await getDb().insert(sessions).values({
			sessionId,
			displayName: "alert-rule-leak-fixture",
			agentType: "claude_code",
			status: "completed",
			projectId,
			startedAt: now,
			lastActivityAt: now,
			endedAt: now,
			metadata: {},
			ownerUserId: LEAK_OWNER_USER_ID,
			ingestKeyId: LEAK_INGEST_KEY_ID,
		});
		await getDb().insert(projectAlertRules).values({
			projectId,
			ruleType: "status_completed",
			channelId: null, // no real Telegram setup — dispatch still runs its
			// own console.log line (the thing under test) before returning early
			isActive: true,
			createdAt: now,
			updatedAt: now,
		});

		const logged: string[] = [];
		const originalLog = console.log;
		console.log = (...args: unknown[]) => {
			logged.push(args.map((a) => String(a)).join(" "));
		};
		try {
			await evaluateAlertRules(sessionId, "completed");
		} finally {
			console.log = originalLog;
		}

		// Sanity: the rule actually fired (not silently skipped), so the
		// notification path really ran — a vacuous pass would be worse than
		// no test at all.
		const fires = await getDb()
			.select()
			.from(projectAlertRuleFires)
			.where(eq(projectAlertRuleFires.sessionId, sessionId));
		expect(fires.length).toBe(1);

		assertNoLeak("evaluateAlertRules console output", logged.join("\n"));
	});
});
