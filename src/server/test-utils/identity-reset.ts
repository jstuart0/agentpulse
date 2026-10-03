/**
 * Shared test helper: reset every identity-related table to a clean slate.
 *
 * All test files in this suite share one SQLite file (see `__test_db.js`),
 * and Bun doesn't guarantee which file runs before which. A row left behind
 * by one file's test — a local user, an auth session, an API key, the
 * first-run-signup flag, an instance-mode setting — changes what a later
 * file's count-sensitive assertion sees. Call this before any test that
 * depends on a known user count, admin count, API key count, or instance
 * mode, then seed only the rows that specific test needs.
 *
 * Deletes: `users` (both local and SSO rows), `auth_sessions` (sessions
 * reference `users.id` and would otherwise dangle), `api_keys`, the
 * `auth.firstRunCompleted` setting (first-run signup's belt-and-suspenders
 * guard, independent of the user count itself), any `instance.*`-prefixed
 * setting, and the hosts (an owned host left behind would reach the next
 * file's launch-picking code with whatever capabilities a fixture gave it)
 * with their credentials and enrollment tokens.
 *
 * Deliberately does NOT recreate the default bootstrap API key — a test
 * that needs it present calls `ensureDefaultApiKey()` (api-key.ts) itself,
 * same as any other test-specific seeding after a reset.
 */
import { eq, like } from "drizzle-orm";
import { getDb } from "../db/client.js";
import {
	apiKeys,
	authSessions,
	settings,
	supervisorCredentials,
	supervisorEnrollmentTokens,
	supervisors,
	users,
} from "../db/schema/index.js";
import { _resetKeyMintLimitForTest } from "../services/key-mint-limit.js";

export async function resetIdentityState(): Promise<void> {
	_resetKeyMintLimitForTest();
	await getDb().delete(authSessions);
	await getDb().delete(supervisorEnrollmentTokens);
	await getDb().delete(supervisorCredentials);
	await getDb().delete(supervisors);
	await getDb().delete(apiKeys);
	await getDb().delete(users);
	await getDb().delete(settings).where(eq(settings.key, "auth.firstRunCompleted"));
	await getDb().delete(settings).where(like(settings.key, "instance.%"));
}
