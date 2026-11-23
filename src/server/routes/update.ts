import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { isLoopbackHostHeader } from "../auth/request-origin.js";
import { refuseBadOrigin, requireOperatorScope } from "../auth/route-scope-policy.js";
import { config } from "../config.js";
import { checkNow } from "../services/update-check.js";
import { FixedWindowCounter } from "../services/util/fixed-window-counter.js";

/**
 * POST /update/check: look at the release feed now. That is all it does. It doesn't start an update, write
 * a file on any machine or change a setting; every update is the machine's own updater's act, and no server
 * route can start one. Admin in both modes (`ALWAYS_ADMIN_ROUTES`), not human-only: it only reads a public
 * document. It sits in no `SCOPE_GRANTS` entry, so a key needs `manage`.
 */
const updateRouter = new Hono();
updateRouter.use("*", requireAuth());
updateRouter.use("*", requireOperatorScope());

const CHECK_WINDOW_MS = 60_000;
const CHECK_LIMIT = 1;
/** One budget for the whole process: the request is the server's, not the caller's. */
const BUDGET_SUBJECT = "update-check";
const limiter = new FixedWindowCounter(CHECK_WINDOW_MS);

/** Test only: the limiter's clock (null restores the real one). */
export function setUpdateCheckLimiterClockForTests(clock: (() => number) | null): void {
	limiter.setClock(clock);
}

/** Test only: forgets the spent budget. */
export function resetUpdateCheckLimiterForTests(): void {
	limiter.reset();
}

updateRouter.post("/update/check", async (c) => {
	const foreign = refuseBadOrigin(c);
	if (foreign) return foreign;
	// Auth off makes every caller an admin, so the Host is the only thing left to judge, and stricter than
	// the general gate (which admits an IP literal): only a client on this machine may run the check. A
	// missing Host is refused here too.
	if (config.disableAuth && !isLoopbackHostHeader(c.req.header("Host"))) {
		return c.json({ error: "bad_origin" }, 403);
	}
	// Spent only now, after every check that could refuse the call.
	if (!limiter.tryConsume(BUDGET_SUBJECT, CHECK_LIMIT)) {
		c.header(
			"Retry-After",
			String(Math.max(1, Math.ceil(limiter.msUntilWindowEnds(BUDGET_SUBJECT) / 1000))),
		);
		return c.json({ error: "rate_limited" }, 429);
	}
	return c.json({ update: await checkNow() });
});

export { updateRouter };
