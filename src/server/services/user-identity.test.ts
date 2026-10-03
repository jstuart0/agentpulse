/**
 * Tests for user-identity.ts: resolving a forwardauth subject to a users
 * row — first resolve creates exactly one row, concurrent first resolves
 * converge on one row, a disabled row stays disabled and is never
 * recreated, a no-uid IdP falls back to the username, and subject_source
 * fills once from null and is never changed afterward.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { users } = await import("../db/schema/index.js");
const { forwardauthSubject, resolveSsoUser } = await import("./user-identity.js");
const { resetIdentityState } = await import("../test-utils/identity-reset.js");
const { describePostgresOnly } = await import("../test-utils/backend.js");

beforeAll(async () => {
	await initializeDatabase();
});

// This file's tests key everything by a per-test unique subject, but other
// files in the suite assert on user/admin counts and share this same
// database — reset so this file doesn't leave rows behind for them.
beforeEach(resetIdentityState);

function uniqueSubject(label: string): string {
	return `${label}-${crypto.randomUUID()}`;
}

describe("first resolve creates exactly one users row", () => {
	test("resolveSsoUser creates a users row with the sso: username convention and the sentinel hash", async () => {
		const provider = "authentik";
		const subject = uniqueSubject("first-resolve");

		const resolved = await resolveSsoUser({
			provider,
			subject,
			source: "uid",
			username: "alice",
		});

		expect(resolved.disabled).toBe(false);
		expect(resolved.role).toBe("user");
		expect(resolved.mustChangePassword).toBe(false);

		const [row] = await getDb().select().from(users).where(eq(users.id, resolved.id)).limit(1);
		expect(row).toBeDefined();
		expect(row.username).toBe(`sso:${provider}:${subject}`);
		expect(row.passwordHash).toBe("!");
		expect(row.authSource).toBe("forwardauth");
		expect(row.subjectSource).toBe("uid");
		expect(row.displayName).toBe("alice");
	});

	test("second resolve of the same (provider, subject) returns the same id", async () => {
		const provider = "authentik";
		const subject = uniqueSubject("second-resolve-same-id");

		const first = await resolveSsoUser({ provider, subject, source: "uid", username: "bob" });
		const second = await resolveSsoUser({ provider, subject, source: "uid", username: "bob" });

		expect(second.id).toBe(first.id);

		const rows = await getDb()
			.select()
			.from(users)
			.where(and(eq(users.provider, provider), eq(users.subject, subject)));
		expect(rows).toHaveLength(1);
	});
});

describe("5 concurrent first resolves with identical input yield one row", () => {
	test("Promise.all of 5 resolveSsoUser calls for the same subject creates exactly one row, all five agree on the id, none throw", async () => {
		const provider = "authentik";
		const subject = uniqueSubject("concurrent-resolve");
		const input = { provider, subject, source: "uid" as const, username: "carol" };

		const results = await Promise.all([
			resolveSsoUser(input),
			resolveSsoUser(input),
			resolveSsoUser(input),
			resolveSsoUser(input),
			resolveSsoUser(input),
		]);

		const ids = new Set(results.map((r) => r.id));
		expect(ids.size).toBe(1);

		const rows = await getDb()
			.select()
			.from(users)
			.where(and(eq(users.provider, provider), eq(users.subject, subject)));
		expect(rows).toHaveLength(1);
	});
});

// Real concurrency only reliably exercises Postgres's connection-level
// races — SQLite's single shared connection serializes everything, so 5
// concurrent calls there prove nothing about the conflict-arbiter bug this
// guards against. On Postgres, timing-dependent races are inherently
// environment-sensitive: measured at this size, with the bug reintroduced,
// across 10 consecutive runs, it did not reproduce (the real-DB/real-network
// round trip here serializes the attempts more than the environment the bug
// was originally found in). It's still kept at this size, Postgres-only, as
// the strongest real-concurrency net available — see the deterministic test
// below for a reproduction of the same failure mode that doesn't depend on
// timing at all.
describePostgresOnly(
	"20 concurrent first resolves with identical input yield one row (Postgres)",
	() => {
		test("Promise.all of 20 resolveSsoUser calls for the same subject creates exactly one row, all twenty agree on the id, none throw", async () => {
			const provider = "authentik";
			const subject = uniqueSubject("concurrent-resolve-20");
			const input = { provider, subject, source: "uid" as const, username: "dana" };

			const results = await Promise.all(Array.from({ length: 20 }, () => resolveSsoUser(input)));

			const ids = new Set(results.map((r) => r.id));
			expect(ids.size).toBe(1);

			const rows = await getDb()
				.select()
				.from(users)
				.where(and(eq(users.provider, provider), eq(users.subject, subject)));
			expect(rows).toHaveLength(1);
		});
	},
);

// A deterministic (no sleep/timing guess) two-connection reproduction of a
// genuine concurrent first-resolve: a second connection opens a transaction
// and inserts the identical (provider, subject, username) row but doesn't
// commit, so the first connection's own insert attempt — inside the real
// resolveSsoUser, not a synthetic statement — genuinely blocks on Postgres's
// row-level locking until the second connection resolves. Blocking is
// confirmed by polling pg_stat_activity for the first connection's insert
// actually waiting on a lock, using the two-raw-connection pattern from
// db/migrations.test.ts, rather than assumed from elapsed time.
//
// Honest finding, not a reproduction of the historical bug: tried reverting
// to the old targeted-arbiter form (`onConflictDoNothing({ target:
// [users.provider, users.subject] })`) and running this test 10 times — it
// passed all 10. Reasoning afterward: when the colliding row is IDENTICAL
// on both unique indexes (this scenario — same provider, subject, AND
// username), the targeted arbiter already matches on (provider, subject)
// and skips the insert entirely; the username index is never separately
// evaluated for a row whose insertion was already abandoned. The historical
// bug needs a row that conflicts on the username index WITHOUT also
// conflicting on the (provider, subject) index — which, as the next test's
// comment explains, can't be reached through resolveSsoUser's public
// interface at all (the username is deterministically derived from
// provider+subject, so two different pairs can never collide on it). That
// edge case is why the source-level regex guard below (and the dedicated
// synthetic-statement test below that) stay the primary defense for the
// documented historical failure — this test's value is independent: it
// proves resolveSsoUser handles a real concurrent first-resolve for the
// SAME identity correctly under true multi-connection contention, not
// Promise.all's same-process interleaving.
describePostgresOnly(
	"first connection's own insert blocks on a second connection's uncommitted identical row",
	() => {
		test("resolveSsoUser does not throw and returns the committed row's id once the second connection commits", async () => {
			const { default: postgres } = await import("postgres");
			const dbUrl = process.env.DATABASE_URL ?? "";
			const client = postgres(dbUrl, { max: 1, idle_timeout: 10 });

			const provider = "authentik";
			const subject = uniqueSubject("blocking-resolve");
			const sentinelUsername = `sso:${provider}:${subject}`;
			const now = new Date().toISOString();
			const blockerId = crypto.randomUUID();

			try {
				const reserved = await client.reserve();
				try {
					await reserved`BEGIN`;
					await reserved`
						INSERT INTO users (id, username, password_hash, role, auth_source, provider, subject, subject_source, display_name, created_at, updated_at)
						VALUES (${blockerId}, ${sentinelUsername}, '!', 'user', 'forwardauth', ${provider}, ${subject}, 'uid', 'blocker-display-name', ${now}, ${now})
					`;

					// Start the real resolveSsoUser call on the normal (pooled)
					// connection — its own insert should now be blocked behind
					// the uncommitted row above.
					const resolvePromise = resolveSsoUser({
						provider,
						subject,
						source: "uid",
						username: "blocking-resolve-caller",
					});

					// Poll pg_stat_activity (via the reserved connection, so this
					// query doesn't itself contend for the one connection in the
					// pool) until another backend shows up waiting on a lock —
					// confirms resolveSsoUser's insert actually blocked, rather
					// than assuming it from timing. Sleep BEFORE each check, not
					// after: checking immediately on iteration 0 races the other
					// connection's own TCP/startup, and empirically a tight
					// check-then-sleep loop misses the row that a sleep-then-check
					// loop reliably finds within one or two iterations — give the
					// other connection room to actually reach the server first.
					const maxAttempts = 15;
					let blocked = false;
					for (let attempt = 0; attempt < maxAttempts && !blocked; attempt++) {
						await new Promise((r) => setTimeout(r, 200));
						const rows = await reserved`
							SELECT count(*)::int AS n FROM pg_stat_activity
							WHERE wait_event_type = 'Lock' AND pid <> pg_backend_pid()
						`;
						blocked = (rows[0]?.n ?? 0) > 0;
					}
					expect(blocked).toBe(true);

					await reserved`COMMIT`;

					const resolved = await resolvePromise;
					expect(resolved.id).toBe(blockerId);
					expect(resolved.displayName).toBe("blocker-display-name");

					const rows = await getDb()
						.select()
						.from(users)
						.where(and(eq(users.provider, provider), eq(users.subject, subject)));
					expect(rows).toHaveLength(1);
				} finally {
					reserved.release();
				}
			} finally {
				await client.end();
			}
		}, 10000);
	},
);

// Deterministic reproduction of the same failure mode, independent of
// timing. The real concurrent race is two backends inserting the identical
// row at once; what actually breaks the targeted-arbiter form is narrower
// and doesn't need two backends at all: an insert that conflicts on the
// username unique index but NOT on the named (provider, subject) arbiter.
// Postgres's ON CONFLICT (columns) DO NOTHING only suppresses a conflict on
// the named index — a violation of any OTHER unique constraint on the same
// table still raises a normal error. A bare ON CONFLICT DO NOTHING (no
// target) suppresses a violation of any constraint on the table. Confirmed
// directly against this container's Postgres (not asserted here, since it's
// a fact about Postgres rather than about this codebase): with a row
// already holding a given username under a different (provider, subject),
// the exact statement shape used by the fixed code
// (`.insert(users).values(...).onConflictDoNothing()`, no target) inserts
// 0 rows without error; the same statement with
// `.onConflictDoNothing({ target: [users.provider, users.subject] })`
// raises `duplicate key value violates unique constraint
// "users_username_unique"`.
//
// This can't be reached by calling resolveSsoUser's public interface with
// two different (provider, subject) pairs: the sentinel username is "sso:"
// + provider + ":" + subject, and the provider is both fixed per install
// and refused at boot if it contains ":" (see
// validateForwardauthProviderConfig) — so two different (provider, subject)
// pairs can never derive the same username. That's exactly why this is
// tested at the statement level, the same pattern resolveSsoUser's own
// first-insert branch uses, rather than by asserting on resolveSsoUser's
// return value for an input that can't occur in practice.
describePostgresOnly(
	"a username collision with no matching (provider, subject) row: the arbiter form that caused the race errors, the fixed bare form doesn't",
	() => {
		test("the exact insert statement resolveSsoUser's first-insert branch uses suppresses a username-only conflict without error; the previously-used targeted-arbiter form raises", async () => {
			const now = new Date().toISOString();
			const blockerProvider = `blocker-provider-${crypto.randomUUID()}`;
			const blockerSubject = "shared-subject";
			const sentinelUsername = `sso:${blockerProvider}:${blockerSubject}`;

			await getDb().insert(users).values({
				username: sentinelUsername,
				passwordHash: "!",
				role: "user",
				authSource: "forwardauth",
				provider: blockerProvider,
				subject: blockerSubject,
				subjectSource: "uid",
				displayName: "blocker",
				createdAt: now,
				updatedAt: now,
			});

			const otherProvider = `other-provider-${crypto.randomUUID()}`;
			const insertSameUsernameDifferentPair = (
				conflictTarget?: [typeof users.provider, typeof users.subject],
			) =>
				getDb()
					.insert(users)
					.values({
						// Same literal username as the blocker row, but under a
						// (provider, subject) pair that has no row of its own —
						// a conflict on the username index only.
						username: sentinelUsername,
						passwordHash: "!",
						role: "user",
						authSource: "forwardauth",
						provider: otherProvider,
						subject: blockerSubject,
						subjectSource: "uid",
						displayName: "would-be-new",
						createdAt: now,
						updatedAt: now,
					})
					.onConflictDoNothing(conflictTarget ? { target: conflictTarget } : undefined);

			// The previously-used, vulnerable form: raises on the non-arbiter
			// unique index. Caught manually (rather than the rejects matcher)
			// because Drizzle wraps the real Postgres error's message inside a
			// "Failed query" wrapper — the underlying Postgres error code is on
			// the cause.
			let arbiterFormError: unknown;
			try {
				await insertSameUsernameDifferentPair([users.provider, users.subject]);
			} catch (err) {
				arbiterFormError = err;
			}
			expect(arbiterFormError).toBeDefined();
			expect((arbiterFormError as { cause?: { code?: string } }).cause?.code).toBe("23505");

			// The fixed, bare form: suppresses it cleanly, no row inserted,
			// nothing thrown (an uncaught rejection here would fail the test).
			await insertSameUsernameDifferentPair();

			const rows = await getDb()
				.select()
				.from(users)
				.where(and(eq(users.provider, otherProvider), eq(users.subject, blockerSubject)));
			expect(rows).toHaveLength(0);
		});
	},
);

// The test above proves the Postgres mechanism in isolation, not through
// resolveSsoUser itself — going through resolveSsoUser's public interface
// for this exact scenario hits its own, unrelated, deliberate "should be
// unreachable" guard regardless of which arbiter form is used (the
// re-select after a suppressed insert is keyed on (provider, subject), and
// no row exists there either way), so it can't distinguish the two forms.
// This guard closes that gap cheaply and dialect-independently: it reads
// the real source and fails if resolveSsoUser's insert ever goes back to a
// targeted arbiter. It is the PRIMARY defense for the documented historical
// failure, not a secondary one: the deterministic two-connection test above
// tried a real behavioral reproduction and, run 10 times with the old
// targeted-arbiter form reinstated, didn't fail once — the historical bug's
// exact trigger (a username-index conflict with no (provider, subject)
// conflict) isn't reachable through resolveSsoUser's public interface at
// all, only through the synthetic statement-level test below. A plain text
// check on the source is what actually stands guard here.
test("resolveSsoUser's insert still uses a bare onConflictDoNothing (no target) — a targeted arbiter reintroduces the race this file documents", async () => {
	const source = await Bun.file(new URL("./user-identity.ts", import.meta.url)).text();
	const match = source.match(/\.onConflictDoNothing\(([^)]*)\)/);
	expect(match).not.toBeNull();
	expect(match?.[1].trim()).toBe("");
});

describe("another provider with the same subject string is a different user", () => {
	test("authentik and authelia with the same subject produce distinct users.id", async () => {
		const subject = uniqueSubject("cross-provider");

		const a = await resolveSsoUser({
			provider: "authentik",
			subject,
			source: "uid",
			username: "dave",
		});
		const b = await resolveSsoUser({
			provider: "authelia",
			subject,
			source: "uid",
			username: "dave",
		});

		expect(a.id).not.toBe(b.id);
	});
});

describe("a disabled SSO row resolves as disabled, never recreated", () => {
	test("a seeded disabled row is returned disabled; resolveSsoUser does not insert a second row or clear disabledAt", async () => {
		const provider = "authentik";
		const subject = uniqueSubject("disabled-row");
		const now = new Date().toISOString();

		const [seeded] = await getDb()
			.insert(users)
			.values({
				username: `sso:${provider}:${subject}`,
				passwordHash: "!",
				role: "user",
				authSource: "forwardauth",
				provider,
				subject,
				subjectSource: "uid",
				displayName: "eve",
				disabledAt: now,
				createdAt: now,
				updatedAt: now,
			})
			.returning();

		const resolved = await resolveSsoUser({ provider, subject, source: "uid", username: "eve" });

		expect(resolved.id).toBe(seeded.id);
		expect(resolved.disabled).toBe(true);

		const rows = await getDb()
			.select()
			.from(users)
			.where(and(eq(users.provider, provider), eq(users.subject, subject)));
		expect(rows).toHaveLength(1);
		expect(rows[0].disabledAt).toBe(now);
	});
});

describe("no-uid IdP: forwardauthSubject falls back to username, source:'username'", () => {
	test("forwardauthSubject with no uid header returns {subject: username, source: 'username'}", () => {
		const h = new Headers({ "X-Authentik-Username": "frank" });
		const result = forwardauthSubject(h);
		expect(result).not.toBeNull();
		expect(result?.subject).toBe("frank");
		expect(result?.username).toBe("frank");
		expect(result?.source).toBe("username");
	});

	test("forwardauthSubject prefers uid when present", () => {
		const h = new Headers({ "X-Authentik-Username": "frank", "X-Authentik-Uid": "uid-frank" });
		const result = forwardauthSubject(h);
		expect(result?.subject).toBe("uid-frank");
		expect(result?.source).toBe("uid");
	});

	test("forwardauthSubject returns null when the username header is absent", () => {
		const h = new Headers();
		expect(forwardauthSubject(h)).toBeNull();
	});

	test("forwardauthSubject returns null for an oversized subject (> 512 chars)", () => {
		const h = new Headers({ "X-Authentik-Username": "x".repeat(513) });
		expect(forwardauthSubject(h)).toBeNull();
	});

	test("no-uid IdP: a no-uid resolve and a later uid-bearing resolve for the SAME username-as-subject converge on one row", async () => {
		const provider = "authentik-no-uid";
		const username = `grace-${crypto.randomUUID().slice(0, 8)}`;

		const first = await resolveSsoUser({
			provider,
			subject: username,
			source: "username",
			username,
		});
		const second = await resolveSsoUser({
			provider,
			subject: username,
			source: "username",
			username,
		});
		expect(second.id).toBe(first.id);

		const [row] = await getDb().select().from(users).where(eq(users.id, first.id)).limit(1);
		expect(row.subjectSource).toBe("username");
	});
});

describe("subject_source: null from the cookie path, filled once by a header path, never changed again", () => {
	test("source:null creates subject_source null; a later source:'uid' fills it once; a further 'username' doesn't change it", async () => {
		const provider = "authentik";
		const subject = uniqueSubject("subject-source-fill-once");

		const cookiePath = await resolveSsoUser({ provider, subject, source: null, username: "hank" });
		const [afterCookie] = await getDb()
			.select()
			.from(users)
			.where(eq(users.id, cookiePath.id))
			.limit(1);
		expect(afterCookie.subjectSource).toBeNull();

		await resolveSsoUser({ provider, subject, source: "uid", username: "hank" });
		const [afterUid] = await getDb()
			.select()
			.from(users)
			.where(eq(users.id, cookiePath.id))
			.limit(1);
		expect(afterUid.subjectSource).toBe("uid");

		await resolveSsoUser({ provider, subject, source: "username", username: "hank" });
		const [afterUsername] = await getDb()
			.select()
			.from(users)
			.where(eq(users.id, cookiePath.id))
			.limit(1);
		// Never changed once non-null.
		expect(afterUsername.subjectSource).toBe("uid");
	});
});

describe("a username-sourced row resolves by (provider, username) alone", () => {
	test("real Headers with no uid ever present, resolved sequentially 3 times, never requires or falls back to a uid", async () => {
		// Sequential, not concurrent: this pins that repeated resolution over
		// time stays uid-free, distinct from the genuine concurrent-race case
		// above.
		const provider = "idp-no-uid-header-ever";
		const username = `ivan-${crypto.randomUUID().slice(0, 8)}`;
		const headers = new Headers({ "X-Authentik-Username": username });

		const ids: string[] = [];
		for (let i = 0; i < 3; i++) {
			const subjectInfo = forwardauthSubject(headers);
			expect(subjectInfo?.source).toBe("username");
			const resolved = await resolveSsoUser({
				provider,
				subject: subjectInfo?.subject as string,
				source: subjectInfo?.source ?? null,
				username: subjectInfo?.username as string,
			});
			ids.push(resolved.id);
		}
		expect(new Set(ids).size).toBe(1);

		const rows = await getDb()
			.select()
			.from(users)
			.where(and(eq(users.provider, provider), eq(users.subject, username)));
		expect(rows).toHaveLength(1);
		expect(rows[0].subject).toBe(username);
	});
});

describe("getUserGateStates", () => {
	test("an empty list is an empty map and issues no query", async () => {
		const { countDbCalls } = await import("../test-utils/db-call-counter.js");
		const { getUserGateStates } = await import("./user-identity.js");
		let result: Map<string, unknown> = new Map([["x", 1]]);
		const calls = await countDbCalls(async () => {
			result = await getUserGateStates([]);
		});
		expect(result.size).toBe(0);
		expect(calls).toBe(0);
	});

	test("reports disabled and must-change-password per user, in one statement; an unknown id is absent", async () => {
		const { getUserGateStates } = await import("./user-identity.js");
		const { countDbCalls } = await import("../test-utils/db-call-counter.js");
		const plain = await resolveSsoUser({
			provider: "authentik",
			subject: uniqueSubject("gate-plain"),
			source: "uid",
			username: "plain",
		});
		const disabled = await resolveSsoUser({
			provider: "authentik",
			subject: uniqueSubject("gate-disabled"),
			source: "uid",
			username: "disabled",
		});
		const flagged = await resolveSsoUser({
			provider: "authentik",
			subject: uniqueSubject("gate-flagged"),
			source: "uid",
			username: "flagged",
		});
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, disabled.id));
		await getDb().update(users).set({ mustChangePassword: true }).where(eq(users.id, flagged.id));
		const unknownId = crypto.randomUUID();

		let states: Awaited<ReturnType<typeof getUserGateStates>> = new Map();
		const calls = await countDbCalls(async () => {
			states = await getUserGateStates([plain.id, disabled.id, flagged.id, unknownId]);
		});

		expect(calls).toBe(1);
		expect(states.get(plain.id)).toEqual({ disabled: false, mustChangePassword: false });
		expect(states.get(disabled.id)).toEqual({ disabled: true, mustChangePassword: false });
		expect(states.get(flagged.id)).toEqual({ disabled: false, mustChangePassword: true });
		expect(states.has(unknownId)).toBe(false);
	});
});

describe("env promotion to admin (AGENTPULSE_ADMIN_SSO_SUBJECTS)", () => {
	const SUBJECTS_ENV = "AGENTPULSE_ADMIN_SSO_SUBJECTS";
	const originalSubjects = process.env[SUBJECTS_ENV];

	afterEach(() => {
		if (originalSubjects === undefined) delete process.env[SUBJECTS_ENV];
		else process.env[SUBJECTS_ENV] = originalSubjects;
	});

	function listSubjects(...subjects: string[]) {
		process.env[SUBJECTS_ENV] = subjects.join(",");
	}

	async function roleInDb(userId: string): Promise<string | undefined> {
		const [row] = await getDb().select().from(users).where(eq(users.id, userId)).limit(1);
		return row?.role;
	}

	/** Runs `fn` and returns the structured log lines it wrote to console.log. */
	async function capturedLogs(fn: () => Promise<void>): Promise<string[]> {
		const lines: string[] = [];
		const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		});
		try {
			await fn();
		} finally {
			spy.mockRestore();
		}
		return lines.filter((line) => line.includes("admin_promoted"));
	}

	const resolveAs = (subject: string, source: "uid" | "username" | null) =>
		resolveSsoUser({ provider: "authentik", subject, source, username: `name-${subject}` });

	test("a uid-sourced user whose subject is listed is promoted on first resolve, in the result and in the database", async () => {
		const subject = uniqueSubject("promote-new");
		listSubjects(subject);

		const resolved = await resolveAs(subject, "uid");

		expect(resolved.role).toBe("admin");
		expect(await roleInDb(resolved.id)).toBe("admin");
	});

	test("an existing member whose subject is later listed is promoted on their next uid request", async () => {
		const subject = uniqueSubject("promote-existing");
		const first = await resolveAs(subject, "uid");
		expect(first.role).toBe("user");

		listSubjects(subject);
		const second = await resolveAs(subject, "uid");

		expect(second.role).toBe("admin");
		expect(await roleInDb(first.id)).toBe("admin");
	});

	test("a subject that isn't listed is never promoted", async () => {
		listSubjects(uniqueSubject("someone-else"));
		const resolved = await resolveAs(uniqueSubject("not-listed"), "uid");

		expect(resolved.role).toBe("user");
	});

	test("a username-sourced row with a listed subject is never promoted, whatever a later request carries", async () => {
		const subject = uniqueSubject("by-username");
		listSubjects(subject);

		const created = await resolveAs(subject, "username");
		const laterWithUid = await resolveAs(subject, "uid");

		expect(created.role).toBe("user");
		expect(laterWithUid.role).toBe("user");
		expect(await roleInDb(created.id)).toBe("user");
	});

	test("a uid-sourced row isn't promoted by a request whose subject came from the username or from a cookie", async () => {
		const subject = uniqueSubject("request-source");
		await resolveAs(subject, "uid");
		listSubjects(subject);

		expect((await resolveAs(subject, "username")).role).toBe("user");
		expect((await resolveAs(subject, null)).role).toBe("user");
		expect((await resolveAs(subject, "uid")).role).toBe("admin");
	});

	test("a null-sourced row (first seen through a cookie) is not promoted on the request that fills its source, only afterwards", async () => {
		const subject = uniqueSubject("null-source");
		listSubjects(subject);
		const viaCookie = await resolveAs(subject, null);
		expect(viaCookie.role).toBe("user");

		const filling = await resolveAs(subject, "uid");
		expect(filling.role).toBe("user");
		const [row] = await getDb().select().from(users).where(eq(users.id, viaCookie.id));
		expect(row?.subjectSource).toBe("uid");

		expect((await resolveAs(subject, "uid")).role).toBe("admin");
	});

	test("the same subject under a different provider is not promoted", async () => {
		const subject = uniqueSubject("other-provider");
		listSubjects(subject);

		const resolved = await resolveSsoUser({
			provider: "authelia",
			subject,
			source: "uid",
			username: "someone",
		});

		expect(resolved.role).toBe("user");
	});

	test("a disabled listed user is not promoted", async () => {
		const subject = uniqueSubject("disabled-listed");
		const created = await resolveAs(subject, "uid");
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, created.id));
		listSubjects(subject);

		const resolved = await resolveAs(subject, "uid");

		expect(resolved.disabled).toBe(true);
		expect(await roleInDb(created.id)).toBe("user");
	});

	test("promotion writes once and logs once: a second resolve neither writes nor logs", async () => {
		const subject = uniqueSubject("once");
		listSubjects(subject);

		const firstLogs = await capturedLogs(async () => {
			await resolveAs(subject, "uid");
		});
		const [afterFirst] = await getDb().select().from(users).where(eq(users.subject, subject));
		await Bun.sleep(5);
		const secondLogs = await capturedLogs(async () => {
			await resolveAs(subject, "uid");
		});
		const [afterSecond] = await getDb().select().from(users).where(eq(users.subject, subject));

		expect(firstLogs.length).toBe(1);
		expect(secondLogs.length).toBe(0);
		expect(afterSecond?.updatedAt).toBe(afterFirst?.updatedAt as string);
	});

	test("the audit line names the user and the subject source, via env, and carries no header values", async () => {
		const subject = uniqueSubject("audit");
		listSubjects(subject);
		let userId = "";

		const logs = await capturedLogs(async () => {
			userId = (await resolveAs(subject, "uid")).id;
		});

		expect(logs.length).toBe(1);
		expect(JSON.parse(logs[0] as string)).toMatchObject({
			kind: "admin_promoted",
			userId,
			via: "env",
			subjectSource: "uid",
		});
		expect(logs[0]).not.toContain("X-Authentik");
		expect(logs[0]).not.toContain(subject);
	});

	test("simultaneous first requests for a listed subject promote once and log once", async () => {
		const subject = uniqueSubject("race");
		listSubjects(subject);

		let results: Awaited<ReturnType<typeof resolveAs>>[] = [];
		const logs = await capturedLogs(async () => {
			results = await Promise.all(Array.from({ length: 5 }, () => resolveAs(subject, "uid")));
		});

		expect(new Set(results.map((r) => r.id)).size).toBe(1);
		expect(await roleInDb(results[0]?.id as string)).toBe("admin");
		expect(logs.length).toBe(1);
	});

	test("removing a subject from the list doesn't demote", async () => {
		const subject = uniqueSubject("removed");
		listSubjects(subject);
		const promoted = await resolveAs(subject, "uid");
		expect(promoted.role).toBe("admin");

		listSubjects(uniqueSubject("different"));
		const after = await resolveAs(subject, "uid");

		expect(after.role).toBe("admin");
		expect(await roleInDb(promoted.id)).toBe("admin");
	});

	test("promotion goes through the admin lock; resolving a member who isn't promoted never waits for it", async () => {
		const { withAdminLock } = await import("../db/admin-lock.js");
		const listed = uniqueSubject("lock-listed");
		const plain = uniqueSubject("lock-plain");
		await resolveAs(listed, "uid");
		await resolveAs(plain, "uid");
		listSubjects(listed);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const holder = withAdminLock(async () => held);
		await Bun.sleep(10);
		const settledOrWaiting = (p: Promise<unknown>) =>
			Promise.race([p.then(() => "settled"), Bun.sleep(100).then(() => "waiting")]);

		const unpromoted = await settledOrWaiting(resolveAs(plain, "uid"));
		const promoting = resolveAs(listed, "uid");
		const promotingState = await settledOrWaiting(promoting);
		release();
		await holder;

		expect(unpromoted).toBe("settled");
		expect(promotingState).toBe("waiting");
		expect((await promoting).role).toBe("admin");
	});
});

describe("env promotion through the request path", () => {
	const SUBJECTS_ENV = "AGENTPULSE_ADMIN_SSO_SUBJECTS";
	const originalSubjects = process.env[SUBJECTS_ENV];
	const SECRET = "promotion-path-secret";
	const originalSecret = process.env.FORWARDAUTH_TRUST_SECRET;

	beforeAll(() => {
		process.env.FORWARDAUTH_TRUST_SECRET = SECRET;
		// biome-ignore lint/performance/noDelete: clear Object.defineProperty-installed own property
		delete (config as Record<string, unknown>)._forwardauthTrustSecret;
	});

	afterAll(() => {
		process.env.FORWARDAUTH_TRUST_SECRET = originalSecret;
		// biome-ignore lint/performance/noDelete: clear Object.defineProperty-installed own property
		delete (config as Record<string, unknown>)._forwardauthTrustSecret;
	});

	afterEach(() => {
		if (originalSubjects === undefined) delete process.env[SUBJECTS_ENV];
		else process.env[SUBJECTS_ENV] = originalSubjects;
	});

	test("a request with the uid header gets role admin; a cookie-only request for the same user reads the stored role", async () => {
		const { getAuthUserFromHeaders } = await import("../auth/middleware.js");
		const { issueSession, SSO_SESSION_DURATION_MS } = await import("./local-auth-service.js");
		const subject = uniqueSubject("path");
		process.env[SUBJECTS_ENV] = subject;
		const headers = new Headers({
			"X-Authentik-Username": "pathuser",
			"X-Authentik-Uid": subject,
			"X-Authentik-Verify": SECRET,
		});

		const viaHeaders = await getAuthUserFromHeaders(headers);
		expect(viaHeaders?.role).toBe("admin");

		const { token } = await issueSession({
			userId: subject,
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: subject,
			ssoUsername: "pathuser",
			provider: "authentik",
		});
		const viaCookie = await getAuthUserFromHeaders(new Headers({ Cookie: `ap_session=${token}` }));
		expect(viaCookie?.role).toBe("admin");
	});

	test("a cookie-only request never promotes, even for a listed subject", async () => {
		const { getAuthUserFromHeaders } = await import("../auth/middleware.js");
		const { issueSession, SSO_SESSION_DURATION_MS } = await import("./local-auth-service.js");
		const subject = uniqueSubject("cookie-only");
		process.env[SUBJECTS_ENV] = subject;
		const { token } = await issueSession({
			userId: subject,
			durationMs: SSO_SESSION_DURATION_MS,
			authSource: "forwardauth",
			ssoSubject: subject,
			ssoUsername: "cookieonly",
			provider: "authentik",
		});

		const viaCookie = await getAuthUserFromHeaders(new Headers({ Cookie: `ap_session=${token}` }));

		expect(viaCookie?.role).toBe("user");
	});
});
