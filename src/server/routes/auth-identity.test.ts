/**
 * Route-level tests for the auth router against SSO identity rows: first-run
 * signup's interaction with a configured forwardauth identity provider, an
 * "sso:"-prefixed username can't log in with the sentinel password, an
 * unpromoted SSO caller's role is "user", and a local signup can't register
 * a username that collides with the SSO convention.
 *
 * There is no routes/auth.test.ts on main — this is the first route-level
 * auth test file.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { getDb, initializeDatabase } = await import("../db/client.js");
const { users } = await import("../db/schema/index.js");
const { Hono } = await import("hono");
const { authRouter } = await import("./auth.js");
const { resetIdentityState } = await import("../test-utils/identity-reset.js");

function makeApp() {
	const app = new Hono();
	app.route("/api/v1", authRouter);
	return app;
}

async function seedSsoUser(opts: {
	username: string;
	provider?: string;
	subject?: string;
}): Promise<void> {
	const now = new Date().toISOString();
	await getDb()
		.insert(users)
		.values({
			username: opts.username,
			passwordHash: "!",
			role: "user",
			authSource: "forwardauth",
			provider: opts.provider ?? "authentik",
			subject: opts.subject ?? `subj-${opts.username}`,
			createdAt: now,
			updatedAt: now,
		});
}

/** Set (or clear) FORWARDAUTH_TRUST_SECRET and reset the config memo so the change takes effect immediately. */
function setForwardauthConfigured(secret: string | undefined): void {
	if (secret === undefined) {
		process.env.FORWARDAUTH_TRUST_SECRET = undefined;
	} else {
		process.env.FORWARDAUTH_TRUST_SECRET = secret;
	}
	// biome-ignore lint/performance/noDelete: clear Object.defineProperty-installed own property
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;
}

const originalAllowSignup = config.allowSignup;
const originalSecret = process.env.FORWARDAUTH_TRUST_SECRET;

beforeAll(async () => {
	await initializeDatabase();
});

afterAll(() => {
	(config as Record<string, unknown>).allowSignup = originalAllowSignup;
	setForwardauthConfigured(originalSecret);
});

describe("first-run signup's interaction with a configured forwardauth identity provider", () => {
	beforeEach(resetIdentityState);

	afterEach(() => {
		(config as Record<string, unknown>).allowSignup = originalAllowSignup;
		setForwardauthConfigured(originalSecret);
	});

	test("forwardauth configured, zero local users, no explicit enable → signup closed and allowSignup:false", async () => {
		setForwardauthConfigured("closed-by-default-secret");
		(config as Record<string, unknown>).allowSignup = false;
		await seedSsoUser({ username: `sso:authentik:${crypto.randomUUID().slice(0, 8)}` });

		const app = makeApp();

		const meRes = await app.request("/api/v1/auth/me");
		expect(meRes.status).toBe(200);
		const meBody = (await meRes.json()) as { allowSignup: boolean };
		expect(meBody.allowSignup).toBe(false);

		const signupRes = await app.request("/api/v1/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				username: `first-admin-${crypto.randomUUID().slice(0, 8)}`,
				password: "Sup3rStr0ngP@ss!",
			}),
		});
		expect(signupRes.status).toBe(403);
	});

	test("forwardauth configured, zero local users, explicit enable → signup open", async () => {
		setForwardauthConfigured("explicit-enable-secret");
		(config as Record<string, unknown>).allowSignup = true;
		await seedSsoUser({ username: `sso:authentik:${crypto.randomUUID().slice(0, 8)}` });

		const app = makeApp();

		const meRes = await app.request("/api/v1/auth/me");
		const meBody = (await meRes.json()) as { allowSignup: boolean };
		expect(meBody.allowSignup).toBe(true);

		const signupRes = await app.request("/api/v1/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				username: `first-admin-${crypto.randomUUID().slice(0, 8)}`,
				password: "Sup3rStr0ngP@ss!",
			}),
		});
		expect(signupRes.status).toBe(201);
	});

	test("no forwardauth configured, zero users → signup stays open exactly as before, unaffected by the SSO interaction", async () => {
		setForwardauthConfigured(undefined);
		(config as Record<string, unknown>).allowSignup = true;

		const app = makeApp();

		const meRes = await app.request("/api/v1/auth/me");
		const meBody = (await meRes.json()) as { allowSignup: boolean };
		expect(meBody.allowSignup).toBe(true);

		const signupRes = await app.request("/api/v1/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				username: `first-admin-${crypto.randomUUID().slice(0, 8)}`,
				password: "Sup3rStr0ngP@ss!",
			}),
		});
		expect(signupRes.status).toBe(201);
	});
});

describe('an "sso:"-prefixed username can\'t log in with "!"', () => {
	beforeEach(resetIdentityState);

	test("POST /auth/login with the SSO sentinel hash as the password guess fails", async () => {
		const username = `sso:authentik:login-reject-${crypto.randomUUID().slice(0, 8)}`;
		await seedSsoUser({ username, subject: username });

		const app = makeApp();
		const res = await app.request("/api/v1/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username, password: "!" }),
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Invalid credentials");
	});
});

describe("/auth/me's role for an unpromoted SSO caller is 'user', not an admin role", () => {
	beforeEach(resetIdentityState);

	afterEach(() => {
		setForwardauthConfigured(originalSecret);
	});

	test("GET /auth/me with valid forwardauth headers for a never-seen subject resolves role:'user' — no admin-promotion concept exists yet", async () => {
		setForwardauthConfigured("role-resolve-secret");

		const app = makeApp();
		const subject = `role-resolve-${crypto.randomUUID().slice(0, 8)}`;
		const res = await app.request("/api/v1/auth/me", {
			headers: {
				"X-Authentik-Username": "roleresolveuser",
				"X-Authentik-Uid": subject,
				"X-Authentik-Verify": "role-resolve-secret",
			},
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			authenticated: boolean;
			user: { role: string | null; source: string; userId: string | null; displayName: string };
		};
		expect(body.authenticated).toBe(true);
		expect(body.user.source).toBe("forwardauth");
		expect(body.user.role).toBe("user");
		expect(body.user.userId).toBeTruthy();
		expect(body.user.displayName).toBe("roleresolveuser");
	});
});

describe('a local signup/create-user call with a name like "sso:x" is rejected', () => {
	beforeEach(resetIdentityState);

	afterEach(() => {
		(config as Record<string, unknown>).allowSignup = originalAllowSignup;
		setForwardauthConfigured(originalSecret);
	});

	test("POST /auth/signup with username 'sso:evil' is rejected (400), not created", async () => {
		(config as Record<string, unknown>).allowSignup = true;
		setForwardauthConfigured(undefined);

		const app = makeApp();
		const res = await app.request("/api/v1/auth/signup", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: "sso:evil", password: "Sup3rStr0ngP@ss!" }),
		});
		expect(res.status).toBe(400);

		const { getUserByUsername } = await import("../services/local-auth-service.js");
		const row = await getUserByUsername("sso:evil");
		expect(row).toBeNull();
	});
	// The createUser() half of this pin lives in local-auth-service.test.ts
	// (the natural home for that service function), not here.
});
