/**
 * Codex approvals, phase 3: migration 0020 on both dialects, legacy-init
 * parity (see legacy-init-parity.test.ts), and the append-only audit.
 *
 * The audit triggers are proved against the process-wide database, which is
 * SQLite by default and Postgres under AGENTPULSE_TEST_BACKEND=postgres, through
 * Drizzle's own statement builders, so the same assertions run on both. A
 * second SQLite case runs the Drizzle migration files on a scratch file, the
 * Drizzle-born install the legacy init must match.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import "../services/ai/__test_db.js";
import { describePostgresOnly, itSqliteOnly } from "../test-utils/backend.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("./client.js");
const { executeRows } = await import("./sql-helpers.js");
const { codexApprovalAudit, codexApprovals, sessions } = await import("./schema/index.js");
const ddl = await import("./codex-approvals-ddl.js");

const MIGRATIONS_ROOT = resolve(import.meta.dir, "../../../drizzle");
const TMP_DIR = mkdtempSync(join(tmpdir(), "ap-codex-approvals-"));
const VIOLATION = ddl.CODEX_APPROVAL_AUDIT_VIOLATION;

beforeAll(async () => {
	await initializeDatabase();
});
afterAll(() => {
	if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
});

const SESSION = "codex-approvals-migration-session";

function approvalRow(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		sessionId: SESSION,
		runtimeEpoch: "epoch-1",
		rpcId: JSON.stringify(id),
		requestKind: "command",
		threadId: "thread",
		turnId: "turn",
		itemId: "item",
		presentationHash: "h".repeat(64),
		presentationRevision: 1,
		approvable: true,
		status: "pending",
		createdAt: "2026-11-03T10:00:00.000Z",
		expiresAt: "2026-11-03T10:20:00.000Z",
		updatedAt: "2026-11-03T10:00:00.000Z",
		...overrides,
	};
}

function auditRow(id: string, approvalId: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		approvalId,
		sessionId: SESSION,
		hostName: "host-a",
		actorUserId: "user-1",
		actorKeyId: null,
		actorLabel: "user",
		requestKind: "command",
		revision: 1,
		presentationHash: "h".repeat(64),
		decision: "accept",
		createdAt: "2026-11-03T10:01:00.000Z",
		...overrides,
	};
}

async function wipe(): Promise<void> {
	// The audit is append-only by design, so a test cleans it the way nothing else may:
	// by dropping the guard for the duration (SQLite triggers) or truncating after
	// disabling it (Postgres).
	const db = getDb();
	if (config.dialect === "postgres") {
		await executeRows(db, sql`ALTER TABLE codex_approval_audit DISABLE TRIGGER USER`);
		await executeRows(db, sql`DELETE FROM codex_approval_audit WHERE session_id = ${SESSION}`);
		await executeRows(db, sql`ALTER TABLE codex_approval_audit ENABLE TRIGGER USER`);
	} else {
		await executeRows(db, sql`DROP TRIGGER IF EXISTS trg_codex_approval_audit_delete`);
		await executeRows(db, sql`DELETE FROM codex_approval_audit WHERE session_id = ${SESSION}`);
		await executeRows(
			db,
			sql.raw(
				ddl.CODEX_APPROVAL_TRIGGERS_SQLITE.find((s) =>
					s.includes("trg_codex_approval_audit_delete"),
				) ?? "",
			),
		);
	}
	await db.delete(sessions).where(eq(sessions.sessionId, SESSION));
}

beforeEach(async () => {
	await wipe();
	await getDb().insert(sessions).values({ sessionId: SESSION, agentType: "codex_cli" });
});

async function messageOf(run: () => unknown): Promise<string> {
	try {
		await run();
	} catch (err) {
		const parts: string[] = [];
		let current: unknown = err;
		for (let i = 0; i < 4 && current; i++) {
			parts.push(current instanceof Error ? current.message : String(current));
			current = (current as { cause?: unknown }).cause;
		}
		return parts.join(" | ");
	}
	return "";
}

async function expectRefused(run: () => unknown): Promise<void> {
	expect(await messageOf(run)).toContain(VIOLATION);
}

async function auditOf(id: string) {
	const [row] = await getDb()
		.select()
		.from(codexApprovalAudit)
		.where(eq(codexApprovalAudit.id, id));
	return row;
}

describe("migration 0020 files", () => {
	test("both dialects create both tables and hold the shared DDL verbatim", () => {
		const sqlite = readFileSync(join(MIGRATIONS_ROOT, "sqlite/0020_codex_approvals.sql"), "utf8");
		const pg = readFileSync(join(MIGRATIONS_ROOT, "postgres/0020_codex_approvals.sql"), "utf8");
		expect(sqlite).toMatch(/CREATE TABLE `codex_approvals`/);
		expect(sqlite).toMatch(/CREATE TABLE `codex_approval_audit`/);
		expect(pg).toMatch(/CREATE TABLE "codex_approvals"/);
		expect(pg).toMatch(/CREATE TABLE "codex_approval_audit"/);
		expect(ddl.CODEX_APPROVAL_TRIGGERS_SQLITE.length).toBe(3);
		for (const statement of ddl.CODEX_APPROVAL_TRIGGERS_SQLITE) expect(sqlite).toContain(statement);
		expect(ddl.CODEX_APPROVAL_STATEMENTS_POSTGRES.length).toBeGreaterThanOrEqual(9);
		for (const statement of ddl.CODEX_APPROVAL_STATEMENTS_POSTGRES) expect(pg).toContain(statement);
	});

	test("the approvals table cascades from sessions and the audit table has no foreign key", () => {
		const sqlite = readFileSync(join(MIGRATIONS_ROOT, "sqlite/0020_codex_approvals.sql"), "utf8");
		const pg = readFileSync(join(MIGRATIONS_ROOT, "postgres/0020_codex_approvals.sql"), "utf8");
		expect(sqlite).toMatch(
			/REFERENCES `sessions`\(`session_id`\) ON UPDATE no action ON DELETE cascade/,
		);
		expect(pg).toMatch(/codex_approvals_session_id_sessions_session_id_fk[^;]*ON DELETE cascade/);
		const auditCreate = sqlite.slice(
			sqlite.indexOf("CREATE TABLE `codex_approval_audit`"),
			sqlite.indexOf("--> statement-breakpoint"),
		);
		expect(auditCreate).not.toMatch(/FOREIGN KEY|REFERENCES/);
	});

	for (const dialect of ["sqlite", "postgres"] as const) {
		test(`${dialect}: the journal entry is newest and its file exists`, () => {
			const journal = JSON.parse(
				readFileSync(join(MIGRATIONS_ROOT, dialect, "meta/_journal.json"), "utf8"),
			) as { entries: Array<{ idx: number; when: number; tag: string }> };
			const entry = journal.entries.find((e) => e.tag === "0020_codex_approvals");
			expect(entry?.idx).toBe(20);
			const previous = journal.entries.find((e) => e.tag === "0019_supervisor_outbox_state");
			expect(previous).toBeDefined();
			const entryWhen = entry?.when ?? Number.NEGATIVE_INFINITY;
			expect(entryWhen).toBeGreaterThan(previous?.when ?? Number.POSITIVE_INFINITY);
			// Later migrations may follow it, but none may be older.
			const later = journal.entries.filter((e) => e.idx > 20);
			for (const e of later) expect(e.when).toBeGreaterThan(entryWhen);
			expect(existsSync(join(MIGRATIONS_ROOT, dialect, "0020_codex_approvals.sql"))).toBe(true);
			expect(existsSync(join(MIGRATIONS_ROOT, dialect, "meta/0020_snapshot.json"))).toBe(true);
		});
	}
});

describe("migration 0021 (AGEN-117): the control-history index, one name on both paths", () => {
	const FILE = "0021_control_actions_session_index.sql";
	for (const dialect of ["sqlite", "postgres"] as const) {
		test(`${dialect}: the journal entry is newest, its file creates the legacy init's index and is safe to repeat`, () => {
			const journal = JSON.parse(
				readFileSync(join(MIGRATIONS_ROOT, dialect, "meta/_journal.json"), "utf8"),
			) as { entries: Array<{ idx: number; when: number; tag: string }> };
			const entry = journal.entries.find((e) => e.tag === FILE.replace(".sql", ""));
			expect(entry?.idx).toBe(21);
			const entryWhen = entry?.when ?? Number.NEGATIVE_INFINITY;
			expect(Math.max(...journal.entries.map((e) => e.when))).toBe(entryWhen);
			const sql = readFileSync(join(MIGRATIONS_ROOT, dialect, FILE), "utf8");
			expect(sql).toMatch(
				/CREATE INDEX IF NOT EXISTS [`"]idx_control_actions_session[`"] ON [`"]control_actions[`"]/,
			);
			expect(sql.match(/CREATE/g)).toHaveLength(1);
			expect(existsSync(join(MIGRATIONS_ROOT, dialect, "meta/0021_snapshot.json"))).toBe(true);
			// The name is the legacy init's, so a database either path built ends with one index.
			const client = readFileSync(join(import.meta.dir, "client.ts"), "utf8");
			expect(client).toContain(
				"CREATE INDEX IF NOT EXISTS idx_control_actions_session ON control_actions(session_id)",
			);
		});
	}
});

describe("codex_approval_audit is append-only (D19)", () => {
	test("an update may move pending to a final outcome once, with completed_at", async () => {
		const db = getDb();
		await db.insert(codexApprovals).values(approvalRow("a1"));
		await db.insert(codexApprovalAudit).values(auditRow("u1", "a1"));
		await db
			.update(codexApprovalAudit)
			.set({ outcome: "applied", completedAt: "2026-11-03T10:02:00.000Z" })
			.where(eq(codexApprovalAudit.id, "u1"));
		const row = await auditOf("u1");
		expect(row.outcome).toBe("applied");
		expect(row.completedAt).toBe("2026-11-03T10:02:00.000Z");
	});

	test("a final outcome never changes, and pending never stays pending through an update", async () => {
		const db = getDb();
		await db.insert(codexApprovals).values(approvalRow("a2"));
		await db.insert(codexApprovalAudit).values(auditRow("u2", "a2"));
		await expectRefused(() =>
			db
				.update(codexApprovalAudit)
				.set({ completedAt: "2026-11-03T10:02:00.000Z" })
				.where(eq(codexApprovalAudit.id, "u2")),
		);
		await expectRefused(() =>
			db
				.update(codexApprovalAudit)
				.set({ outcome: "pending" })
				.where(eq(codexApprovalAudit.id, "u2")),
		);
		await expectRefused(() =>
			db
				.update(codexApprovalAudit)
				.set({ outcome: "applied" })
				.where(eq(codexApprovalAudit.id, "u2")),
		);
		await db
			.update(codexApprovalAudit)
			.set({ outcome: "outcome_unknown", completedAt: "2026-11-03T10:02:00.000Z" })
			.where(eq(codexApprovalAudit.id, "u2"));
		for (const outcome of ["applied", "expired", "pending"]) {
			await expectRefused(() =>
				db
					.update(codexApprovalAudit)
					.set({ outcome, completedAt: "2026-11-03T10:03:00.000Z" })
					.where(eq(codexApprovalAudit.id, "u2")),
			);
		}
		expect((await auditOf("u2")).outcome).toBe("outcome_unknown");
	});

	test("every identity column is immutable, with or without a legal outcome change", async () => {
		const db = getDb();
		await db.insert(codexApprovals).values(approvalRow("a3"));
		await db.insert(codexApprovalAudit).values(auditRow("u3", "a3"));
		const changes: Array<Record<string, unknown>> = [
			{ approvalId: "other" },
			{ sessionId: "other" },
			{ hostName: "host-b" },
			{ actorUserId: "user-2" },
			{ actorKeyId: "key-1" },
			{ actorLabel: "api_key" },
			{ requestKind: "file_change" },
			{ revision: 2 },
			{ presentationHash: "x".repeat(64) },
			{ decision: "decline" },
			{ createdAt: "2026-11-03T11:00:00.000Z" },
			{ id: "u3-renamed" },
		];
		for (const change of changes) {
			await expectRefused(() =>
				db.update(codexApprovalAudit).set(change).where(eq(codexApprovalAudit.id, "u3")),
			);
			await expectRefused(() =>
				db
					.update(codexApprovalAudit)
					.set({ ...change, outcome: "applied", completedAt: "2026-11-03T10:02:00.000Z" })
					.where(eq(codexApprovalAudit.id, "u3")),
			);
		}
		const row = await auditOf("u3");
		expect(row.outcome).toBe("pending");
		expect(row.decision).toBe("accept");
	});

	test("a row can't be deleted, one at a time or all together", async () => {
		const db = getDb();
		await db.insert(codexApprovals).values(approvalRow("a4"));
		await db.insert(codexApprovalAudit).values(auditRow("u4", "a4"));
		await expectRefused(() => db.delete(codexApprovalAudit).where(eq(codexApprovalAudit.id, "u4")));
		await expectRefused(() => db.delete(codexApprovalAudit));
		expect(await auditOf("u4")).toBeDefined();
	});

	describePostgresOnly("on Postgres", () => {
		test("TRUNCATE is refused too", async () => {
			await expectRefused(() => executeRows(getDb(), sql`TRUNCATE codex_approval_audit`));
		});
	});
});

describe("deleting an approval finalizes its pending audit row (D19)", () => {
	test("a pending accept that was never issued becomes session_deleted", async () => {
		const db = getDb();
		await db
			.insert(codexApprovals)
			.values(approvalRow("d1", { status: "answered", decision: "accept" }));
		await db.insert(codexApprovalAudit).values(auditRow("du1", "d1"));
		await db.delete(sessions).where(eq(sessions.sessionId, SESSION));
		const row = await auditOf("du1");
		expect(row.outcome).toBe(ddl.SESSION_DELETED_OUTCOME);
		expect(row.completedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
		const remaining = await db.select().from(codexApprovals).where(eq(codexApprovals.id, "d1"));
		expect(remaining).toEqual([]);
	});

	test("an accept already issued becomes session_deleted_after_issue", async () => {
		const db = getDb();
		await db.insert(codexApprovals).values(
			approvalRow("d2", {
				status: "answered",
				decision: "accept",
				firstDeliveredAt: "2026-11-03T10:01:30.000Z",
			}),
		);
		await db.insert(codexApprovalAudit).values(auditRow("du2", "d2"));
		await db.delete(sessions).where(eq(sessions.sessionId, SESSION));
		expect((await auditOf("du2")).outcome).toBe(ddl.SESSION_DELETED_AFTER_ISSUE_OUTCOME);
	});

	test("an audit row that already has its final outcome is left exactly as it was", async () => {
		const db = getDb();
		await db.insert(codexApprovals).values(
			approvalRow("d3", {
				status: "closed",
				closedReason: "applied",
				decision: "accept",
				firstDeliveredAt: "2026-11-03T10:01:30.000Z",
			}),
		);
		await db.insert(codexApprovalAudit).values(auditRow("du3", "d3"));
		await db
			.update(codexApprovalAudit)
			.set({ outcome: "applied", completedAt: "2026-11-03T10:02:00.000Z" })
			.where(eq(codexApprovalAudit.id, "du3"));
		await db.delete(sessions).where(eq(sessions.sessionId, SESSION));
		const row = await auditOf("du3");
		expect(row.outcome).toBe("applied");
		expect(row.completedAt).toBe("2026-11-03T10:02:00.000Z");
	});

	test("an approval with no audit row deletes cleanly, and only its own audit row is touched", async () => {
		const db = getDb();
		await db
			.insert(codexApprovals)
			.values([approvalRow("d4"), approvalRow("d5", { status: "answered" })]);
		await db.insert(codexApprovalAudit).values(auditRow("du5", "d5"));
		await db.delete(sessions).where(eq(sessions.sessionId, SESSION));
		expect((await auditOf("du5")).outcome).toBe(ddl.SESSION_DELETED_OUTCOME);
		expect(await db.select().from(codexApprovals)).toEqual([]);
	});
});

describe("a fresh Drizzle-born SQLite install", () => {
	itSqliteOnly("has the tables, the indexes and refusing triggers", async () => {
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		const { drizzle } = await import("drizzle-orm/bun-sqlite");
		const db = new Database(join(TMP_DIR, `${crypto.randomUUID()}.db`));
		db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
		migrate(drizzle(db), { migrationsFolder: join(MIGRATIONS_ROOT, "sqlite") });
		try {
			const triggers = (
				db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{
					name: string;
				}>
			).map((t) => t.name);
			for (const name of [
				"trg_codex_approval_audit_update",
				"trg_codex_approval_audit_delete",
				"trg_codex_approvals_finalize_audit",
			]) {
				expect(triggers).toContain(name);
			}
			db.exec(
				"INSERT INTO sessions (id, session_id, agent_type) VALUES ('s', 'born-session', 'codex_cli')",
			);
			db.exec(
				`INSERT INTO codex_approval_audit (id, approval_id, session_id, actor_label, request_kind, revision, presentation_hash, decision, created_at) VALUES ('x', 'ap', 'born-session', 'user', 'command', 1, 'h', 'accept', 'now')`,
			);
			expect(() => db.exec("DELETE FROM codex_approval_audit")).toThrow(VIOLATION);
			expect(() => db.exec("UPDATE codex_approval_audit SET decision = 'decline'")).toThrow(
				VIOLATION,
			);
			const indexes = (
				db.prepare("PRAGMA index_list('codex_approvals')").all() as Array<{ name: string }>
			).map((i) => i.name);
			expect(indexes).toContain("uq_codex_approvals_session_epoch_rpc");
			expect(indexes).toContain("idx_codex_approvals_status_expires");
		} finally {
			db.close();
		}
	});
});
