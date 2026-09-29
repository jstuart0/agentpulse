import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
/**
 * Phase 1 (2026-09-29-deliver-supervisor-auth-routing): resolveSessionOwner
 * matrix, the D17 leaf check, and assertSupervisorCanWriteSession.
 *
 * Test contract items 1-13, 52.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { launchRequests, managedSessions, sessions } = await import("../db/schema/index.js");
const { seedOwnedLaunch } = await import("../test-utils/owned-launch.js");
const { assertSupervisorCanWriteSession, resolveSessionOwner, SessionOwnershipError } =
	await import("./session-ownership.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
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

describe("session-ownership.ts is a leaf module (D17)", () => {
	test("value imports are only drizzle-orm, ../db/client.js, ../db/schema/index.js", () => {
		const source = readFileSync(join(import.meta.dir, "session-ownership.ts"), "utf-8");
		const importLines = source.match(/^import\s.+?from\s+["'][^"']+["'];?$/gm) ?? [];
		const allowedValueSpecifiers = new Set([
			"drizzle-orm",
			"../db/client.js",
			"../db/schema/index.js",
		]);
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
		expect(offending).toEqual([]);
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
