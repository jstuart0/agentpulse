/**
 * forwardauth-bridge.ts — Hono middleware that converts a live forwardauth
 * identity header set into a short-lived `ap_session` cookie so subsequent
 * un-forwardauth'd requests (e.g. `/auth/me`, WS upgrade) resolve the SSO
 * identity through the existing cookie step of `getAuthUserFromHeaders`.
 *
 * Security properties:
 *  - Verifies the trust secret before trusting or acting on any identity
 *    header value (H-1). The username header is read first as an early-exit
 *    signal (non-forwardauth request → skip), but no identity value is trusted
 *    or written until after secret verification passes.
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
	peekSessionIdentity,
	revokeSessionByToken,
} from "../services/local-auth-service.js";
import { forwardauthSubject, resolveSsoUser } from "../services/user-identity.js";
import {
	buildForwardauthAuthUser,
	setForwardauthResolvedUser,
	verifyForwardauthSecret,
} from "./middleware.js";

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

		// 4. Resolve subject and display username via the shared helper —
		//    uid is stable across renames and preferred; falls back to username
		//    when the IdP sends no uid. Also carries the L-4 oversized-subject
		//    guard, so this and the inline forwardauth path share one rule.
		const subjectInfo = forwardauthSubject(c.req.raw.headers);
		if (!subjectInfo) {
			console.warn(JSON.stringify({ kind: "forwardauth_bridge_subject_too_long", level: "warn" }));
			return next();
		}
		const { subject, username, source } = subjectInfo;
		const provider = config.forwardauthProvider;

		// 5. Resolve-then-mint (Decision 3).
		//    Read the raw ap_session cookie string — its PRESENCE (not resolve result)
		//    is what governs fail-closed deletion on mint failure (xander / H-1).
		const rawCookieToken = getCookie(c, SESSION_COOKIE_NAME) ?? null;

		// Peek at the cookie's own stored fields — no identity resolve, just
		// the session row's columns — to decide whether a mint is even
		// needed. This must not touch the users table: the common
		// steady-state request (same subject+provider on every page load)
		// resolves the identity exactly once, in the request's own auth
		// middleware below, not here.
		let peeked: Awaited<ReturnType<typeof peekSessionIdentity>> | undefined;
		if (rawCookieToken) {
			peeked = await peekSessionIdentity(rawCookieToken);
		}

		// Skip mint iff the cookie already holds an SSO session for this exact
		// subject+provider. All other cases (no cookie, expired, different
		// subject, different provider, local session) fall through to mint.
		if (peeked?.kind === "sso" && peeked.provider === provider && peeked.subject === subject) {
			return next();
		}

		// M-8 / L-2: track any resolved session that will be superseded so it
		// can be revoked after a successful mint. `peeked` is non-null only when
		// a real DB row exists — covers both local sessions (M-8) and SSO sessions
		// for a different subject or provider (L-2). Never revoke before mint.
		const oldSupersededToken = peeked != null ? rawCookieToken : null;

		// 5b. Resolve the real users.id for this SSO identity before minting —
		// creates the row on first sight, fills a null subject_source once,
		// never recreates or un-disables a disabled row. This is the request's
		// one identity resolve; hand the result to the rest of the request via
		// the shared context key so the route's own auth middleware doesn't
		// resolve it again.
		const ssoUser = await resolveSsoUser({ provider, subject, source, username });
		const resolvedAuthUser = buildForwardauthAuthUser({
			forwardauthUsername: username,
			uid: source === "uid" ? subject : undefined,
			provider,
			ssoUser,
		});
		setForwardauthResolvedUser(c, resolvedAuthUser);
		if (ssoUser.disabled) {
			return next();
		}

		// 6. Mint — wrapped in try/catch for fail-closed behaviour (H-1 / M-1).
		let mintedToken: string | null = null;
		try {
			const { token } = await _issueSession({
				userId: ssoUser.id,
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
			// The current request still resolves correctly: the identity was
			// already resolved above and handed to the rest of the request via
			// the shared context key, independent of whether minting a fresh
			// cookie for future requests succeeded.
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
