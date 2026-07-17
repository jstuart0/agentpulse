import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";

const { getDb, getSqlite, initializeDatabase } = await import("../db/client.js");
const { events, managedSessions, sessions, supervisors } = await import("../db/schema/index.js");
const { applyNativeName, renameSession, updateStaleSessions } = await import(
	"./session-tracker.js"
);

beforeAll(() => {
	return initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(supervisors).execute();
	await getDb().delete(sessions).execute();
});

function isoAgo(ms: number): string {
	return new Date(Date.now() - ms).toISOString();
}

async function mkSession(sessionId: string, overrides: Record<string, unknown> = {}) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			lastActivityAt: new Date().toISOString(),
			...overrides,
		})
		.execute();
}

async function getSession(sessionId: string) {
	const rows = await getDb().select().from(sessions).execute();
	return rows.find((r) => r.sessionId === sessionId);
}

const MINUTE = 60 * 1000;

describe("updateStaleSessions lifecycle rules", () => {
	test("working session never goes idle even past the idle cutoff", async () => {
		await mkSession("w1", {
			status: "active",
			isWorking: true,
			lastActivityAt: isoAgo(10 * MINUTE), // past 5-min idle cutoff
		});
		await updateStaleSessions();
		const row = await getSession("w1");
		expect(row?.status).toBe("active");
		expect(row?.isWorking).toBe(true);
	});

	test("non-working active session flips to idle past the idle cutoff", async () => {
		await mkSession("i1", {
			status: "active",
			isWorking: false,
			lastActivityAt: isoAgo(10 * MINUTE),
		});
		await updateStaleSessions();
		const row = await getSession("i1");
		expect(row?.status).toBe("idle");
	});

	test("idle session completes after the end cutoff, not earlier", async () => {
		await mkSession("c1", {
			status: "idle",
			isWorking: false,
			lastActivityAt: isoAgo(40 * MINUTE), // past 30-min end cutoff
		});
		await mkSession("c2", {
			status: "idle",
			isWorking: false,
			lastActivityAt: isoAgo(10 * MINUTE), // still within end cutoff
		});
		const ended = await updateStaleSessions();
		expect(ended).toBe(1);
		expect((await getSession("c1"))?.status).toBe("completed");
		expect((await getSession("c2"))?.status).toBe("idle");
	});

	test("working session past end cutoff stays active — no direct completion", async () => {
		await mkSession("w2", {
			status: "active",
			isWorking: true,
			lastActivityAt: isoAgo(40 * MINUTE),
		});
		await updateStaleSessions();
		const row = await getSession("w2");
		expect(row?.status).toBe("active");
	});

	test("stuck working recovery clears isWorking after 2x end cutoff", async () => {
		await mkSession("stuck", {
			status: "active",
			isWorking: true,
			lastActivityAt: isoAgo(65 * MINUTE), // past 2× 30-min recovery window
		});
		await updateStaleSessions();
		const row = await getSession("stuck");
		// Flag cleared; since this session is also well past the idle and
		// end cutoffs, the same tick cascades it all the way to completed.
		expect(row?.isWorking).toBe(false);
		expect(row?.status).toBe("completed");
	});

	test("stuck working recovery at just-past-2x-end becomes idle before completing", async () => {
		await mkSession("stuck-mild", {
			status: "active",
			isWorking: true,
			// Past 2×30min=60min but NOT yet 60min+30min=90min past for the
			// secondary completed cutoff to trip. Oh wait — endCutoff is 30m
			// absolute from now, not 30m from recovery. Any session with
			// lastActivity > 30m past is eligible. So recovery + idle +
			// completed all fire together. We express this by choosing an
			// activity age that clears recovery but *doesn't* pass end.
			// Since STUCK_WORKING_RECOVERY_MS (60m) > SESSION_END_TIMEOUT_MS
			// (30m), any row that qualifies for recovery also qualifies for
			// completion. So this test documents the invariant: reaching the
			// recovery threshold always cascades to completed.
			lastActivityAt: isoAgo(61 * MINUTE),
		});
		await updateStaleSessions();
		const row = await getSession("stuck-mild");
		expect(row?.isWorking).toBe(false);
		expect(row?.status).toBe("completed");
	});
});

describe("renameSession", () => {
	async function mkManaged(sessionId: string, overrides: Record<string, unknown> = {}) {
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId,
				launchRequestId: `lr-${sessionId}`,
				supervisorId: `sup-${sessionId}`,
				managedState: "managed",
				providerSyncState: "synced",
				providerSyncError: "prior error",
				desiredThreadTitle: "old-title",
				...overrides,
			})
			.execute();
	}

	test("happy path: no managed row → only sessions.displayName updated", async () => {
		await mkSession("solo", { displayName: "old-name" });
		await renameSession("solo", "  new-name  ");
		const row = await getSession("solo");
		expect(row?.displayName).toBe("new-name");
		const managedRows = await getDb().select().from(managedSessions).execute();
		const forSolo = managedRows.find((m) => m.sessionId === "solo");
		expect(forSolo).toBeUndefined();
	});

	test("happy path: managed row exists → both rows updated, sync state reset to pending", async () => {
		await mkSession("paired", { displayName: "old-name" });
		await mkManaged("paired", { providerSyncState: "synced", providerSyncError: "x" });

		const before = await getDb().select().from(managedSessions).execute();
		const beforeRow = before.find((m) => m.sessionId === "paired");
		const beforeUpdatedAt = beforeRow?.updatedAt;

		// Ensure timestamp comparison is meaningful even on fast clocks.
		await new Promise((r) => setTimeout(r, 5));

		await renameSession("paired", "renamed");

		const session = await getSession("paired");
		expect(session?.displayName).toBe("renamed");

		const after = await getDb().select().from(managedSessions).execute();
		const afterRow = after.find((m) => m.sessionId === "paired");
		expect(afterRow?.desiredThreadTitle).toBe("renamed");
		expect(afterRow?.providerSyncState).toBe("pending");
		expect(afterRow?.providerSyncError).toBeNull();
		expect(afterRow?.updatedAt).not.toBe(beforeUpdatedAt);
	});

	// F5 / Decision 6 — `source` sets metadata.renameSource, which
	// applyNativeName later checks to decide whether a native-name pull may
	// overwrite displayName.
	test("no source argument (existing dashboard call sites) → metadata.renameSource defaults to 'user'", async () => {
		await mkSession("default-source", { displayName: "old-name" });
		await renameSession("default-source", "new-name");
		const row = await getSession("default-source");
		expect((row?.metadata as Record<string, unknown> | null)?.renameSource).toBe("user");
	});

	test("source: 'sync' (relay's Codex pull) → metadata.renameSource is NOT 'user'", async () => {
		await mkSession("sync-source", { displayName: "old-name" });
		await renameSession("sync-source", "codex-thread-name", { source: "sync" });
		const row = await getSession("sync-source");
		expect((row?.metadata as Record<string, unknown> | null)?.renameSource).not.toBe("user");
		expect((row?.metadata as Record<string, unknown> | null)?.renameSource).toBe("sync");
	});

	test("renameSession preserves unrelated metadata keys (merge-preserve)", async () => {
		await mkSession("meta-preserve", {
			displayName: "old-name",
			metadata: { permissionWait: { ids: ["tool-1"], anon: 0, prevStatus: "active" } },
		});
		await renameSession("meta-preserve", "renamed");
		const row = await getSession("meta-preserve");
		const metadata = row?.metadata as Record<string, unknown> | null;
		expect(metadata?.renameSource).toBe("user");
		expect(metadata?.permissionWait).toEqual({
			ids: ["tool-1"],
			anon: 0,
			prevStatus: "active",
		});
	});

	// SQLite-only: installs a BEFORE UPDATE trigger to simulate a
	// mid-transaction failure. Camp A simulator — on Postgres the
	// tx rollback guarantee is validated differently (Phase 7 CI).
	describeSqliteOnly("rollback when managed update fails", () => {
		afterEach(() => {
			// Drop the trigger between/after rollback tests so we don't
			// leak state into other suites that share this DB.
			getSqlite().exec("DROP TRIGGER IF EXISTS test_block_rename_managed;");
		});

		test("force second update to throw → sessions.displayName NOT updated (transaction rolled back)", async () => {
			await mkSession("rb-1", { displayName: "original" });
			await mkManaged("rb-1");

			// Trigger that aborts UPDATE on the managed row for our marker
			// session. This makes the sync transaction's second statement
			// throw, which exercises the rollback path.
			getSqlite().exec(`
				CREATE TRIGGER test_block_rename_managed
				BEFORE UPDATE ON managed_sessions
				WHEN NEW.session_id = 'rb-1'
				BEGIN
					SELECT RAISE(ABORT, 'forced rollback');
				END;
			`);

			expect(() => renameSession("rb-1", "should-not-stick")).toThrow();

			const row = await getSession("rb-1");
			expect(row?.displayName).toBe("original");

			const managed = await getDb().select().from(managedSessions).execute();
			const rb1 = managed.find((m) => m.sessionId === "rb-1");
			expect(rb1?.desiredThreadTitle).toBe("old-title");
			expect(rb1?.providerSyncState).toBe("synced");
		});
	});
});

// F5 / Decision 6 — pull-only sync of Claude Code's native session_name into
// displayName. Net-new precedence logic: a manual dashboard rename
// (metadata.renameSource === "user") always wins over an incoming native
// name; otherwise the native name applies.
describe("applyNativeName", () => {
	test("applies when displayName is auto-generated (no prior manual rename)", async () => {
		await mkSession("auto-1", { displayName: "brave-falcon" });
		const result = await applyNativeName("auto-1", "native-name-from-claude");
		expect(result).toEqual({ found: true, applied: true });

		const row = await getSession("auto-1");
		expect(row?.displayName).toBe("native-name-from-claude");
		const metadata = row?.metadata as Record<string, unknown> | null;
		expect(metadata?.nativeName).toBe("native-name-from-claude");
		expect(metadata?.lastAppliedNativeName).toBe("native-name-from-claude");
	});

	test("refuses to overwrite a manual rename (renameSource === 'user'), but still records what was seen", async () => {
		await mkSession("manual-1", {
			displayName: "human-chosen-name",
			metadata: { renameSource: "user" },
		});
		const result = await applyNativeName("manual-1", "native-name-from-claude");
		expect(result).toEqual({ found: true, applied: false });

		const row = await getSession("manual-1");
		// displayName untouched — the core precedence contract.
		expect(row?.displayName).toBe("human-chosen-name");
		const metadata = row?.metadata as Record<string, unknown> | null;
		// What was seen is recorded (for idempotency / later state-diffing)...
		expect(metadata?.nativeName).toBe("native-name-from-claude");
		// ...but nothing was actually applied, so lastAppliedNativeName is untouched.
		expect(metadata?.lastAppliedNativeName).toBeUndefined();
		expect(metadata?.renameSource).toBe("user");
	});

	test("no-op when native name already equals current displayName", async () => {
		await mkSession("noop-1", { displayName: "already-native" });
		const result = await applyNativeName("noop-1", "already-native");
		expect(result).toEqual({ found: true, applied: true });

		const row = await getSession("noop-1");
		expect(row?.displayName).toBe("already-native");

		// Second identical call is a true no-op — no further metadata writes.
		const metadataAfterFirst = { ...(row?.metadata as Record<string, unknown> | null) };
		const result2 = await applyNativeName("noop-1", "already-native");
		expect(result2).toEqual({ found: true, applied: true });
		const row2 = await getSession("noop-1");
		expect(row2?.metadata).toEqual(metadataAfterFirst);
	});

	test("idempotent: calling twice in a row with the identical native name produces identical end state", async () => {
		await mkSession("idem-1", { displayName: "brave-falcon" });

		const first = await applyNativeName("idem-1", "steady-name");
		const rowAfterFirst = await getSession("idem-1");

		const second = await applyNativeName("idem-1", "steady-name");
		const rowAfterSecond = await getSession("idem-1");

		expect(second).toEqual(first);
		expect(rowAfterSecond?.displayName).toBe(rowAfterFirst?.displayName);
		expect(rowAfterSecond?.metadata).toEqual(rowAfterFirst?.metadata);
	});

	test("idempotent when refused: repeat calls under a manual rename produce identical end state", async () => {
		await mkSession("idem-refused", {
			displayName: "human-chosen-name",
			metadata: { renameSource: "user" },
		});

		const first = await applyNativeName("idem-refused", "steady-name");
		const rowAfterFirst = await getSession("idem-refused");

		const second = await applyNativeName("idem-refused", "steady-name");
		const rowAfterSecond = await getSession("idem-refused");

		expect(second).toEqual(first);
		expect(rowAfterSecond?.displayName).toBe(rowAfterFirst?.displayName);
		expect(rowAfterSecond?.metadata).toEqual(rowAfterFirst?.metadata);
	});

	test("unknown sessionId → { found: false }", async () => {
		const result = await applyNativeName("does-not-exist", "some-name");
		expect(result).toEqual({ found: false, applied: false });
	});

	test("applyNativeName preserves unrelated metadata keys (merge-preserve), applied branch", async () => {
		await mkSession("meta-preserve-applied", {
			displayName: "brave-falcon",
			metadata: { permissionWait: { ids: ["tool-1"], anon: 0, prevStatus: "active" } },
		});
		const result = await applyNativeName("meta-preserve-applied", "native-name-from-claude");
		expect(result).toEqual({ found: true, applied: true });

		const row = await getSession("meta-preserve-applied");
		const metadata = row?.metadata as Record<string, unknown> | null;
		expect(metadata?.nativeName).toBe("native-name-from-claude");
		expect(metadata?.lastAppliedNativeName).toBe("native-name-from-claude");
		expect(metadata?.permissionWait).toEqual({
			ids: ["tool-1"],
			anon: 0,
			prevStatus: "active",
		});
	});

	test("applyNativeName preserves unrelated metadata keys (merge-preserve), refused branch", async () => {
		await mkSession("meta-preserve-refused", {
			displayName: "human-chosen-name",
			metadata: {
				renameSource: "user",
				permissionWait: { ids: ["tool-1"], anon: 0, prevStatus: "active" },
			},
		});
		// The refused branch still writes nativeName tracking metadata (a real
		// write path, not a no-op) — this asserts that write doesn't clobber
		// permissionWait alongside it.
		const result = await applyNativeName("meta-preserve-refused", "native-name-from-claude");
		expect(result).toEqual({ found: true, applied: false });

		const row = await getSession("meta-preserve-refused");
		const metadata = row?.metadata as Record<string, unknown> | null;
		expect(row?.displayName).toBe("human-chosen-name");
		expect(metadata?.nativeName).toBe("native-name-from-claude");
		expect(metadata?.lastAppliedNativeName).toBeUndefined();
		expect(metadata?.renameSource).toBe("user");
		expect(metadata?.permissionWait).toEqual({
			ids: ["tool-1"],
			anon: 0,
			prevStatus: "active",
		});
	});

	test("boundary: session with metadata null/{} does not throw and initializes metadata", async () => {
		await mkSession("no-metadata", { displayName: "brave-falcon", metadata: null });
		const result = await applyNativeName("no-metadata", "native-name");
		expect(result).toEqual({ found: true, applied: true });
		const row = await getSession("no-metadata");
		expect(row?.displayName).toBe("native-name");
		expect((row?.metadata as Record<string, unknown> | null)?.nativeName).toBe("native-name");
	});

	test("F5 regression guard: a source:'sync' rename does not block a subsequent native-name pull", async () => {
		await mkSession("sync-then-pull", { displayName: "old-name" });
		await renameSession("sync-then-pull", "codex-thread-name", { source: "sync" });

		const result = await applyNativeName("sync-then-pull", "claude-native-name");
		expect(result).toEqual({ found: true, applied: true });
		const row = await getSession("sync-then-pull");
		expect(row?.displayName).toBe("claude-native-name");
	});
});
