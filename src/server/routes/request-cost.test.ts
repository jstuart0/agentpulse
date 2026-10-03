/**
 * Pins how many database statements a request costs, by who made it and in
 * which mode: a cookie, a forwardauth (SSO) request with the session cookie its
 * first request minted, a key owned by a user and an ownerless key, each on a
 * route from the first router in the bundle (sessions stats) and from the last
 * (channels), in solo and in team; and a hook event for a new and for an
 * existing session, in solo and in team.
 *
 * What these numbers say, each measured and pinned as such:
 *  - the owner's state rides on the key lookup, so an owned key costs what an
 *    ownerless one does;
 *  - the mode is read lazily, only by the handlers and policy entries that need
 *    it, so a plain read costs the same in solo and in team;
 *  - the identity is resolved once per request however many routers it crosses
 *    (a channels request used to resolve it once per router before it: 31
 *    statements for a cookie, now 4);
 *  - the hook path's steady state, an event for an existing session from its
 *    owner's key, adds no statement for ownership.
 * The route's own statements are in each number, so it is the differences
 * between callers and modes, and the route-to-route drop, that carry the meaning.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	clearInstanceSettings,
	cookieHeadersFor,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase } = await import("../db/client.js");
const { config } = await import("../config.js");
const { app } = await import("../app.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");
const { processHookEvent } = await import("../services/event-processor.js");

const SECRET = "request-cost-pin-secret";
const originalSecret = process.env.FORWARDAUTH_TRUST_SECRET;

beforeAll(async () => {
	await initializeDatabase();
	process.env.FORWARDAUTH_TRUST_SECRET = SECRET;
	// biome-ignore lint/performance/noDelete: clear Object.defineProperty-installed own property
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;
});

afterAll(() => {
	if (originalSecret === undefined) {
		// biome-ignore lint/performance/noDelete: restoring an absent env var
		delete process.env.FORWARDAUTH_TRUST_SECRET;
	} else {
		process.env.FORWARDAUTH_TRUST_SECRET = originalSecret;
	}
	// biome-ignore lint/performance/noDelete: clear Object.defineProperty-installed own property
	delete (config as Record<string, unknown>)._forwardauthTrustSecret;
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
}
beforeEach(reset);
afterEach(reset);

const STATS = "/api/v1/sessions/stats";
const CHANNELS = "/api/v1/channels";

function ssoHeaders(): Headers {
	return new Headers({
		[config.forwardauthHeader("username")]: "cost-sso",
		[config.forwardauthHeader("uid")]: `cost-sso-${crypto.randomUUID()}`,
		[config.forwardauthHeader("verify")]: SECRET,
	});
}

async function costs(path: string) {
	const admin = await seedLocalUser("rc-admin", "admin");
	const owned = await seedKey("rc-owned", ["ingest", "manage"], admin.id);
	const ownerless = await seedKey("rc-service", ["ingest", "manage"]);
	const request = (headers: Headers) =>
		countDbCalls(async () => {
			const res = await app.request(path, { headers });
			expect(res.status).toBe(200);
		});

	const sso = ssoHeaders();
	const first = await app.request(path, { headers: sso });
	const cookie = first.headers.get("set-cookie")?.split(";")[0] ?? "";
	const steadySso = new Headers(sso);
	steadySso.set("Cookie", cookie);

	return {
		cookie: await request(await cookieHeadersFor(admin.id)),
		sso: await request(steadySso),
		ownedKey: await request(new Headers({ Authorization: `Bearer ${owned.key}` })),
		ownerlessKey: await request(new Headers({ Authorization: `Bearer ${ownerless.key}` })),
	};
}

describe("a plain read, from the first router and from the last", () => {
	for (const mode of ["solo", "team"] as const) {
		test(`${mode}: sessions stats`, async () => {
			if (mode === "team") await setStoredMode("team");
			expect(await costs(STATS)).toEqual({ cookie: 5, sso: 5, ownedKey: 4, ownerlessKey: 4 });
		});

		test(`${mode}: channels (identity resolved once, however many routers it crossed)`, async () => {
			if (mode === "team") await setStoredMode("team");
			expect(await costs(CHANNELS)).toEqual({ cookie: 4, sso: 4, ownedKey: 3, ownerlessKey: 3 });
		});
	}
});

describe("hook ingest", () => {
	for (const mode of ["solo", "team"] as const) {
		test(`${mode}: a new session costs 10, an event for an existing one from its owner's key costs 8`, async () => {
			if (mode === "team") await setStoredMode("team");
			const owner = await seedLocalUser("rc-hook-owner");
			const key = await seedKey("rc-hook-key", ["ingest"], owner.id);
			const ctx = {
				keyId: key.id,
				deliveryId: null,
				origin: "native" as const,
				attribution: { ownerUserId: owner.id, ingestKeyId: key.id },
			};
			const sessionId = `rc-hook-${mode}-${crypto.randomUUID()}`;
			const created = await countDbCalls(async () => {
				await processHookEvent(
					{ session_id: sessionId, hook_event_name: "SessionStart" },
					"claude_code",
					ctx,
				);
			});
			const existing = await countDbCalls(async () => {
				await processHookEvent(
					{ session_id: sessionId, hook_event_name: "PostToolUse" },
					"claude_code",
					ctx,
				);
			});
			expect({ created, existing }).toEqual({ created: 10, existing: 8 });
		});
	}
});

describe("hook ingest from an ownerless key, onto an unowned session", () => {
	for (const mode of ["solo", "team"] as const) {
		test(`${mode}: the commonest path adds no mode read: a new session and an existing one`, async () => {
			if (mode === "team") await setStoredMode("team");
			const key = await seedKey("rc-svc-hook", ["ingest"]);
			const ctx = {
				keyId: key.id,
				deliveryId: null,
				origin: "native" as const,
				attribution: { ownerUserId: null, ingestKeyId: key.id },
			};
			const sessionId = `rc-svc-${mode}-${crypto.randomUUID()}`;
			const created = await countDbCalls(async () => {
				await processHookEvent(
					{ session_id: sessionId, hook_event_name: "SessionStart" },
					"claude_code",
					ctx,
				);
			});
			const existing = await countDbCalls(async () => {
				await processHookEvent(
					{ session_id: sessionId, hook_event_name: "PostToolUse" },
					"claude_code",
					ctx,
				);
			});
			// The same 10 and 8 as an owner's own key: neither the mode nor anything else is read for it.
			expect({ created, existing }).toEqual({ created: 10, existing: 8 });
		});
	}
});
