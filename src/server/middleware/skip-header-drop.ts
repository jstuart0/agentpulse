/**
 * Drops a hook delivery whose X-AgentPulse-Skip header says "don't keep this".
 *
 * A Claude Code HTTP hook in direct mode can't apply directory rules on the
 * user's machine, but it can send the skip header. The server honours it with
 * the same allowlist as every other evaluator (isSkipValue; the header form
 * also caps the length it will look at): the answer is 200 {ok:true}, the body
 * is never read, no rate-limit token is spent, nothing is stored, and the drop
 * is counted on /health. The request has already left the machine: this keeps
 * the delivery out of the database, it does not keep it off the network.
 *
 * It is registered with `ingest.use(path, skipHeaderDrop())`, ahead of the
 * route's own handlers, and authenticates a skip request itself with the same
 * requireApiKey() those routes use, so an unauthenticated request still gets
 * its 401/403 and a skip header is never a way around the key. A request
 * without an allowlisted header is passed on untouched and authenticated once,
 * by the route, exactly as before.
 */
import type { Context, Next } from "hono";
import { isSkipHeaderValue } from "../../shared/exclude-rules.js";
import { SKIP_HEADER } from "../../shared/hook-headers.js";
import { requireApiKey } from "../auth/middleware.js";
import { incrementSkipHeaderDropped } from "../routes/ingest-counters.js";

/**
 * A skip request is authenticated here, by requireApiKey() alone, and answered
 * without reaching the route. So any further check the route makes AFTER its own
 * key check (for example that the key may write to this session id) does not run
 * for a skip request. That is deliberate and safe: a skip request stores,
 * updates and broadcasts nothing, for any session id, so there is nothing for
 * such a check to protect. Anything that makes a skip request change state
 * must move this check behind the same rules the route applies. Pinned by
 * "a skip request from any valid ingest key for any session id changes nothing"
 * in ingest-skip-header.test.ts.
 */
export function skipHeaderDrop() {
	const authenticate = requireApiKey();
	return async (c: Context, next: Next) => {
		if (!isSkipHeaderValue(c.req.header(SKIP_HEADER))) return next();

		let authenticated = false;
		const refusal = await authenticate(c, async () => {
			authenticated = true;
		});
		if (!authenticated) return refusal as Response;

		incrementSkipHeaderDropped();
		return c.json({ ok: true });
	};
}
