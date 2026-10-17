import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getTrustedClientIp } from "../auth/client-ip.js";
import { type AuthUser, parseCookieHeader, requireAuth } from "../auth/middleware.js";
import {
	getRequestActor,
	refuseBadOrigin,
	requireOperatorScope,
} from "../auth/route-scope-policy.js";
import { tryConsumeKeyMint } from "../services/key-mint-limit.js";
import { SESSION_COOKIE_NAME, hashToken } from "../services/local-auth-service.js";
import {
	InvalidPairingCodeError,
	PAIRING_ACCESS,
	type PairingAccess,
	getPairingCodeStatus,
	mintPairingCode,
	redeemPairingCode,
} from "../services/pairing-service.js";

/** A pairing request is a few short fields. */
const PAIR_BODY_LIMIT_BYTES = 4 * 1024;

// ── Minting and status: in the operator bundle ───────────────────────────────

const pairingCodesRouter = new Hono();
pairingCodesRouter.use("*", requireAuth());
// Manage-only: a person signed in, or a manage key. Observe and respond keys
// can't mint a credential.
pairingCodesRouter.use("*", requireOperatorScope());

/** Whose mint allowance a code counts against: the person, else the key. */
function mintSubject(authUser: AuthUser): string {
	if (authUser.userId !== null) return `user:${authUser.userId}`;
	return `key:${authUser.keyId ?? "anonymous"}`;
}

/**
 * The credential this request is made with, as a code remembers it: the API key,
 * else the session cookie (by hash). Null for a caller with neither.
 */
function minterCredentialOf(c: Context, authUser: AuthUser): string | null {
	if (authUser.keyId) return `key:${authUser.keyId}`;
	const token = parseCookieHeader(c.req.header("Cookie") ?? null, SESSION_COOKIE_NAME);
	return token ? `session:${hashToken(token)}` : null;
}

function isAccess(value: unknown): value is PairingAccess {
	return typeof value === "string" && (PAIRING_ACCESS as readonly string[]).includes(value);
}

// POST /api/v1/pairing-codes - { access: "full" | "respond", deviceLabel? }.
// The code is shown once, here; only its hash is stored. The phone that redeems
// it gets a key owned by the caller (or an ownerless one if the caller has no
// user, which in team mode needs an admin, as POST /api-keys does).
pairingCodesRouter.post("/pairing-codes", async (c: Context) => {
	const refusal = refuseBadOrigin(c);
	if (refusal) return refusal;
	const body = (await c.req.json().catch(() => null)) as {
		access?: unknown;
		deviceLabel?: unknown;
	} | null;
	if (!body || !isAccess(body.access)) return c.json({ error: "invalid_access" }, 400);

	const authUser = c.get("authUser") as AuthUser;
	if (!tryConsumeKeyMint(mintSubject(authUser))) {
		c.header("Retry-After", "60");
		return c.json({ error: "rate_limited" }, 429);
	}
	const actor = await getRequestActor(c);
	if (authUser.userId === null && actor.mode === "team" && actor.role !== "admin") {
		return c.json({ error: "admin_required" }, 403);
	}

	const minted = await mintPairingCode({
		userId: authUser.userId,
		access: body.access,
		deviceLabel: typeof body.deviceLabel === "string" ? body.deviceLabel : null,
		minterCredential: minterCredentialOf(c, authUser),
	});
	console.log(
		JSON.stringify({
			kind: "pairing_code_minted",
			level: "info",
			codeId: minted.id,
			by: authUser.userId,
			access: body.access,
		}),
	);
	c.header("Cache-Control", "no-store");
	return c.json({ id: minted.id, code: minted.code, expiresAt: minted.expiresAt }, 201);
});

// GET /api/v1/pairing-codes/:id - pending / redeemed / expired, for the person
// who minted it (anyone else gets the 404 a missing id gets).
pairingCodesRouter.get("/pairing-codes/:id", async (c: Context) => {
	const authUser = c.get("authUser") as AuthUser;
	const status = await getPairingCodeStatus(c.req.param("id") ?? "", {
		userId: authUser.userId,
		credential: minterCredentialOf(c, authUser),
	});
	if (!status) return c.json({ error: "not_found" }, 404);
	c.header("Cache-Control", "no-store");
	return c.json(status);
});

// ── Redemption: public, root-mounted ─────────────────────────────────────────

const pairRouter = new Hono();

// POST /api/v1/pair - { code, deviceName, platform } -> 201 { key, keyId, scopes }.
// Unauthenticated by design: the code is the credential. Every failure, a
// malformed body included, is the same 400 invalid_code.
pairRouter.post(
	"/pair",
	bodyLimit({
		maxSize: PAIR_BODY_LIMIT_BYTES,
		onError: (c) => {
			c.header("Cache-Control", "no-store");
			return c.json({ error: "invalid_code" }, 400);
		},
	}),
	async (c: Context) => {
		const body = (await c.req.json().catch(() => null)) as {
			code?: unknown;
			deviceName?: unknown;
			platform?: unknown;
		} | null;
		c.header("Cache-Control", "no-store");
		try {
			const paired = await redeemPairingCode({
				code: body?.code,
				deviceName: body?.deviceName,
				platform: body?.platform,
				ip: getTrustedClientIp(c),
			});
			return c.json(paired, 201);
		} catch (err) {
			if (err instanceof InvalidPairingCodeError) return c.json({ error: "invalid_code" }, 400);
			throw err;
		}
	},
);

export { pairingCodesRouter, pairRouter };
