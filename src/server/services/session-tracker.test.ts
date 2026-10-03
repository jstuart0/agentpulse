import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Session } from "../../shared/types.js";
import "./ai/__test_db.js";
import { describeSqliteOnly } from "../test-utils/backend.js";

const { getDb, getSqlite, initializeDatabase } = await import("../db/client.js");
const { events, managedSessions, sessions, supervisors } = await import("../db/schema/index.js");
const { applyNativeName, getSessions, getStats, renameSession, updateStaleSessions } = await import(
	"./session-tracker.js"
);
const { AGENT_TYPES } = await import("../../shared/constants.js");
const { sessionBus } = await import("./notifier.js");

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

// True when `s` contains a high surrogate not followed by its matching low
// surrogate, or a low surrogate not preceded by its matching high surrogate.
// Deliberately NOT `/[\uD800-\uDFFF]/.test(s)` — that flags every surrogate
// code unit including a validly-paired astral character (any emoji), so it
// can't distinguish "truncation preserved a code point" from "truncation
// split a surrogate pair".
function hasLoneSurrogate(s: string): boolean {
	return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(s);
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

describe("updateStaleSessions broadcasts what it changed", () => {
	let seen: Session[] = [];
	const listener = (session: Session) => {
		seen.push(session);
	};

	beforeEach(() => {
		seen = [];
		sessionBus.on("session_updated", listener);
	});
	afterEach(() => {
		sessionBus.off("session_updated", listener);
	});

	test("one update per changed session, carrying the new state", async () => {
		await mkSession("stuck-b", {
			status: "active",
			isWorking: true,
			lastActivityAt: isoAgo(65 * MINUTE),
		});
		await mkSession("idle-b", {
			status: "active",
			isWorking: false,
			lastActivityAt: isoAgo(10 * MINUTE),
		});
		await mkSession("done-b", {
			status: "idle",
			isWorking: false,
			lastActivityAt: isoAgo(40 * MINUTE),
		});
		await mkSession("fresh-b", { status: "active", isWorking: false });
		await updateStaleSessions();
		const byId = new Map(seen.map((s) => [s.sessionId, s]));
		expect(seen.length).toBe(3);
		expect(byId.get("stuck-b")?.status).toBe("completed");
		expect(byId.get("stuck-b")?.isWorking).toBe(false);
		expect(byId.get("idle-b")?.status).toBe("idle");
		expect(byId.get("done-b")?.status).toBe("completed");
		expect(byId.has("fresh-b")).toBe(false);
		for (const s of seen) expect("ingestKeyId" in s).toBe(false);
	});

	test("nothing changed, nothing broadcast", async () => {
		await mkSession("quiet-b", { status: "active", isWorking: false });
		await mkSession("working-b", {
			status: "active",
			isWorking: true,
			lastActivityAt: isoAgo(10 * MINUTE),
		});
		await updateStaleSessions();
		expect(seen.length).toBe(0);
	});

	test("a large sweep batches its reads", async () => {
		const total = 1200;
		const rows = Array.from({ length: total }, (_, i) => ({
			sessionId: `bulk-${i}`,
			displayName: `bulk-${i}`,
			agentType: "claude_code" as const,
			status: "active" as const,
			isWorking: false,
			lastActivityAt: isoAgo(10 * MINUTE),
		}));
		for (let i = 0; i < rows.length; i += 200) {
			await getDb()
				.insert(sessions)
				.values(rows.slice(i, i + 200))
				.execute();
		}
		await updateStaleSessions();
		expect(seen.length).toBe(total);
		expect(new Set(seen.map((s) => s.sessionId)).size).toBe(total);
	});
});

describe("getSessions — managed field (Phase 3 mid-build, dexter M2/ian Part B/tessa H-4)", () => {
	async function mkManagedRow(sessionId: string, overrides: Record<string, unknown> = {}) {
		await getDb()
			.insert(managedSessions)
			.values({
				sessionId,
				launchRequestId: `lr-${sessionId}`,
				supervisorId: `sup-${sessionId}`,
				managedState: "managed",
				providerSyncState: "synced",
				providerSyncError: null,
				desiredThreadTitle: null,
				...overrides,
			})
			.execute();
	}

	test("a session with no managed_sessions row → managed:false, flat row shape (no nested join)", async () => {
		await mkSession("solo-list");
		const { sessions: rows } = await getSessions();
		const row = rows.find((r) => r.sessionId === "solo-list");
		expect(row?.managed).toBe(false);
		// Flat shape proof: sessionId/displayName/etc. sit directly on the
		// row, not nested under a `sessions` key the way a naive Drizzle
		// leftJoin would produce (ian Part B's named footgun).
		expect(row?.displayName).toBe("solo-list");
		expect((row as Record<string, unknown>).sessions).toBeUndefined();
	});

	test("a session WITH a managed_sessions row → managed:true (the true branch, previously unexercised)", async () => {
		await mkSession("paired-list");
		await mkManagedRow("paired-list");
		const { sessions: rows } = await getSessions();
		const row = rows.find((r) => r.sessionId === "paired-list");
		expect(row?.managed).toBe(true);
	});

	test("a mixed page returns both true and false correctly, one batched query regardless of page size", async () => {
		await mkSession("mix-a");
		await mkSession("mix-b");
		await mkSession("mix-c");
		await mkManagedRow("mix-b");
		const { sessions: rows } = await getSessions();
		const byId = new Map(rows.map((r) => [r.sessionId, r.managed]));
		expect(byId.get("mix-a")).toBe(false);
		expect(byId.get("mix-b")).toBe(true);
		expect(byId.get("mix-c")).toBe(false);
	});

	test("zero sessions on the page → no crash, empty array (in-array on an empty id list is skipped, not a malformed query)", async () => {
		const { sessions: rows, total } = await getSessions({ status: "failed" });
		expect(rows).toEqual([]);
		expect(total).toBe(0);
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

	// F5 / Decision 6, contract revised per codex r2 Medium #1 — only an
	// EXPLICIT source: "user" stamps metadata.renameSource. Omitted source
	// (and any other explicit value, e.g. "sync") is legacy-neutral: the
	// rename happens but the flag is left untouched. This protects against
	// a mixed-version old relay (which sends {name} with no source field)
	// being misclassified as a manual rename that would permanently block
	// future native-name pulls for that session.
	test("no source argument (legacy-neutral) → metadata.renameSource is NOT stamped", async () => {
		await mkSession("default-source", { displayName: "old-name" });
		await renameSession("default-source", "new-name");
		const row = await getSession("default-source");
		expect(row?.displayName).toBe("new-name");
		expect((row?.metadata as Record<string, unknown> | null)?.renameSource).toBeUndefined();
	});

	test("explicit source: 'user' (dashboard, Ask rename) → metadata.renameSource stamped 'user'", async () => {
		await mkSession("user-source", { displayName: "old-name" });
		await renameSession("user-source", "new-name", { source: "user" });
		const row = await getSession("user-source");
		expect((row?.metadata as Record<string, unknown> | null)?.renameSource).toBe("user");
	});

	test("source: 'sync' (relay's Codex pull) → legacy-neutral, metadata.renameSource is NOT stamped", async () => {
		await mkSession("sync-source", { displayName: "old-name" });
		await renameSession("sync-source", "codex-thread-name", { source: "sync" });
		const row = await getSession("sync-source");
		expect(row?.displayName).toBe("codex-thread-name");
		expect((row?.metadata as Record<string, unknown> | null)?.renameSource).toBeUndefined();
	});

	test("renameSession(source: 'user') preserves unrelated metadata keys (merge-preserve)", async () => {
		await mkSession("meta-preserve", {
			displayName: "old-name",
			metadata: { permissionWait: { ids: ["tool-1"], anon: 0, prevStatus: "active" } },
		});
		await renameSession("meta-preserve", "renamed", { source: "user" });
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
		expect(result).toEqual({ found: true, applied: false, reason: "manual_rename" });

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
		expect(result).toEqual({ found: true, applied: false, reason: "manual_rename" });

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

	// ─── Phase 2: sanitization + reason discriminant (F11, D14) ──────────────

	test("a control-only (C0) name sanitizes to empty -> reason:empty_after_sanitize, distinct from applied:false", async () => {
		await mkSession("sanitize-empty", { displayName: "brave-falcon" });
		const result = await applyNativeName("sanitize-empty", "\x00\x01\x02");
		expect(result).toEqual({ found: false, applied: false, reason: "empty_after_sanitize" });
		const row = await getSession("sanitize-empty");
		expect(row?.displayName).toBe("brave-falcon");
	});

	test("C0 control characters are stripped, not just trimmed", async () => {
		await mkSession("sanitize-c0", { displayName: "brave-falcon" });
		const result = await applyNativeName("sanitize-c0", "a\x01b\x1fc");
		expect(result).toEqual({ found: true, applied: true });
		const row = await getSession("sanitize-c0");
		expect(row?.displayName).toBe("abc");
	});

	test("DEL (U+007F) is stripped", async () => {
		await mkSession("sanitize-del", { displayName: "brave-falcon" });
		await applyNativeName("sanitize-del", "a\u007Fb");
		const row = await getSession("sanitize-del");
		expect(row?.displayName).toBe("ab");
	});

	test("zero-width characters U+200B-200F are stripped", async () => {
		await mkSession("sanitize-zw", { displayName: "brave-falcon" });
		await applyNativeName("sanitize-zw", "a​b‌c‍d‎e‏f");
		const row = await getSession("sanitize-zw");
		expect(row?.displayName).toBe("abcdef");
	});

	test("bidi override characters U+202A-202E are stripped", async () => {
		await mkSession("sanitize-bidi1", { displayName: "brave-falcon" });
		await applyNativeName("sanitize-bidi1", "a‪b‫c‬d‭e‮f");
		const row = await getSession("sanitize-bidi1");
		expect(row?.displayName).toBe("abcdef");
	});

	test("bidi isolate characters U+2066-2069 are stripped", async () => {
		await mkSession("sanitize-bidi2", { displayName: "brave-falcon" });
		await applyNativeName("sanitize-bidi2", "a⁦b⁧c⁨d⁩e");
		const row = await getSession("sanitize-bidi2");
		expect(row?.displayName).toBe("abcde");
	});

	test("a 500-code-point name is truncated to 200 code points", async () => {
		await mkSession("sanitize-long", { displayName: "brave-falcon" });
		const longName = "x".repeat(500);
		await applyNativeName("sanitize-long", longName);
		const row = await getSession("sanitize-long");
		expect([...(row?.displayName ?? "")].length).toBe(200);
	});

	test("truncation is surrogate-safe: a name straddling the 200-code-point boundary with a surrogate pair leaves no lone surrogate", async () => {
		await mkSession("sanitize-surrogate", { displayName: "brave-falcon" });
		// 199 ASCII chars + a 2-code-unit astral character (U+1F600) straddling
		// the naive-slice(200) boundary, plus padding so the source is long
		// enough to actually need truncation.
		const longName = `${"x".repeat(199)}\u{1F600}${"y".repeat(100)}`;
		await applyNativeName("sanitize-surrogate", longName);
		const row = await getSession("sanitize-surrogate");
		const result = row?.displayName ?? "";
		expect([...result].length).toBe(200);
		// A plain /[\uD800-\uDFFF]/ test (no `u` flag) flags every surrogate
		// code unit, including a validly-paired astral character — which is
		// exactly what a truncation-preserved emoji looks like. It can't
		// distinguish "paired" from "lone", so it can't tell truncation
		// succeeded from truncation corrupting the string. hasLoneSurrogate
		// requires an unmatched high or low surrogate specifically.
		expect(hasLoneSurrogate(result)).toBe(false);
		expect(result).not.toContain("�");
	});
});

describe("getStats — byAgentType zero-fill (D18)", () => {
	test("every AGENT_TYPES member has an explicit 0 on an empty DB, not merely absent", async () => {
		const stats = await getStats();
		for (const t of AGENT_TYPES) {
			expect(t in stats.byAgentType).toBe(true);
			expect(stats.byAgentType[t]).toBe(0);
		}
	});

	test("a real count overwrites the zero-fill for that agent type only", async () => {
		await mkSession("s1", { agentType: "claude_code", status: "active" });
		await mkSession("s2", { agentType: "claude_code", status: "active" });
		const stats = await getStats();
		expect(stats.byAgentType.claude_code).toBe(2);
		expect(stats.byAgentType.codex_cli).toBe(0);
	});
});

describe("getStats — operational counts (AGEN)", () => {
	test("counts match the shared classifier over a seeded mix, excluding completed", async () => {
		await mkSession("op-working", { isWorking: true });
		await mkSession("op-waiting", { lastAgentTurnCompletedAt: isoAgo(0) });
		await mkSession("op-idle", {});
		await mkSession("op-error", { status: "failed", endedAt: isoAgo(0) });
		await mkSession("op-completed", { status: "completed", endedAt: isoAgo(0) });
		const stats = await getStats();
		expect(stats.operational).toEqual({ waiting: 1, working: 1, idle: 1, error: 1 });
	});
});

describe("getSessions — operational filter, pagination over the full matching set (AGEN)", () => {
	test("total reflects every matching row, not just the returned page", async () => {
		for (let i = 0; i < 5; i++) {
			await mkSession(`op-page-${i}`, {
				lastAgentTurnCompletedAt: isoAgo((5 - i) * MINUTE),
				lastActivityAt: isoAgo((5 - i) * MINUTE),
			});
		}
		const result = await getSessions({ operational: "waiting", limit: 2, offset: 0 });
		expect(result.total).toBe(5);
		expect(result.sessions).toHaveLength(2);
	});

	test("page 2 returns the next slice in the same recency order as page 1", async () => {
		for (let i = 0; i < 5; i++) {
			await mkSession(`op-order-${i}`, {
				lastAgentTurnCompletedAt: isoAgo((5 - i) * MINUTE),
				lastActivityAt: isoAgo((5 - i) * MINUTE),
			});
		}
		const page1 = await getSessions({ operational: "waiting", limit: 2, offset: 0 });
		const page2 = await getSessions({ operational: "waiting", limit: 2, offset: 2 });
		const ids1 = page1.sessions.map((s) => s.sessionId);
		const ids2 = page2.sessions.map((s) => s.sessionId);
		expect(ids1).toEqual(["op-order-4", "op-order-3"]);
		expect(ids2).toEqual(["op-order-2", "op-order-1"]);
	});

	test("every session returned for a given filter actually classifies to that status", async () => {
		await mkSession("op-mix-working", { isWorking: true });
		await mkSession("op-mix-waiting", { lastAgentTurnCompletedAt: isoAgo(0) });
		await mkSession("op-mix-idle", {});
		const result = await getSessions({ operational: "waiting" });
		expect(result.sessions.every((s) => s.sessionId === "op-mix-waiting")).toBe(true);
		expect(result.total).toBe(1);
	});

	test("a failed-and-acknowledged session never appears under any operational filter", async () => {
		await mkSession("op-failed-acked", {
			status: "failed",
			endedAt: isoAgo(10 * MINUTE),
			lastUserAcknowledgedAt: isoAgo(0),
		});
		for (const status of ["waiting", "working", "idle", "error"] as const) {
			const result = await getSessions({ operational: status });
			expect(result.sessions.some((s) => s.sessionId === "op-failed-acked")).toBe(false);
		}
	});

	// AGEN: the SQL dismissed-failure shortcut compares lastUserAcknowledgedAt
	// and endedAt as plain text. A non-ISO stored shape (a legacy SQLite bare
	// value, or a Postgres offset value) sorts against an ISO value by the
	// "T"/" " byte at the same character position, not by actual time — an
	// unacknowledged ERROR with an earlier-same-day ISO ack and a non-ISO
	// endedAt must stay a candidate and classify as "error", never fall out
	// as a false "dismissed".
	test("a non-ISO SQLite-bare endedAt never falsely excludes an unacknowledged error", async () => {
		await mkSession("op-bare-ended", {
			status: "failed",
			endedAt: "2026-10-01 23:00:00",
			lastUserAcknowledgedAt: "2026-10-01T00:00:01.000Z",
		});
		const stats = await getStats();
		expect(stats.operational.error).toBe(1);
		const result = await getSessions({ operational: "error" });
		expect(result.sessions.some((s) => s.sessionId === "op-bare-ended")).toBe(true);
	});

	test("a non-ISO Postgres-offset endedAt never falsely excludes an unacknowledged error", async () => {
		await mkSession("op-offset-ended", {
			status: "failed",
			endedAt: "2026-10-01 23:00:00+00",
			lastUserAcknowledgedAt: "2026-10-01T00:00:01.000Z",
		});
		const stats = await getStats();
		expect(stats.operational.error).toBe(1);
		const result = await getSessions({ operational: "error" });
		expect(result.sessions.some((s) => s.sessionId === "op-offset-ended")).toBe(true);
	});

	test("a genuinely ISO-shaped dismissal (both columns ISO, ack after end) is still excluded", async () => {
		await mkSession("op-iso-dismissed", {
			status: "failed",
			endedAt: "2026-10-01T09:00:00.000Z",
			lastUserAcknowledgedAt: "2026-10-01T09:05:00.000Z",
		});
		const stats = await getStats();
		expect(stats.operational.error).toBe(0);
		const result = await getSessions({ operational: "error" });
		expect(result.sessions.some((s) => s.sessionId === "op-iso-dismissed")).toBe(false);
	});
});

describe("getStats / getSessions(operational=) — statement counts (AGEN)", () => {
	// AGEN: getStats is one aggregate over the table (counts per agent type,
	// from which today's, completed and archived counts are summed) plus the
	// candidate scan the operational counts are classified from.
	test("pins the statement count for both, no per-row queries", async () => {
		const { countDbCalls } = await import("../test-utils/db-call-counter.js");
		await mkSession("stmt-waiting", { lastAgentTurnCompletedAt: isoAgo(0) });
		await mkSession("stmt-working", { isWorking: true });
		await mkSession("stmt-idle", {});

		const statsCalls = await countDbCalls(async () => {
			await getStats();
		});
		console.log(`[session-tracker] getStats statement count: ${statsCalls}`);
		expect(statsCalls).toBe(2);

		const listCalls = await countDbCalls(async () => {
			await getSessions({ operational: "waiting" });
		});
		console.log(`[session-tracker] getSessions(operational) statement count: ${listCalls}`);
		expect(listCalls).toBe(3);
	});
});

// AGEN: the dashboard's Completed/Archived tab badges must come from the
// server's own count, not from `visibleSessions.filter(...)` over whatever
// page useSessions() happens to have loaded (capped at 100) -- otherwise
// the badge silently under-reports past the first page. completedCount
// mirrors getOperationalStatus's own "completed" branch (archived rows
// excluded -- those have their own badge): status='completed'/'archived',
// endedAt set for any non-failed status, or a failed-and-ISO-dismissed row.
describe("getStats — completedCount / archivedCount (AGEN)", () => {
	test("completedCount matches the classifier's completed set; archivedCount matches isArchived", async () => {
		await mkSession("cnt-active", {});
		await mkSession("cnt-waiting", { lastAgentTurnCompletedAt: isoAgo(0) });
		await mkSession("cnt-completed-status", { status: "completed", endedAt: isoAgo(0) });
		await mkSession("cnt-ended-no-status", { status: "active", endedAt: isoAgo(0) });
		await mkSession("cnt-failed-undismissed", { status: "failed", endedAt: isoAgo(0) });
		await mkSession("cnt-failed-dismissed", {
			status: "failed",
			endedAt: isoAgo(10 * MINUTE),
			lastUserAcknowledgedAt: isoAgo(0),
		});
		await mkSession("cnt-archived", { isArchived: true });

		const stats = await getStats();
		expect(stats.completedCount).toBe(3); // completed-status, ended-no-status, failed-dismissed
		expect(stats.archivedCount).toBe(1);
	});

	test("a non-ISO failed-dismissed row is conservatively NOT counted completed (same guard as the candidate scan)", async () => {
		await mkSession("cnt-non-iso-dismissed", {
			status: "failed",
			endedAt: "2026-10-01 23:00:00",
			lastUserAcknowledgedAt: "2026-10-01T00:00:01.000Z",
		});
		const stats = await getStats();
		expect(stats.completedCount).toBe(0);
	});
});

// AGEN: a failed session stays a *candidate* forever (its status never
// changes once acknowledged), so an operator who never archives dismissed
// failures accumulates an unbounded dead backlog. Excluding
// acknowledged-failed rows in SQL (not just by the classifier, after the
// fact) keeps that backlog from crowding real candidates out of a bounded
// scan, and a cap bounds the scan itself regardless.
describe("getStats / getSessions(operational=) — candidate cap and dead-backlog exclusion (AGEN)", () => {
	afterEach(async () => {
		const { _setOperationalCandidateCapForTest } = await import("./session-tracker.js");
		_setOperationalCandidateCapForTest(null);
	});

	test("hundreds of acknowledged-failed rows are excluded in SQL — they never crowd out live rows under a small cap", async () => {
		const { _setOperationalCandidateCapForTest } = await import("./session-tracker.js");
		const { countDbCalls } = await import("../test-utils/db-call-counter.js");
		_setOperationalCandidateCapForTest(10);

		const deadRows = Array.from({ length: 300 }, (_, i) => ({
			sessionId: `dead-${i}`,
			displayName: `dead-${i}`,
			agentType: "claude_code" as const,
			status: "failed" as const,
			isWorking: false,
			endedAt: isoAgo(10 * MINUTE),
			lastUserAcknowledgedAt: isoAgo(0),
			lastActivityAt: isoAgo(0),
		}));
		await getDb().insert(sessions).values(deadRows).execute();

		await mkSession("live-waiting-1", {
			lastAgentTurnCompletedAt: isoAgo(5 * MINUTE),
			lastActivityAt: isoAgo(5 * MINUTE),
		});
		await mkSession("live-waiting-2", {
			lastAgentTurnCompletedAt: isoAgo(6 * MINUTE),
			lastActivityAt: isoAgo(6 * MINUTE),
		});

		let stats: Awaited<ReturnType<typeof getStats>> | undefined;
		const statsCalls = await countDbCalls(async () => {
			stats = await getStats();
		});
		expect(statsCalls).toBe(2);
		expect(stats?.operational.waiting).toBe(2);
		expect(stats?.truncated).toBe(false);

		const result = await getSessions({ operational: "waiting" });
		expect(result.sessions.map((s) => s.sessionId).sort()).toEqual([
			"live-waiting-1",
			"live-waiting-2",
		]);
	});

	test("more live rows than the cap: truncated:true on stats, capped at the cap, one structured log line", async () => {
		const { _setOperationalCandidateCapForTest } = await import("./session-tracker.js");
		_setOperationalCandidateCapForTest(5);

		for (let i = 0; i < 8; i++) {
			await mkSession(`cap-waiting-${i}`, {
				lastAgentTurnCompletedAt: isoAgo(i * MINUTE),
				lastActivityAt: isoAgo(i * MINUTE),
			});
		}

		const logSpy = spyOn(console, "log");
		const stats = await getStats();
		expect(stats.truncated).toBe(true);
		expect(stats.operational.waiting).toBeLessThanOrEqual(5);
		const truncationLogs = logSpy.mock.calls.filter((args) =>
			String(args[0]).includes("operational_candidates_truncated"),
		);
		expect(truncationLogs).toHaveLength(1);
		logSpy.mockRestore();
	});

	// AGEN: the candidate scan is newest-first, so a burst of fresh idle
	// sessions can push an old WAITING/ERROR row out of a small cap before
	// the classifier ever sees it. Ordering attention-needing rows first
	// (whatever SQL can tell cheaply: failed, an unacknowledged finished
	// turn, or permission-wait metadata), then by recency, keeps old
	// attention rows in the scan regardless of how much fresh idle noise
	// arrives after them.
	test("old WAITING and ERROR rows survive a small cap even when newer idle rows would otherwise crowd them out", async () => {
		const { _setOperationalCandidateCapForTest } = await import("./session-tracker.js");
		_setOperationalCandidateCapForTest(3);

		await mkSession("old-waiting", {
			lastAgentTurnCompletedAt: isoAgo(60 * MINUTE),
			lastActivityAt: isoAgo(60 * MINUTE),
		});
		await mkSession("old-error", {
			status: "failed",
			endedAt: isoAgo(60 * MINUTE),
			lastActivityAt: isoAgo(60 * MINUTE),
		});
		for (let i = 0; i < 5; i++) {
			await mkSession(`fresh-idle-${i}`, { lastActivityAt: isoAgo(i * 1000) });
		}

		const stats = await getStats();
		expect(stats.operational.waiting).toBe(1);
		expect(stats.operational.error).toBe(1);
		expect(stats.truncated).toBe(true);

		const waiting = await getSessions({ operational: "waiting" });
		expect(waiting.sessions.map((s) => s.sessionId)).toContain("old-waiting");
		const errored = await getSessions({ operational: "error" });
		expect(errored.sessions.map((s) => s.sessionId)).toContain("old-error");
	});

	test("a session with outstanding permission-wait metadata also sorts ahead of fresh idle noise", async () => {
		const { _setOperationalCandidateCapForTest } = await import("./session-tracker.js");
		_setOperationalCandidateCapForTest(3);

		await mkSession("old-permission-wait", {
			isWorking: true,
			semanticStatus: "waiting",
			metadata: { permissionWait: { ids: ["t1"], anon: 0 } },
			lastActivityAt: isoAgo(60 * MINUTE),
		});
		for (let i = 0; i < 5; i++) {
			await mkSession(`fresh-idle-pw-${i}`, { lastActivityAt: isoAgo(i * 1000) });
		}

		const stats = await getStats();
		expect(stats.operational.waiting).toBe(1);
		const waiting = await getSessions({ operational: "waiting" });
		expect(waiting.sessions.map((s) => s.sessionId)).toContain("old-permission-wait");
	});
});

describe("getStats / getSessions(operational=) — correct past the default page size (AGEN)", () => {
	test("55 waiting sessions: stats counts all 55, the default-limit list page returns 50 with total 55", async () => {
		for (let i = 0; i < 55; i++) {
			await mkSession(`op-default-page-${i}`, {
				lastAgentTurnCompletedAt: isoAgo((55 - i) * MINUTE),
				lastActivityAt: isoAgo((55 - i) * MINUTE),
			});
		}
		const stats = await getStats();
		expect(stats.operational.waiting).toBe(55);

		const result = await getSessions({ operational: "waiting" });
		expect(result.total).toBe(55);
		expect(result.sessions).toHaveLength(50);
	});
});
