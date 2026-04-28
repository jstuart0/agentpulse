import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";

// Defer DB-touching imports so the __test_db side-effect can configure
// SQLITE_PATH before the client module binds to it.
const { db, initializeDatabase, sqlite } = await import("../../db/client.js");
const { projects, sessionTemplates, sessions } = await import("../../db/schema.js");
const { loadEager } = await import("./cache.js");
const { createProject, deleteProject, resolveAllSessionsForProject, updateProject } = await import(
	"./projects-service.js"
);

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(sessionTemplates).execute();
	await db.delete(sessions).execute();
	await db.delete(projects).execute();
	await loadEager();
});

// drizzle-bun-sqlite db.transaction() runs SYNC. If any of the project
// service flows ever flip back to an `async (tx) => ...` callback, the
// BEGIN/COMMIT brackets only the sync portion of the body and the COMMIT
// fires before any awaited statement settles — meaning a thrown error
// after an await boundary cannot roll back. These tests force a write to
// fail mid-transaction (via a BEFORE-trigger that RAISEs ABORT) and
// assert that earlier writes inside the same tx were also rolled back.
//
// Each test installs its trigger after seeding and drops it in `finally`,
// so failures don't pollute other tests sharing this DB file.

describe("projects-service rollback semantics", () => {
	test("createProject: resolveAllSessionsForProject rolls back when a session update fails", async () => {
		const now = new Date().toISOString();
		// Seed TWO sessions both matching the new project's cwd. The
		// resolver will iterate them and try to stamp each. With a sync
		// transaction, an ABORT on the second update rolls back the
		// first. With the legacy async-callback bug, BEGIN/COMMIT bracket
		// nothing (the async cb returns a Promise immediately) so the
		// first update autocommits and the second throw leaves the first
		// stamped — i.e. partial state.
		const sessionIdA = `sessA-${crypto.randomUUID().slice(0, 8)}`;
		const sessionIdB = `sessB-${crypto.randomUUID().slice(0, 8)}`;
		await db.insert(sessions).values({
			sessionId: sessionIdA,
			agentType: "claude_code",
			cwd: "/tmp/ap-rollback-create",
			startedAt: now,
			lastActivityAt: now,
		});
		await db.insert(sessions).values({
			sessionId: sessionIdB,
			agentType: "claude_code",
			cwd: "/tmp/ap-rollback-create/sub",
			startedAt: now,
			lastActivityAt: now,
		});

		// Block the update for sessionIdB only; sessionIdA's update is
		// allowed to "commit" (autocommit, if buggy).
		sqlite.exec(`
			CREATE TRIGGER tmp_block_session_project_update
			BEFORE UPDATE OF project_id ON sessions
			WHEN NEW.project_id IS NOT NULL AND OLD.session_id = '${sessionIdB}'
			BEGIN
				SELECT RAISE(ABORT, 'rollback-test');
			END;
		`);

		try {
			await expect(
				createProject({ name: "rollback-create", cwd: "/tmp/ap-rollback-create" }),
			).rejects.toThrow();
		} finally {
			sqlite.exec("DROP TRIGGER IF EXISTS tmp_block_session_project_update");
		}

		// Both sessions must still have NULL project_id — the first
		// update must have rolled back when the second aborted. If the
		// flow regressed to async, sessionIdA would have its project_id
		// set (autocommit) and this assertion would fail.
		const rows = await db.select().from(sessions).execute();
		const a = rows.find((r) => r.sessionId === sessionIdA);
		const b = rows.find((r) => r.sessionId === sessionIdB);
		expect(a?.projectId).toBeNull();
		expect(b?.projectId).toBeNull();
	});

	test("updateProject: cwd-change re-resolve rolls back atomically when an update fails", async () => {
		const now = new Date().toISOString();
		const created = await createProject({ name: "rb-update", cwd: "/tmp/ap-rb-update-old" });
		const projectId = created.project?.id;
		if (!projectId) throw new Error("project id missing");

		// One session was stamped under the OLD cwd — the cwd-change
		// resolver will null-it-out (UPDATE #1 in the tx). One session
		// matches the NEW cwd and is currently NULL — the resolver will
		// stamp it (UPDATE #2 in the tx). With async-bug, UPDATE #1
		// autocommits and only UPDATE #2 rolls back; with the sync fix
		// both roll back.
		const stampedSessionId = `sess-${crypto.randomUUID().slice(0, 8)}`;
		const newCwdSessionId = `sess-${crypto.randomUUID().slice(0, 8)}`;
		await db.insert(sessions).values({
			sessionId: stampedSessionId,
			agentType: "claude_code",
			cwd: "/tmp/ap-rb-update-old",
			projectId,
			startedAt: now,
			lastActivityAt: now,
		});
		await db.insert(sessions).values({
			sessionId: newCwdSessionId,
			agentType: "claude_code",
			cwd: "/tmp/ap-rb-update-new",
			startedAt: now,
			lastActivityAt: now,
		});

		// Block ONLY the stamp-to-non-NULL update (the second one).
		// The null-out update on `stampedSessionId` is allowed through.
		// On a buggy async path that update would autocommit, leaving
		// stampedSessionId.project_id = NULL after the abort.
		sqlite.exec(`
			CREATE TRIGGER tmp_block_session_restamp
			BEFORE UPDATE OF project_id ON sessions
			WHEN NEW.project_id IS NOT NULL
			BEGIN
				SELECT RAISE(ABORT, 'rollback-test');
			END;
		`);

		try {
			await expect(updateProject(projectId, { cwd: "/tmp/ap-rb-update-new" })).rejects.toThrow();
		} finally {
			sqlite.exec("DROP TRIGGER IF EXISTS tmp_block_session_restamp");
		}

		// After rollback: BOTH sessions must retain their original
		// project_id values. The stamped one must still point at the
		// project (its project_id=NULL update would have been the first
		// statement in the tx — must have rolled back). The new-cwd one
		// must still be NULL (its UPDATE never committed).
		const stamped = await db
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, stampedSessionId))
			.execute();
		expect(stamped[0]?.projectId).toBe(projectId);

		const newCwd = await db
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, newCwdSessionId))
			.execute();
		expect(newCwd[0]?.projectId).toBeNull();
	});

	test("deleteProject rolls back atomically when the project delete fails", async () => {
		const now = new Date().toISOString();
		const created = await createProject({ name: "rb-delete", cwd: "/tmp/ap-rb-delete" });
		const projectId = created.project?.id;
		if (!projectId) throw new Error("project id missing");

		// Seed a template and a session pointing at this project. The
		// delete flow will null-out template.project_id, null-out
		// session.project_id, then DELETE the project — three statements
		// in one tx. Block the project DELETE so the earlier null-outs
		// must roll back.
		const stampedSessionId = `sess-${crypto.randomUUID().slice(0, 8)}`;
		await db.insert(sessions).values({
			sessionId: stampedSessionId,
			agentType: "claude_code",
			cwd: "/tmp/ap-rb-delete",
			projectId,
			startedAt: now,
			lastActivityAt: now,
		});
		await db.insert(sessionTemplates).values({
			name: "rb-tmpl",
			agentType: "claude_code",
			cwd: "/tmp/ap-rb-delete",
			projectId,
		});

		sqlite.exec(`
			CREATE TRIGGER tmp_block_project_delete_2
			BEFORE DELETE ON projects
			BEGIN
				SELECT RAISE(ABORT, 'rollback-test');
			END;
		`);

		try {
			await expect(deleteProject(projectId)).rejects.toThrow();
		} finally {
			sqlite.exec("DROP TRIGGER IF EXISTS tmp_block_project_delete_2");
		}

		// Project must still exist; session/template project_id must
		// NOT have been nulled — the whole tx rolled back atomically.
		const remainingProjects = await db.select().from(projects).execute();
		expect(remainingProjects.length).toBe(1);
		expect(remainingProjects[0]?.id).toBe(projectId);

		const session = await db
			.select()
			.from(sessions)
			.where(eq(sessions.sessionId, stampedSessionId))
			.execute();
		expect(session[0]?.projectId).toBe(projectId);

		const tmpl = await db.select().from(sessionTemplates).execute();
		expect(tmpl[0]?.projectId).toBe(projectId);

		// Sanity: avoid an unused-import warning on resolveAllSessionsForProject.
		expect(typeof resolveAllSessionsForProject).toBe("function");
	});
});

// Drizzle's `eq` is needed for the per-session lookups above. Importing
// at the top would force ESM order issues with __test_db; we re-import
// here lazily.
const { eq } = await import("drizzle-orm");
