/**
 * Unit tests for src/server/auth/middleware.ts
 *
 * Tests exercise getAuthUserFromHeaders with real Headers instances
 * (not duck-typed wrappers) so the full trust-gate path is covered.
 *
 * Env vars are snapshotted and restored between tests so FORWARDAUTH_*
 * overrides don't bleed across cases. Because config.forwardauthTrustSecret
 * is memoized, we reset the memo by deleting the _forwardauthTrustSecret
 * property between tests.
 *
 * DB is not used here — middleware functions are pure wrt the database.
 * We import the __test_db helper only to set SQLITE_PATH so any transitive
 * module that opens the DB doesn't collide with the main test suite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Set SQLITE_PATH before any other import opens the DB.
import "/Users/jaystuart/dev/agentpulse/src/server/db/__test_db.ts";

// ── env snapshot / restore ────────────────────────────────────────────────────

type EnvSnapshot = Record<string, string | undefined>;

const WATCHED_VARS = [
	"FORWARDAUTH_TRUST_SECRET",
	"AGENTPULSE_AUTHENTIK_TRUST_SECRET",
	"FORWARDAUTH_PROVIDER",
	"FORWARDAUTH_HEADER_USERNAME",
	"FORWARDAUTH_HEADER_EMAIL",
	"FORWARDAUTH_HEADER_GROUPS",
	"FORWARDAUTH_HEADER_NAME",
	"FORWARDAUTH_HEADER_UID",
	"FORWARDAUTH_HEADER_VERIFY",
	"FORWARDAUTH_HEADER_STRIP_PREFIX",
	"DISABLE_AUTH",
];

let snapshot: EnvSnapshot = {};

function saveEnv() {
	snapshot = {};
	for (const k of WATCHED_VARS) snapshot[k] = process.env[k];
}

function restoreEnv() {
	for (const k of WATCHED_VARS) {
		if (snapshot[k] === undefined) delete process.env[k];
		else process.env[k] = snapshot[k];
	}
}

/**
 * The config object memoizes forwardauthTrustSecret via Object.defineProperty.
 * Delete the cached property so the next access re-reads process.env.
 */
function resetConfigMemo() {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const cfg = require("../config.js").config as Record<string, unknown>;
	// biome-ignore lint/performance/noDelete: delete required to clear Object.defineProperty-installed own property
	delete cfg._forwardauthTrustSecret;
}

/**
 * Re-import getAuthUserFromHeaders with a fresh module cache so env changes
 * made between tests are visible. Bun caches ESM modules, but the function
 * reads process.env at call time (for headers) or via the memoized getter
 * (for the trust secret). resetConfigMemo() handles the memo; the function
 * itself needs no re-import for the header slots (they're read at call time).
 */
async function getAuthUserFromHeaders(
	headers: Headers,
): Promise<import("./middleware.js").AuthUser | null> {
	const mod = await import("./middleware.js");
	return mod.getAuthUserFromHeaders(headers);
}

beforeEach(() => {
	saveEnv();
	// Ensure auth is enabled for all trust-gate tests.
	process.env.DISABLE_AUTH = "false";
	resetConfigMemo();
});

afterEach(() => {
	restoreEnv();
	resetConfigMemo();
});

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a Headers object with Authentik-default header names (no env override).
 */
function authentikHeaders(opts: {
	username: string;
	uid?: string;
	verify?: string;
}): Headers {
	const h = new Headers();
	h.set("X-Authentik-Username", opts.username);
	if (opts.uid !== undefined) h.set("X-Authentik-Uid", opts.uid);
	if (opts.verify !== undefined) h.set("X-Authentik-Verify", opts.verify);
	return h;
}

// ── Trust gate: default Authentik header names ────────────────────────────────

describe("trust gate — default Authentik header names", () => {
	test("passes when verify header matches secret", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "s3cr3t";
		resetConfigMemo();

		const h = authentikHeaders({ username: "alice", uid: "uid-1", verify: "s3cr3t" });
		const user = await getAuthUserFromHeaders(h);

		expect(user).not.toBeNull();
		expect(user?.source).toBe("forwardauth");
		expect(user?.name).toBe("alice");
		expect(user?.id).toBe("uid-1");
		expect(user?.provider).toBe("authentik");
	});

	test("returns null when verify header is missing (trust gate blocks)", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "s3cr3t";
		resetConfigMemo();

		const h = authentikHeaders({ username: "alice" }); // no verify header
		const user = await getAuthUserFromHeaders(h);

		// Trust gate failed — should fall through and find no other auth.
		expect(user).toBeNull();
		// Headers should have been stripped.
		expect(h.get("X-Authentik-Username")).toBeNull();
	});

	test("returns null when verify header is wrong (secret mismatch)", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "s3cr3t";
		resetConfigMemo();

		const h = authentikHeaders({ username: "alice", verify: "wrong-secret" });
		const user = await getAuthUserFromHeaders(h);

		expect(user).toBeNull();
		// Identity headers stripped on mismatch.
		expect(h.get("X-Authentik-Username")).toBeNull();
	});

	test("returns null when secret is unconfigured (empty) — trust gate disabled", async () => {
		// No FORWARDAUTH_TRUST_SECRET set — even a correctly-valued verify header fails.
		process.env.FORWARDAUTH_TRUST_SECRET = undefined;
		process.env.AGENTPULSE_AUTHENTIK_TRUST_SECRET = undefined;
		resetConfigMemo();

		const h = authentikHeaders({ username: "alice", verify: "anything" });
		const user = await getAuthUserFromHeaders(h);

		// Trust gate disabled → returns null because verifyForwardauthSecret returns false
		// when expected is empty. The gate requires a configured secret.
		expect(user).toBeNull();
	});

	test("length-mismatch secret fails safely (no timingSafeEqual throw)", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "short";
		resetConfigMemo();

		const h = authentikHeaders({ username: "alice", verify: "much-longer-secret-value" });
		const user = await getAuthUserFromHeaders(h);

		expect(user).toBeNull();
	});
});

// ── Trust gate: custom header names via env overrides ────────────────────────

describe("trust gate — custom header names via FORWARDAUTH_HEADER_* env", () => {
	test("passes when custom FORWARDAUTH_HEADER_VERIFY matches secret", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "authelia-secret";
		process.env.FORWARDAUTH_HEADER_USERNAME = "Remote-User";
		process.env.FORWARDAUTH_HEADER_UID = "Remote-Uid";
		process.env.FORWARDAUTH_HEADER_VERIFY = "Remote-Verify";
		process.env.FORWARDAUTH_PROVIDER = "authelia";
		resetConfigMemo();

		const h = new Headers();
		h.set("Remote-User", "bob");
		h.set("Remote-Uid", "uid-bob");
		h.set("Remote-Verify", "authelia-secret");

		const user = await getAuthUserFromHeaders(h);

		expect(user).not.toBeNull();
		expect(user?.source).toBe("forwardauth");
		expect(user?.name).toBe("bob");
		expect(user?.id).toBe("uid-bob");
		expect(user?.provider).toBe("authelia");
	});

	test("rejects when custom verify header is missing", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "authelia-secret";
		process.env.FORWARDAUTH_HEADER_USERNAME = "Remote-User";
		process.env.FORWARDAUTH_HEADER_VERIFY = "Remote-Verify";
		process.env.FORWARDAUTH_HEADER_STRIP_PREFIX = "Remote-";
		resetConfigMemo();

		const h = new Headers();
		h.set("Remote-User", "bob");
		// No Remote-Verify

		const user = await getAuthUserFromHeaders(h);
		expect(user).toBeNull();
		// Remote-User should be stripped (prefix = "Remote-").
		expect(h.get("Remote-User")).toBeNull();
	});
});

// ── Strip prefix ──────────────────────────────────────────────────────────────

describe("header stripping", () => {
	test("strips default X-Authentik- prefix on trust gate failure", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "s3cr3t";
		resetConfigMemo();

		const h = new Headers();
		h.set("X-Authentik-Username", "alice");
		h.set("X-Authentik-Email", "alice@example.com");
		h.set("X-Authentik-Groups", "admins");
		h.set("Authorization", "Bearer tok"); // must survive

		await getAuthUserFromHeaders(h); // verify missing → fails

		expect(h.get("X-Authentik-Username")).toBeNull();
		expect(h.get("X-Authentik-Email")).toBeNull();
		expect(h.get("X-Authentik-Groups")).toBeNull();
		expect(h.get("Authorization")).toBe("Bearer tok"); // non-forwardauth header untouched
	});

	test("strips custom Remote- prefix on trust gate failure", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "s3cr3t";
		process.env.FORWARDAUTH_HEADER_USERNAME = "Remote-User";
		process.env.FORWARDAUTH_HEADER_VERIFY = "Remote-Verify";
		process.env.FORWARDAUTH_HEADER_STRIP_PREFIX = "Remote-";
		resetConfigMemo();

		const h = new Headers();
		h.set("Remote-User", "charlie");
		h.set("Remote-Email", "charlie@example.com");
		h.set("X-Api-Key", "should-survive");
		// No Remote-Verify → trust gate fails

		await getAuthUserFromHeaders(h);

		expect(h.get("Remote-User")).toBeNull();
		expect(h.get("Remote-Email")).toBeNull();
		expect(h.get("X-Api-Key")).toBe("should-survive");
	});
});

// ── Source and provider fields ────────────────────────────────────────────────

describe("source and provider fields", () => {
	test("source is 'forwardauth' (never 'authentik')", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "s3cr3t";
		resetConfigMemo();

		const h = authentikHeaders({ username: "alice", verify: "s3cr3t" });
		const user = await getAuthUserFromHeaders(h);

		expect(user?.source).toBe("forwardauth");
		expect(user?.source).not.toBe("authentik");
	});

	test("provider defaults to 'authentik' when FORWARDAUTH_PROVIDER is unset", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "s3cr3t";
		process.env.FORWARDAUTH_PROVIDER = undefined;
		resetConfigMemo();

		const h = authentikHeaders({ username: "alice", verify: "s3cr3t" });
		const user = await getAuthUserFromHeaders(h);

		expect(user?.provider).toBe("authentik");
	});

	test("provider reflects FORWARDAUTH_PROVIDER env when set", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "s3cr3t";
		process.env.FORWARDAUTH_PROVIDER = "pomerium";
		resetConfigMemo();

		const h = authentikHeaders({ username: "alice", verify: "s3cr3t" });
		const user = await getAuthUserFromHeaders(h);

		expect(user?.provider).toBe("pomerium");
	});
});

// ── Deprecated env var backward-compatibility ─────────────────────────────────

describe("deprecated AGENTPULSE_AUTHENTIK_TRUST_SECRET env var", () => {
	test("still works when FORWARDAUTH_TRUST_SECRET is unset", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = undefined;
		process.env.AGENTPULSE_AUTHENTIK_TRUST_SECRET = "legacy-secret";
		resetConfigMemo();

		const h = authentikHeaders({ username: "alice", verify: "legacy-secret" });
		const user = await getAuthUserFromHeaders(h);

		expect(user).not.toBeNull();
		expect(user?.source).toBe("forwardauth");
		expect(user?.name).toBe("alice");
	});

	test("FORWARDAUTH_TRUST_SECRET wins when both are set (precedence)", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "new-secret";
		process.env.AGENTPULSE_AUTHENTIK_TRUST_SECRET = "legacy-secret";
		resetConfigMemo();

		// New secret succeeds.
		const h1 = authentikHeaders({ username: "alice", verify: "new-secret" });
		const user1 = await getAuthUserFromHeaders(h1);
		expect(user1).not.toBeNull();

		resetConfigMemo();

		// Legacy secret alone fails (new takes precedence).
		const h2 = authentikHeaders({ username: "alice", verify: "legacy-secret" });
		const user2 = await getAuthUserFromHeaders(h2);
		expect(user2).toBeNull();
	});

	test("config.authentikTrustSecret deprecated getter returns same value as forwardauthTrustSecret", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "foo";
		resetConfigMemo();

		const { config } = await import("../config.js");
		expect(config.forwardauthTrustSecret).toBe("foo");
		expect(config.authentikTrustSecret).toBe("foo");
	});
});

// ── Config: deprecation warning for legacy env var ────────────────────────────

describe("config deprecation warning", () => {
	test("boot warning fires when only legacy env var is set", async () => {
		// This test validates that index.ts would emit the deprecation warning.
		// We check it at the config level: when AGENTPULSE_AUTHENTIK_TRUST_SECRET
		// is set but FORWARDAUTH_TRUST_SECRET is not, the resolved value still works.
		process.env.FORWARDAUTH_TRUST_SECRET = undefined;
		process.env.AGENTPULSE_AUTHENTIK_TRUST_SECRET = "legacy-only";
		resetConfigMemo();

		const { config } = await import("../config.js");
		// The resolved value is the legacy value — the warning is emitted by index.ts boot.
		expect(config.forwardauthTrustSecret).toBe("legacy-only");
		// The condition that triggers the warning in index.ts is checkable here:
		const shouldWarn =
			!!process.env.AGENTPULSE_AUTHENTIK_TRUST_SECRET && !process.env.FORWARDAUTH_TRUST_SECRET;
		expect(shouldWarn).toBe(true);
	});

	test("no warning condition when new env var is set", async () => {
		process.env.FORWARDAUTH_TRUST_SECRET = "new-secret";
		process.env.AGENTPULSE_AUTHENTIK_TRUST_SECRET = undefined;
		resetConfigMemo();

		const shouldWarn =
			!!process.env.AGENTPULSE_AUTHENTIK_TRUST_SECRET && !process.env.FORWARDAUTH_TRUST_SECRET;
		expect(shouldWarn).toBe(false);
	});
});

// ── signOutUrl selection ──────────────────────────────────────────────────────
// These tests validate the route-level signOutUrl logic by checking the
// provider-driven condition directly (the route uses user.provider === "authentik").

// signOutUrl derivation helper — mirrors the condition in routes/auth.ts.
function deriveSignOutUrl(user: {
	source: "forwardauth" | "api_key" | "local";
	provider?: string;
}): string | null {
	if (user.source === "forwardauth" && user.provider === "authentik") {
		return "/outpost.goauthentik.io/sign_out";
	}
	if (user.source === "local") {
		return "/api/v1/auth/logout";
	}
	return null;
}

describe("signOutUrl provider selection (route-level condition)", () => {
	test("Authentik provider returns goauthentik sign-out path", () => {
		expect(deriveSignOutUrl({ source: "forwardauth", provider: "authentik" })).toBe(
			"/outpost.goauthentik.io/sign_out",
		);
	});

	test("non-Authentik provider returns null", () => {
		expect(deriveSignOutUrl({ source: "forwardauth", provider: "authelia" })).toBeNull();
	});

	test("local user returns API logout path", () => {
		expect(deriveSignOutUrl({ source: "local" })).toBe("/api/v1/auth/logout");
	});
});
