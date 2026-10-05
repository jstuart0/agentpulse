import type { Context } from "hono";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
	SessionSummaryRefusalBody,
	SummaryRefusalCode,
} from "../../shared/session-summary-view.js";
import type { AuthUser } from "../auth/middleware.js";
import { getRequestActor, getRequestMode, refuseBadOrigin } from "../auth/route-scope-policy.js";
import { isShuttingDown } from "../drain-state.js";
import { SHUTTING_DOWN_RETRY_AFTER_SECONDS } from "../services/ai/session-summary/service-limits.js";
import { isLabsFlagEnabled } from "../services/labs-service.js";
import {
	summaryRetryAfterSeconds,
	tryConsumeSummaryRequest,
} from "../services/session-summary-limit.js";
import {
	getSessionSummaryView,
	requestSummaryGeneration,
} from "../services/session-summary-service.js";
import { OwnTurnBusyError } from "../util/own-turn.js";
import { requireAiActive, requireAiBuild } from "./ai-gates.js";

/**
 * AGEN-69 phase 6: the HTTP surface over the summary service.
 *
 * Scope is decided before any handler here (`requireOperatorScope()` on the AI router: an
 * observe or ingest key is refused first, whatever the AI state, the flag or the id), so a
 * refusal never tells such a key whether a session exists. Each handler then calls its own gates.
 * The service never reads the instance mode, the AI gates, the Labs flag or the request rate:
 * those are decided here.
 */
const aiSessionSummaryRouter = new Hono();

const SESSION_NOT_FOUND = "session_not_found";

/** Still in the shared contract, no longer produced: an unreadable key is a failed attempt. */
type RetiredRefusal = "provider_key_unreadable";

/** The status of each refusal of these routes: the wire contract (`SessionSummaryRefusalBody`). */
const REFUSAL_STATUS: Record<Exclude<SummaryRefusalCode, RetiredRefusal>, ContentfulStatusCode> = {
	ai_disabled: 409,
	ai_paused: 409,
	session_summary_disabled: 409,
	summary_rate_limited: 429,
	shutting_down: 503,
	session_not_found: 404,
	too_little_activity: 409,
	busy: 503,
	no_provider: 409,
	summary_cooldown: 429,
	caller_generation_running: 409,
	spend_cap_reached: 409,
};

/** A refusal in the contract's shape, with `Retry-After` wherever the body names a wait. */
function refuse(c: Context, body: SessionSummaryRefusalBody, status?: ContentfulStatusCode) {
	if (body.retryAfterSeconds !== undefined) c.header("Retry-After", String(body.retryAfterSeconds));
	return c.json(body, status ?? REFUSAL_STATUS[body.error as keyof typeof REFUSAL_STATUS]);
}

/**
 * The shared AI gates answer with a message the contract has no field for; the refusal keeps
 * their status and their code and drops the text.
 */
async function asContractRefusal(c: Context, gate: Response) {
	const { error } = (await gate.json()) as { error: "ai_disabled" | "ai_paused" };
	return refuse(c, { error }, gate.status as ContentfulStatusCode);
}

/** Server-enforced: the Labs flag is the consent gate (D-6). */
async function requireSummaryFlag(c: Context) {
	if (await isLabsFlagEnabled("sessionSummary")) return null;
	return refuse(c, { error: "session_summary_disabled" });
}

/** The user id, else the key id, else the one DISABLE_AUTH operator: whose allowance and whose slot this is. */
function callerSubject(c: Context): string {
	const authUser = c.get("authUser") as AuthUser | undefined;
	return authUser?.userId ?? authUser?.keyId ?? "anon";
}

// GET: build + flag. A stored summary stays readable while AI is switched off or paused (D-5).
// `?poll=1` (and only the value 1) is the polled view: the same view without the stored summary.
aiSessionSummaryRouter.get("/ai/sessions/:sessionId/summary", async (c) => {
	const build = await requireAiBuild(c);
	if (build) return asContractRefusal(c, build);
	const flag = await requireSummaryFlag(c);
	if (flag) return flag;

	let view: Awaited<ReturnType<typeof getSessionSummaryView>>;
	try {
		view = await getSessionSummaryView(c.req.param("sessionId") ?? "", {
			omitStored: c.req.query("poll") === "1",
			subject: callerSubject(c),
		});
	} catch (error) {
		if (!(error instanceof OwnTurnBusyError)) throw error;
		return refuse(c, { error: "busy", retryAfterSeconds: 1 });
	}
	if (!view) return refuse(c, { error: SESSION_NOT_FOUND });
	return c.json(view);
});

// POST: build + runtime-active + flag, then origin, the per-caller limit, shutdown, the service.
// It reads no body. The response goes out at the claim; the run's own promise is not awaited here
// (the service gives it a terminal catch).
aiSessionSummaryRouter.post("/ai/sessions/:sessionId/summary", async (c) => {
	const build = await requireAiBuild(c);
	if (build) return asContractRefusal(c, build);
	const active = await requireAiActive(c);
	if (active) return asContractRefusal(c, active);
	const flag = await requireSummaryFlag(c);
	if (flag) return flag;
	const badOrigin = refuseBadOrigin(c);
	if (badOrigin) return badOrigin;

	const subject = callerSubject(c);
	if (!tryConsumeSummaryRequest(subject)) {
		return refuse(c, {
			error: "summary_rate_limited",
			retryAfterSeconds: summaryRetryAfterSeconds(subject),
		});
	}
	if (isShuttingDown()) {
		return refuse(c, {
			error: "shutting_down",
			retryAfterSeconds: SHUTTING_DOWN_RETRY_AFTER_SECONDS,
		});
	}

	const mode = await getRequestMode(c);
	const result = await requestSummaryGeneration(c.req.param("sessionId") ?? "", {
		subject,
		teamMode: mode === "team",
		actor: await getRequestActor(c, { mode }),
	});
	if (result.kind === "refused") return refuse(c, result.refusal);
	return c.json(result.body, 202);
});

export default aiSessionSummaryRouter;
