/**
 * forwardauth-bridge.ts — Hono middleware that converts a live forwardauth
 * identity header set into a short-lived `ap_session` cookie so subsequent
 * un-forwardauth'd requests (e.g. `/auth/me`, WS upgrade) resolve the SSO
 * identity through the existing cookie step of `getAuthUserFromHeaders`.
 *
 * Security properties:
 *  - Verifies the trust secret BEFORE reading any identity header (H-1).
 *  - Resolve-then-mint: skips the mint when the existing cookie already matches
 *    the current subject+provider (Decision 3, fixation-safe). Otherwise always
 *    mints fresh, preventing session fixation via a planted cookie.
 *  - Fail closed: on mint failure, revokes the DB row (if any) AND clears the
 *    browser cookie, keyed on the raw cookie string being non-null — an expired
 *    or foreign token still gets cleaned up server-side (xander / M-1 / H-1).
 *  - M-8 / L-2 supersession: when any resolved session is superseded by a new
 *    SSO mint (local OR SSO-mismatch), the old DB row is revoked after a
 *    successful mint so it isn't orphaned.
 *  - L-4 subject guard: subjects longer than 512 chars are rejected (no mint).
 *
 * Mount point: `app.use("*", bridgeForwardauthSession())` in app.ts immediately
 * after `securityHeaders()` and before any api.route(...) or the SPA catch-all
 * (Decision 2 / M-1). This ensures Set-Cookie rides the SPA document response.
 */
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { config } from "../config.js";
import { cookieOptions } from "../routes/auth.js";
import {
	SESSION_COOKIE_NAME,
	SSO_SESSION_DURATION_MS,
	issueSession,
	resolveSessionByToken,
	revokeSessionByToken,
} from "../services/local-auth-service.js";
import { verifyForwardauthSecret } from "./middleware.js";

/** Cookie options for SSO sessions (8h TTL by default; env-tunable). Internal use only. */
function ssoCookieOptions() {
	return cookieOptions(SSO_SESSION_DURATION_MS);
}

export type IssueSessionFn = typeof issueSession;

/**
 * Hono middleware factory. Accepts an optional `deps` object for test-only
 * dependency injection (e.g. a failing `issueSession` to exercise fail-closed).
 * Production code always calls the real `issueSession`.
 */
export function bridgeForwardauthSession(deps: { issueSession?: IssueSessionFn } = {}) {
	const _issueSession = deps.issueSession ?? issueSession;

	return async function bridge(c: Context, next: Next) {
		// 1. Skip when auth is disabled (DISABLE_AUTH=true).
		if (config.disableAuth) {
			return next();
		}

		// 2. Skip when the request didn't traverse forwardauth (no username header).
		//    This covers /auth/me, /auth/login, Bearer API calls — they reach the
		//    app WITHOUT going through the forwardauth upstream, so there are no
		//    identity headers.
		const forwardauthUser = c.req.raw.headers.get(config.forwardauthHeader("username"));
		if (!forwardauthUser) {
			return next();
		}

		// 3. Verify trust secret BEFORE trusting any identity header. The bridge
		//    must verify first (H-1) — forged headers can be injected otherwise.
		const verifyValue = c.req.raw.headers.get(config.forwardauthHeader("verify")) ?? "";
		if (!verifyForwardauthSecret(verifyValue)) {
			// Invalid verify — do NOT mint. The resolver's existing strip/reject
			// logic (in getAuthUserFromHeaders) applies to the current request;
			// this middleware's job is minting for future un-forwardauth'd requests.
			return next();
		}

		// 4. Resolve subject and display username.
		//    uid is stable across renames (Decision 4 open Q2); fall back to username.
		const subject = c.req.raw.headers.get(config.forwardauthHeader("uid")) || forwardauthUser;
		const username = forwardauthUser;
		const provider = config.forwardauthProvider;

		// L-4: Defensive guard — reject abnormally long subjects before touching the DB.
		if (subject.length > 512) {
			console.warn(
				JSON.stringify({
					kind: "forwardauth_bridge_subject_too_long",
					level: "warn",
					length: subject.length,
				}),
			);
			return next();
		}

		// 5. Resolve-then-mint (Decision 3).
		//    Read the raw ap_session cookie string — its PRESENCE (not resolve result)
		//    is what governs fail-closed deletion on mint failure (xander / H-1).
		const rawCookieToken = getCookie(c, SESSION_COOKIE_NAME) ?? null;

		let resolved: Awaited<ReturnType<typeof resolveSessionByToken>> | undefined;
		if (rawCookieToken) {
			resolved = await resolveSessionByToken(rawCookieToken);
		}

		// Skip mint iff the cookie already holds an SSO session for this exact
		// subject+provider. All other cases (no cookie, expired, different
		// subject, different provider, local session) fall through to mint.
		if (
			resolved?.kind === "sso" &&
			resolved.provider === provider &&
			resolved.subject === subject
		) {
			return next();
		}

		// M-8 / L-2: track any resolved session that will be superseded so it
		// can be revoked after a successful mint. `resolved` is non-null only when
		// a real DB row exists — covers both local sessions (M-8) and SSO sessions
		// for a different subject or provider (L-2). Never revoke before mint.
		const oldSupersededToken = resolved != null ? rawCookieToken : null;

		// 6. Mint — wrapped in try/catch for fail-closed behaviour (H-1 / M-1).
		let mintedToken: string | null = null;
		try {
			const { token } = await _issueSession({
				userId: `sso:${subject}`,
				durationMs: SSO_SESSION_DURATION_MS,
				authSource: "forwardauth",
				ssoSubject: subject,
				ssoUsername: username,
				provider,
				userAgent: c.req.header("User-Agent") ?? null,
			});
			mintedToken = token;
		} catch (err) {
			// H-1 / M-1 fail-closed: log the failure; if a raw cookie string was
			// present in the request, revoke its DB row (server-side) then clear the
			// browser cookie so a stale/hostile token can't survive in either place.
			// Key on the raw string being non-null, NOT on the resolve result —
			// an expired/foreign token resolves to null yet must still be cleaned up.
			console.warn(
				JSON.stringify({
					kind: "forwardauth_bridge_mint_failed",
					level: "warn",
					error: String(err),
				}),
			);
			if (rawCookieToken !== null) {
				await revokeSessionByToken(rawCookieToken).catch(() => {});
				deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
			}
			// Current request still resolves inline via step-1 forwardauth headers
			// in getAuthUserFromHeaders — the page loads as the correct user.
			return next();
		}

		// 6 (continued). Set-Cookie BEFORE next() so it rides the SPA document
		// response (or whatever this request is responding with).
		setCookie(c, SESSION_COOKIE_NAME, mintedToken, ssoCookieOptions());

		await next();

		// 7. M-8 / L-2 supersession: revoke the old session AFTER a successful
		// mint+next so it isn't orphaned. Errors here are swallowed — the new SSO
		// session is already issued; a revocation failure is cosmetic.
		if (oldSupersededToken) {
			await revokeSessionByToken(oldSupersededToken).catch(() => {});
		}
	};
}
