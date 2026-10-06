import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
/**
 * Phase 1 (2026-09-29-deliver-supervisor-auth-routing): resolveSessionOwner
 * matrix, the D17 leaf check, and assertSupervisorCanWriteSession.
 *
 * Phase 2 additions: the sessionOwnerSql/sessionOwnedBy expression↔predicate
 * parity test (item 35) and the D19 source-scan drift guard + wiring pin
 * (items 36, 59).
 *
 * Phase 4 additions: the runbook SQL published in deploy/k8s/FORWARDAUTH.md
 * (audit, repair, reassign-host pair, stale-launch inventory) is executed
 * for real, extracted from the doc's own marker comments so the doc and the
 * test can never drift silently (items 49, 50, 56, 57).
 *
 * Test contract items 1-13, 35, 36, 49, 50, 52, 56, 57, 59.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { and, count, eq, sql } from "drizzle-orm";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { controlActions, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { executeRows } = await import("../db/sql-helpers.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { claimNextControlAction } = await import("./control-actions.js");
const {
	assertSupervisorCanWriteSession,
	ownerLaunchJoin,
	resolveSessionOwner,
	sessionOwnedBy,
	SessionOwnershipError,
} = await import("./session-ownership.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(controlActions).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
});

async function seedManagedRow(
	sessionId: string,
	supervisorId: string,
	launchRequestId: string = sessionId,
) {
	const now = new Date().toISOString();
	// managed_sessions.session_id carries a (cascade-rebuilt, for SQLite) FK
	// to sessions.session_id, so the parent row must exist first.
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "codex_cli",
			status: "active",
			lastActivityAt: now,
			metadata: {},
		})
		.onConflictDoNothing()
		.execute();
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId,
			supervisorId,
			managedState: "managed",
			createdAt: now,
			updatedAt: now,
		})
		.execute();
}

async function seedUnclaimedLaunch(sessionId: string, status = "validated") {
	await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: sessionId,
			agentType: "claude_code",
			cwd: "/tmp/session-ownership-test",
			status,
		})
		.execute();
}

async function seedSessionRow(sessionId: string) {
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "codex_cli",
			status: "active",
			lastActivityAt: now,
			metadata: {},
		})
		.execute();
}

// ─── D17 leaf check ──────────────────────────────────────────────────────────

// F29: tolerates an optional trailing same-line comment after the import
// statement (`import { x } from "y.js"; // why`) — the prior regex's `$`
// anchor sat directly after the closing `;`/quote, so any import line
// carrying a trailing comment silently fell out of the scanned set entirely
// (not flagged, not cleared — just invisible to the check).
const LEAF_IMPORT_LINE = /^import\s.+?from\s+["'][^"']+["'];?\s*(?:\/\/.*)?$/gm;

function findOffendingLeafImports(source: string, allowedValueSpecifiers: Set<string>): string[] {
	const importLines = source.match(LEAF_IMPORT_LINE) ?? [];
	const offending: string[] = [];
	for (const line of importLines) {
		const isTypeOnly = /^import\s+type\s/.test(line);
		if (isTypeOnly) continue;
		const match = line.match(/from\s+["']([^"']+)["']/);
		const specifier = match?.[1];
		if (!specifier || !allowedValueSpecifiers.has(specifier)) {
			offending.push(line);
		}
	}
	return offending;
}

const LEAF_ALLOWED_SPECIFIERS = new Set([
	"drizzle-orm",
	"../db/client.js",
	"../db/schema/index.js",
]);

describe("session-ownership.ts is a leaf module (D17)", () => {
	test("value imports are only drizzle-orm, ../db/client.js, ../db/schema/index.js", () => {
		const source = readFileSync(join(import.meta.dir, "session-ownership.ts"), "utf-8");
		expect(findOffendingLeafImports(source, LEAF_ALLOWED_SPECIFIERS)).toEqual([]);
	});

	// F29 (Low, tessa): the regex must not let a trailing same-line comment
	// hide a disallowed import from the scan. Synthetic source, not the real
	// file — this pins the detection mechanism itself, independent of
	// whether session-ownership.ts happens to violate it today.
	test("a disallowed import with a trailing comment is still caught", () => {
		const synthetic = [
			'import { eq } from "drizzle-orm";',
			'import { getDb } from "../db/client.js";',
			'import { launchRequests } from "../db/schema/index.js"; // schema barrel',
			'import { somethingBad } from "./launch-dispatch.js"; // sneaky, trailing comment',
		].join("\n");
		expect(findOffendingLeafImports(synthetic, LEAF_ALLOWED_SPECIFIERS)).toEqual([
			'import { somethingBad } from "./launch-dispatch.js"; // sneaky, trailing comment',
		]);
	});

	test("an allowed import with a trailing comment is not flagged (no false positive from the fix)", () => {
		const synthetic = 'import { eq } from "drizzle-orm"; // trailing comment, allowed specifier';
		expect(findOffendingLeafImports(synthetic, LEAF_ALLOWED_SPECIFIERS)).toEqual([]);
	});
});

// ─── resolveSessionOwner matrix (a)-(h) ─────────────────────────────────────

describe("resolveSessionOwner", () => {
	test("(a) launch claimed by A, no managed row → A", async () => {
		await seedOwnedLaunch("sess-a", "sup-A");
		expect(await resolveSessionOwner("sess-a")).toBe("sup-A");
	});

	test("(b) launch unclaimed (validated) + managed row B → B", async () => {
		await seedUnclaimedLaunch("sess-b", "validated");
		await seedManagedRow("sess-b", "sup-B");
		expect(await resolveSessionOwner("sess-b")).toBe("sup-B");
	});

	test("(c) no launch + managed B → B", async () => {
		await seedManagedRow("sess-c", "sup-B");
		expect(await resolveSessionOwner("sess-c")).toBe("sup-B");
	});

	test("(d) neither exists → null", async () => {
		expect(await resolveSessionOwner("sess-d")).toBeNull();
	});

	test("(e) launch claimed by A (running) + managed row B (legacy hijack) → A", async () => {
		await seedOwnedLaunch("sess-e", "sup-A", { status: "running" });
		await seedManagedRow("sess-e", "sup-B");
		expect(await resolveSessionOwner("sess-e")).toBe("sup-A");
	});

	test("(f) launch claimed by A, status cancelled, + managed B → A", async () => {
		await seedOwnedLaunch("sess-f", "sup-A", { status: "cancelled" });
		await seedManagedRow("sess-f", "sup-B");
		expect(await resolveSessionOwner("sess-f")).toBe("sup-A");
	});

	test("(g) launch claimed by A, status failed, + managed B → A", async () => {
		await seedOwnedLaunch("sess-g", "sup-A", { status: "failed" });
		await seedManagedRow("sess-g", "sup-B");
		expect(await resolveSessionOwner("sess-g")).toBe("sup-A");
	});

	test("(h) launch claimed by A, status running, + managed A → A", async () => {
		await seedOwnedLaunch("sess-h", "sup-A", { status: "running" });
		await seedManagedRow("sess-h", "sup-A");
		expect(await resolveSessionOwner("sess-h")).toBe("sup-A");
	});
});

// ─── assertSupervisorCanWriteSession ────────────────────────────────────────

describe("assertSupervisorCanWriteSession", () => {
	test("own session → resolves without throwing", async () => {
		await seedOwnedLaunch("own-sess", "sup-A");
		await expect(assertSupervisorCanWriteSession("sup-A", "own-sess")).resolves.toBeUndefined();
	});

	test("B's session, A as caller → throws foreign_owner", async () => {
		await seedOwnedLaunch("b-sess", "sup-B");
		try {
			await assertSupervisorCanWriteSession("sup-A", "b-sess");
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(SessionOwnershipError);
			expect((err as InstanceType<typeof SessionOwnershipError>).reason).toBe("foreign_owner");
		}
	});

	test("hook-observed session (sessions row only) → throws no_owner", async () => {
		await seedSessionRow("hook-only-sess");
		try {
			await assertSupervisorCanWriteSession("sup-A", "hook-only-sess");
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(SessionOwnershipError);
			expect((err as InstanceType<typeof SessionOwnershipError>).reason).toBe("no_owner");
		}
	});

	test("unknown session id → throws no_owner", async () => {
		try {
			await assertSupervisorCanWriteSession("sup-A", "does-not-exist");
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(SessionOwnershipError);
			expect((err as InstanceType<typeof SessionOwnershipError>).reason).toBe("no_owner");
		}
	});

	test("A's own session, launchRequestId = B's launch → throws launch_mismatch", async () => {
		await seedOwnedLaunch("a-own-sess", "sup-A");
		const bLaunch = await seedOwnedLaunch("b-other-sess", "sup-B");
		try {
			await assertSupervisorCanWriteSession("sup-A", "a-own-sess", {
				launchRequestId: bLaunch.launchId,
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(SessionOwnershipError);
			expect((err as InstanceType<typeof SessionOwnershipError>).reason).toBe("launch_mismatch");
		}
	});

	test("launchRequestId = A's own claimed launch for that session → resolves", async () => {
		const aLaunch = await seedOwnedLaunch("a-first-report-sess", "sup-A");
		await expect(
			assertSupervisorCanWriteSession("sup-A", "a-first-report-sess", {
				launchRequestId: aLaunch.launchId,
			}),
		).resolves.toBeUndefined();
	});

	test("launchRequestId equal to the managed row's existing value (legacy sessionId fallback) → resolves", async () => {
		await seedOwnedLaunch("legacy-fallback-sess", "sup-A");
		// legacy shape: launch_request_id defaulted to sessionId itself
		await seedManagedRow("legacy-fallback-sess", "sup-A", "legacy-fallback-sess");
		await expect(
			assertSupervisorCanWriteSession("sup-A", "legacy-fallback-sess", {
				launchRequestId: "legacy-fallback-sess",
			}),
		).resolves.toBeUndefined();
	});

	test("never reads authUser or config.disableAuth (D9)", async () => {
		const { config } = await import("../config.js");
		const original = config.disableAuth;
		(config as Record<string, unknown>).disableAuth = true;
		try {
			await seedOwnedLaunch("disable-auth-sess", "sup-B");
			try {
				await assertSupervisorCanWriteSession("sup-A", "disable-auth-sess");
				throw new Error("expected throw");
			} catch (err) {
				expect(err).toBeInstanceOf(SessionOwnershipError);
				expect((err as InstanceType<typeof SessionOwnershipError>).reason).toBe("foreign_owner");
			}
		} finally {
			(config as Record<string, unknown>).disableAuth = original;
		}
	});

	// Test contract item 53: claimed-without-managed, service-level.
	test("claimed-without-managed (matrix a) at the service level → resolves", async () => {
		await seedOwnedLaunch("claimed-no-managed-sess", "sup-A");
		await expect(
			assertSupervisorCanWriteSession("sup-A", "claimed-no-managed-sess"),
		).resolves.toBeUndefined();
	});

	// Test contract item 54: nonexistent launchRequestId is launch_mismatch,
	// not an unhandled DB error.
	test("nonexistent launchRequestId → throws launch_mismatch, not an unhandled error", async () => {
		await seedOwnedLaunch("own-sess-2", "sup-A");
		try {
			await assertSupervisorCanWriteSession("sup-A", "own-sess-2", {
				launchRequestId: crypto.randomUUID(),
			});
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(SessionOwnershipError);
			expect((err as InstanceType<typeof SessionOwnershipError>).reason).toBe("launch_mismatch");
		}
	});
});

// ─── Phase 2: sessionOwnerSql ↔ sessionOwnedBy parity (item 35) ────────────

describe("sessionOwnedBy predicate matches resolveSessionOwner (D8 parity)", () => {
	test("18 fixture×candidate comparisons: predicate count equals resolveSessionOwner match", async () => {
		// Matrix fixtures (b),(c),(e),(f),(g),(h) — every managed-row shape:
		// unclaimed launch, launch-less, running/cancelled/failed hijack, and
		// the self-consistent control. (a)/(d) have no managed row, so the SQL
		// routing never sees them (every routing read selects from
		// managed_sessions) — out of scope for this parity test.
		await seedUnclaimedLaunch("parity-b", "validated");
		await seedManagedRow("parity-b", "sup-B");

		await seedManagedRow("parity-c", "sup-B");

		await seedOwnedLaunch("parity-e", "sup-A", { status: "running" });
		await seedManagedRow("parity-e", "sup-B");

		await seedOwnedLaunch("parity-f", "sup-A", { status: "cancelled" });
		await seedManagedRow("parity-f", "sup-B");

		await seedOwnedLaunch("parity-g", "sup-A", { status: "failed" });
		await seedManagedRow("parity-g", "sup-B");

		await seedOwnedLaunch("parity-h", "sup-A", { status: "running" });
		await seedManagedRow("parity-h", "sup-A");

		const fixtures = ["parity-b", "parity-c", "parity-e", "parity-f", "parity-g", "parity-h"];
		const candidates = ["sup-A", "sup-B", "sup-nobody"];

		let comparisons = 0;
		for (const sessionId of fixtures) {
			const owner = await resolveSessionOwner(sessionId);
			for (const candidate of candidates) {
				comparisons++;
				const [row] = await getDb()
					.select({ cnt: count() })
					.from(managedSessions)
					.leftJoin(launchRequests, ownerLaunchJoin)
					.where(and(eq(managedSessions.sessionId, sessionId), sessionOwnedBy(candidate)));
				const expected = owner === candidate ? 1 : 0;
				expect(row?.cnt).toBe(expected);
			}
		}
		expect(comparisons).toBe(18);
	});

	// Named member: a predicate that falls back to ms.supervisor_id whenever
	// it matches, ignoring the claimant, would wrongly give 1 here.
	test("fixture (e) with candidate B gives 0, not 1 (claimant outranks the stale column)", async () => {
		await seedOwnedLaunch("parity-e-named", "sup-A", { status: "running" });
		await seedManagedRow("parity-e-named", "sup-B");

		const [row] = await getDb()
			.select({ cnt: count() })
			.from(managedSessions)
			.leftJoin(launchRequests, ownerLaunchJoin)
			.where(and(eq(managedSessions.sessionId, "parity-e-named"), sessionOwnedBy("sup-B")));
		expect(row?.cnt).toBe(0);
	});
});

// ─── Phase 2: D19 source-scan drift guard + wiring pin (items 36, 59) ──────

const REPO_ROOT = join(import.meta.dir, "../../../");
const SERVER_SRC = join(REPO_ROOT, "src/server");
const SUPERVISOR_ID_MARKER = /\.supervisorId\b|(^|[^A-Za-z_])supervisor_id\b/g;

// Reasons reviewed at Phase 2 authoring time (P3 population, D19).
const ALLOWED_OCCURRENCES: Record<string, number> = {
	// credential identity (requireSupervisorAuth reading/setting authUser.id)
	"src/server/auth/middleware.ts": 2,
	// credential table columns/lookups (enroll/register/heartbeat by id)
	"src/server/auth/supervisor-auth.ts": 4,
	// enrollment/credential id checks — route :id param plumbing, not
	// session-ownership routing
	"src/server/routes/supervisors.ts": 6,
	// the one-time boot repair of a stored host NAME (normalizeStoredMachineNames):
	// pairs a managed session's copy of the name with its supervisor's repaired
	// name, and gives a row stored with no host its supervisor's name (four reads
	// of the id: the two selects and the two compare-and-set WHEREs). The id is
	// only a display-name lookup key; nothing here decides who owns or may drive a session
	"src/server/services/effective-machine.ts": 4,
	// action-claimant check (updateControlAction's input.supervisorId) —
	// verifying who claimed THIS action, not session ownership
	"src/server/services/control-actions.ts": 1,
	// launch-claimant check (claimNextLaunchRequest) + resolver input
	// (resolveObservedSessionCorrelation's supervisorId parameter)
	"src/server/services/launch-dispatch.ts": 2,
	// ManagedSession DTO mapper (display-only, mapManagedSession); the
	// attach-writer's own input.supervisorId (claimant-only after Phase 1,
	// insert + onConflictDoUpdate); and listManagedSessionsNeedingSync's
	// explicit column selection, which must still carry supervisorId through
	// to mapManagedSession's row shape even though routing itself now goes
	// through sessionOwnedBy() in the WHERE clause, not this column; and the
	// attach's lookup of that claimant's own host NAME (input.supervisorId as
	// the key into supervisors, for the session's machine: display only)
	"src/server/services/managed-session-state.ts": 5,
	// host-compatibility candidate list, unrelated to session ownership
	"src/server/services/template-preview.ts": 1,
};

function walkServerTsFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			results.push(...walkServerTsFiles(full));
		} else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
			results.push(full);
		}
	}
	return results;
}

function isExempt(relPath: string): boolean {
	if (relPath.startsWith("src/server/db/schema/")) return true;
	if (relPath === "src/server/db/client.ts") return true;
	if (relPath === "src/server/services/session-ownership.ts") return true;
	return false;
}

describe("owner-of-record drift guard (D19) + wiring pin", () => {
	test("every raw .supervisorId / supervisor_id read outside the allowlist fails", () => {
		const files = walkServerTsFiles(SERVER_SRC).filter((f) => {
			const relPath = f.slice(REPO_ROOT.length).replace(/\\/g, "/");
			return !isExempt(relPath);
		});
		// Plan text cites "≥150 (181 at base)"; the actual population at this
		// campaign's base commit is 146 non-test *.ts files under src/server/
		// once db/schema/** and db/client.ts are excluded (verified by direct
		// `find`). Floor set just below that observed count — a meaningful
		// population-size sanity check without being flaky on a file or two
		// moving. Deviation noted in the phase report; the code wins.
		expect(files.length).toBeGreaterThanOrEqual(140);

		const found: Record<string, number> = {};
		for (const file of files) {
			const content = readFileSync(file, "utf-8");
			const matches = content.match(SUPERVISOR_ID_MARKER) ?? [];
			if (matches.length === 0) continue;
			const relPath = file.slice(REPO_ROOT.length).replace(/\\/g, "/");
			found[relPath] = matches.length;
		}

		expect(found).toEqual(ALLOWED_OCCURRENCES);
	});

	// Named member: restoring a raw managedRow.supervisorId /
	// managed.supervisorId read in runner.ts must fail — a scan that only
	// knew the literal `managedSessions.supervisorId` string wouldn't catch
	// that (F20).
	test("ai/runner.ts carries zero raw supervisorId reads", () => {
		const file = join(SERVER_SRC, "services/ai/runner.ts");
		const content = readFileSync(file, "utf-8");
		const matches = content.match(SUPERVISOR_ID_MARKER) ?? [];
		expect(matches.length).toBe(0);
	});

	// Wiring pin (item 59): each of these must actually route through the
	// rule, not merely stop reading the raw column (e.g. a hard-coded
	// `supervisorConnected: true` would pass the count-based scan above
	// while being wrong).
	test("control-actions.ts, managed-session-state.ts, session-tracker.ts, ai/runner.ts, ai/intelligence-service.ts all import session-ownership.js", () => {
		const wired = [
			"src/server/services/control-actions.ts",
			"src/server/services/managed-session-state.ts",
			"src/server/services/session-tracker.ts",
			"src/server/services/ai/runner.ts",
			"src/server/services/ai/intelligence-service.ts",
		];
		const missing: string[] = [];
		for (const relPath of wired) {
			const content = readFileSync(join(REPO_ROOT, relPath), "utf-8");
			if (!/from\s+["'](\.\.?\/)*session-ownership\.js["']/.test(content)) {
				missing.push(relPath);
			}
		}
		expect(missing).toEqual([]);
	});
});

// ─── Phase 4: runbook SQL (deploy/k8s/FORWARDAUTH.md) ──────────────────────
// Test contract items 49, 50, 56, 57. Every block below is extracted from
// the doc's own marker comments and executed for real — the doc and the
// test can't silently drift apart the way separately-maintained copies
// could.

const FORWARDAUTH_MD_PATH = join(REPO_ROOT, "deploy/k8s/FORWARDAUTH.md");

function extractMarkerSql(markdown: string, marker: string): string {
	const startTag = `<!-- ${marker}:start -->`;
	const endTag = `<!-- ${marker}:end -->`;
	const startIdx = markdown.indexOf(startTag);
	const endIdx = markdown.indexOf(endTag);
	if (startIdx === -1 || endIdx === -1) {
		throw new Error(`FORWARDAUTH.md is missing the ${marker} markers`);
	}
	const between = markdown.slice(startIdx + startTag.length, endIdx);
	const fenceMatch = between.match(/```sql\n([\s\S]*?)```/);
	if (!fenceMatch) {
		throw new Error(`FORWARDAUTH.md's ${marker} block has no \`\`\`sql fence`);
	}
	return fenceMatch[1];
}

// Splits on a statement-terminating ";" at end of line, dropping any
// fragment that's empty once trimmed (sql-helpers.ts's executeRows already
// dispatches .all vs .execute per dialect — no hand-written branch here).
function splitStatements(sqlText: string): string[] {
	return sqlText
		.split(/;\s*\n/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

async function runMarkerSql(
	marker: string,
	placeholders: Record<string, string> = {},
): Promise<Record<string, unknown>[]> {
	const markdown = readFileSync(FORWARDAUTH_MD_PATH, "utf-8");
	let text = extractMarkerSql(markdown, marker);
	for (const [token, value] of Object.entries(placeholders)) {
		text = text.split(`<${token}>`).join(value);
	}
	const statements = splitStatements(text);
	let lastRows: Record<string, unknown>[] = [];
	for (const statement of statements) {
		lastRows = await executeRows(getDb(), sql.raw(statement));
	}
	return lastRows;
}

async function seedSupervisorRow(id: string, hostName: string) {
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "linux",
				terminalSupport: [],
				features: [],
			},
			trustedRoots: [],
			status: "connected",
			capabilitySchemaVersion: 2,
			configSchemaVersion: 1,
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: now,
			enrollmentState: "active",
			createdAt: now,
			updatedAt: now,
		})
		.execute();
}

describe("runbook — audit query (deploy/k8s/FORWARDAUTH.md, ownership-audit-sql)", () => {
	test("flags owner_mismatch, launch-less (no_launch), launch_pointer_mismatch and launch_pointer_missing; leaves healthy rows (including the legacy fallback) alone", async () => {
		// owner_mismatch: launch claimed by A, recorded owner B.
		await seedOwnedLaunch("audit-mismatch-sess", "sup-A");
		await seedManagedRow("audit-mismatch-sess", "sup-B");

		// no_launch: managed row, no launch at all.
		await seedManagedRow("audit-no-launch-sess", "sup-C");

		// launch_pointer_mismatch: this session's own launch is unclaimed
		// (no owner_mismatch), but the managed row's launch_request_id points
		// at a DIFFERENT session's launch.
		await seedUnclaimedLaunch("audit-ptr-mismatch-sess", "validated");
		const otherLaunch = await seedOwnedLaunch("audit-ptr-mismatch-other-sess", "sup-D");
		await seedManagedRow("audit-ptr-mismatch-sess", "sup-D", otherLaunch.launchId);

		// launch_pointer_missing: this session's own launch is claimed by the
		// recorded owner (no owner_mismatch), but launch_request_id is a
		// random id naming no launch at all.
		await seedOwnedLaunch("audit-ptr-missing-sess", "sup-E");
		await seedManagedRow("audit-ptr-missing-sess", "sup-E", crypto.randomUUID());

		// Healthy, running.
		await seedOwnedLaunch("audit-healthy-running-sess", "sup-F", { status: "running" });
		await seedManagedRow("audit-healthy-running-sess", "sup-F");

		// Healthy, cancelled — pins that the audit ignores launch status.
		await seedOwnedLaunch("audit-healthy-cancelled-sess", "sup-G", { status: "cancelled" });
		await seedManagedRow("audit-healthy-cancelled-sess", "sup-G");

		// Healthy, legacy fallback shape — launch_request_id === session_id,
		// which resolves to no launch by id but is the intentional D6
		// reconcile shape and must NOT be flagged.
		await seedOwnedLaunch("audit-legacy-fallback-sess", "sup-H");
		await seedManagedRow("audit-legacy-fallback-sess", "sup-H", "audit-legacy-fallback-sess");

		const rows = await runMarkerSql("ownership-audit-sql");
		const flaggedIds = new Set(rows.map((r) => r.session_id as string));

		expect(flaggedIds).toEqual(
			new Set([
				"audit-mismatch-sess",
				"audit-no-launch-sess",
				"audit-ptr-mismatch-sess",
				"audit-ptr-missing-sess",
			]),
		);
		expect(flaggedIds.has("audit-legacy-fallback-sess")).toBe(false);

		const missingRow = rows.find((r) => r.session_id === "audit-ptr-missing-sess");
		expect(missingRow?.finding).toBe("launch_pointer_missing");
	});
});

describe("runbook — repair statement (ownership-repair-sql)", () => {
	test("realigns owner_mismatch rows with the launch claimant; leaves launch-less and pointer-broken rows (missing AND mismatched) for human review", async () => {
		await seedOwnedLaunch("repair-mismatch-sess", "sup-A");
		await seedManagedRow("repair-mismatch-sess", "sup-B");
		await seedManagedRow("repair-no-launch-sess", "sup-C");
		await seedOwnedLaunch("repair-ptr-missing-sess", "sup-E");
		await seedManagedRow("repair-ptr-missing-sess", "sup-E", crypto.randomUUID());
		// codex r2 F45: same shape as the audit test's launch_pointer_mismatch
		// fixture — this session's own launch is unclaimed (no owner_mismatch),
		// but the managed row's launch_request_id points at a DIFFERENT
		// session's launch. The repair statement must not touch it (it only
		// realigns owner_mismatch rows).
		await seedUnclaimedLaunch("repair-ptr-mismatch-sess", "validated");
		const otherLaunch = await seedOwnedLaunch("repair-ptr-mismatch-other-sess", "sup-D");
		await seedManagedRow("repair-ptr-mismatch-sess", "sup-D", otherLaunch.launchId);

		await runMarkerSql("ownership-repair-sql");

		expect(await resolveSessionOwner("repair-mismatch-sess")).toBe("sup-A");

		const rows = await runMarkerSql("ownership-audit-sql");
		const flaggedIds = new Set(rows.map((r) => r.session_id as string));
		expect(flaggedIds).toEqual(
			new Set(["repair-no-launch-sess", "repair-ptr-mismatch-sess", "repair-ptr-missing-sess"]),
		);
	});
});

describe("runbook — reassign-host pair (ownership-reassign-sql)", () => {
	test("moves one session's ownership to a new supervisor; a session not named is untouched; the pair is required (a managed-only update has no effect)", async () => {
		await seedSupervisorRow("reassign-old", "old-host");
		await seedSupervisorRow("reassign-new", "new-host");

		const s1Launch = await seedOwnedLaunch("reassign-s1", "reassign-old");
		await seedManagedRow("reassign-s1", "reassign-old", s1Launch.launchId);
		await getDb()
			.insert(controlActions)
			.values({
				sessionId: "reassign-s1",
				launchRequestId: s1Launch.launchId,
				actionType: "prompt",
				requestedBy: "test",
				status: "queued",
				metadata: {},
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			})
			.execute();

		await seedOwnedLaunch("reassign-s2", "reassign-old");
		await seedManagedRow("reassign-s2", "reassign-old");

		// Launch-less session, control for the "pair works even with no
		// launch to touch" case (the launch UPDATE affects 0 rows).
		await seedManagedRow("reassign-s3", "reassign-old");

		await runMarkerSql("ownership-reassign-sql", {
			session_id: "reassign-s1",
			new_supervisor_id: "reassign-new",
		});

		expect(await resolveSessionOwner("reassign-s1")).toBe("reassign-new");
		const [s1Row] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, "reassign-s1"));
		expect(s1Row?.supervisorId).toBe("reassign-new");
		expect(s1Row?.hostName).toBe("new-host");

		const newClaim = await claimNextControlAction("reassign-new");
		expect(newClaim?.sessionId).toBe("reassign-s1");
		const oldClaim = await claimNextControlAction("reassign-old");
		expect(oldClaim).toBeNull();

		// Named non-vacuity member: S2 (not named in the pair) is untouched.
		expect(await resolveSessionOwner("reassign-s2")).toBe("reassign-old");

		// Launch-less S3 moves via the managed-row UPDATE alone (0 launch rows
		// affected, 1 managed row affected).
		await runMarkerSql("ownership-reassign-sql", {
			session_id: "reassign-s3",
			new_supervisor_id: "reassign-new",
		});
		expect(await resolveSessionOwner("reassign-s3")).toBe("reassign-new");
	});

	test("negative control: the managed_sessions statement alone has no effect — the launch claimant still outranks it", async () => {
		await seedSupervisorRow("reassign-neg-old", "old-host");
		await seedSupervisorRow("reassign-neg-new", "new-host");
		await seedOwnedLaunch("reassign-neg-sess", "reassign-neg-old");
		await seedManagedRow("reassign-neg-sess", "reassign-neg-old");

		// Run ONLY the managed_sessions half of the pair (skip the
		// launch_requests statement) — this is what an operator would get
		// from a broken one-statement "repair" attempted under pressure.
		await getDb()
			.update(managedSessions)
			.set({ supervisorId: "reassign-neg-new", hostName: "new-host" })
			.where(eq(managedSessions.sessionId, "reassign-neg-sess"));

		expect(await resolveSessionOwner("reassign-neg-sess")).toBe("reassign-neg-old");
	});
});

describe("runbook — stale-launch inventory (stale-launch-sql)", () => {
	test("lists exactly the validated launches, excluding running ones; the retry pointer is visible on the row that has one", async () => {
		const retryOriginal = await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: "stale-original-sess",
				agentType: "claude_code",
				cwd: "/tmp/stale-launch-test",
				status: "validated",
			})
			.returning();

		const retryClone = await getDb()
			.insert(launchRequests)
			.values({
				launchCorrelationId: "stale-retry-sess",
				agentType: "claude_code",
				cwd: "/tmp/stale-launch-test",
				status: "validated",
				retryOfLaunchRequestId: retryOriginal[0]?.id,
			})
			.returning();

		await seedOwnedLaunch("stale-running-sess", "sup-A", { status: "running" });

		const rows = await runMarkerSql("stale-launch-sql");
		const ids = new Set(rows.map((r) => r.id as string));
		expect(ids).toEqual(new Set([retryOriginal[0]?.id, retryClone[0]?.id]));

		const retryRow = rows.find((r) => r.id === retryClone[0]?.id);
		expect(retryRow?.retry_of_launch_request_id).toBe(retryOriginal[0]?.id);
	});
});

// Test contract item 51 — presence check only; content is covered by the
// runbook SQL tests above and the Manual doc-review verification item.
describe("runbook — CHANGELOG.md presence check (item 51)", () => {
	test("CHANGELOG.md names both tickets and the new error", () => {
		const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf-8");
		expect(changelog.includes("AGEN-17")).toBe(true);
		expect(changelog.includes("AGEN-15")).toBe(true);
		expect(changelog.includes("session_not_owned")).toBe(true);
	});
});
