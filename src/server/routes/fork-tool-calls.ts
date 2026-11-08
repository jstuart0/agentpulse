/**
 * The person routes for what a fork's tool calls ran (AGEN-123):
 *
 *   GET /sessions/:sessionId/tool-calls
 *   GET /sessions/:sessionId/tool-calls/:toolUseId
 *
 * Mounted with the operator bundle. Both are manage-only for API keys in the scope policy (so observe,
 * respond and ingest keys never reach the handler), and then the handler refuses every API key, manage and
 * admin-owned ones included, with `human_required`: a key in an agent's own configuration is not the person,
 * and this is 7 days of persistent tool output. There is no MCP tool for it (F23). Owner or admin only; an
 * unowned team session is an admin's. Every response is `no-store`, and every body is rebuilt here key by
 * key, so a column the service later gains can't ride out.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type {
	ForkToolCallDto,
	ForkToolCallIndexEntry,
	ForkToolCallIndexList,
	ForkToolCallList,
} from "../../shared/fork-tool-calls.js";
import { type AuthUser, requireAuth } from "../auth/middleware.js";
import { isTrustedHostWhenAuthOff } from "../auth/request-origin.js";
import {
	getRequestActor,
	isHumanCaller,
	requireOperatorScope,
} from "../auth/route-scope-policy.js";
import { config } from "../config.js";
import { logAdminAction } from "../services/audit-log.js";
import {
	ForkToolDetailRefusal,
	type ForkToolDetailRefusalCode,
	type ToolDetailCaller,
	getForkToolCall,
	listForkToolCallIndex,
	listForkToolCalls,
} from "../services/fork-tool-detail.js";

const REFUSAL_STATUS: Readonly<Record<ForkToolDetailRefusalCode, 400 | 403 | 404 | 409 | 503>> = {
	human_required: 403,
	not_owner: 403,
	session_not_found: 404,
	tool_call_not_found: 404,
	invalid_query: 400,
	invalid_body: 400,
	not_a_fork: 409,
	detail_unavailable: 503,
};

function refuse(c: Context, code: ForkToolDetailRefusalCode): Response {
	return c.json({ error: code }, REFUSAL_STATUS[code]);
}

const forkToolCallsRouter = new Hono();
forkToolCallsRouter.use("*", async (c, next) => {
	await next();
	c.header("Cache-Control", "no-store");
});
// With authentication off a page reached through DNS rebinding has Origin equal to Host and could read seven
// days of tool output, so the Host must be this machine or on the allowlist, as for Stop turn (review M3).
forkToolCallsRouter.use("*", async (c, next) => {
	const host = c.req.header("Host");
	if (config.disableAuth && host !== undefined && !isTrustedHostWhenAuthOff(host)) {
		return c.json({ error: "bad_origin" }, 403);
	}
	await next();
});
forkToolCallsRouter.use("*", requireAuth());
forkToolCallsRouter.use("*", requireOperatorScope());

async function callerOf(c: Context): Promise<ToolDetailCaller> {
	const authUser = c.get("authUser") as AuthUser;
	return { actor: await getRequestActor(c), isHuman: isHumanCaller(authUser) };
}

/** One line per successful read of stored tool detail: who, which session, how many calls. Never content. */
function auditRead(c: Context, caller: ToolDetailCaller, sessionId: string, count: number): void {
	const authUser = c.get("authUser") as AuthUser | undefined;
	logAdminAction("fork_tool_detail_read", caller.actor, {
		sessionId,
		count,
		keyId: authUser?.keyId ?? null,
		view: c.req.query("view") === "index" ? "index" : "full",
	});
}

function serializeIndexEntry(call: ForkToolCallIndexEntry): ForkToolCallIndexEntry {
	return {
		toolUseId: call.toolUseId,
		tool: call.tool,
		outcome: call.outcome,
		fromSubagent: call.fromSubagent,
		inputTruncated: call.inputTruncated,
		outputTruncated: call.outputTruncated,
		redacted: call.redacted,
		createdAt: call.createdAt,
	};
}

function serializeCall(call: ForkToolCallDto): ForkToolCallDto {
	return { ...serializeIndexEntry(call), input: call.input, output: call.output };
}

function serializeList(list: ForkToolCallList): ForkToolCallList {
	return { v: 1, calls: list.calls.map(serializeCall), nextBeforeId: list.nextBeforeId };
}

function serializeIndex(list: ForkToolCallIndexList): ForkToolCallIndexList {
	return { v: 1, calls: list.calls.map(serializeIndexEntry), nextBeforeId: list.nextBeforeId };
}

/** `limit` is an integer; anything else, `0` and `101` included, is the service's `invalid_query`. */
function parseLimit(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	return /^\d{1,6}$/.test(raw) ? Number(raw) : Number.NaN;
}

forkToolCallsRouter.get("/sessions/:sessionId/tool-calls", async (c) => {
	try {
		const caller = await callerOf(c);
		const query = {
			beforeId: c.req.query("beforeId"),
			limit: parseLimit(c.req.query("limit")),
			turnActionId: c.req.query("turnActionId"),
		};
		const sessionId = c.req.param("sessionId");
		if (c.req.query("view") === "index") {
			const index = await listForkToolCallIndex(sessionId, caller, query);
			auditRead(c, caller, sessionId, index.calls.length);
			return c.json(serializeIndex(index));
		}
		const list = await listForkToolCalls(sessionId, caller, query);
		auditRead(c, caller, sessionId, list.calls.length);
		return c.json(serializeList(list));
	} catch (error) {
		if (error instanceof ForkToolDetailRefusal) return refuse(c, error.code);
		throw error;
	}
});

forkToolCallsRouter.get("/sessions/:sessionId/tool-calls/:toolUseId", async (c) => {
	try {
		const caller = await callerOf(c);
		const call = await getForkToolCall(c.req.param("sessionId"), c.req.param("toolUseId"), caller);
		auditRead(c, caller, c.req.param("sessionId"), 1);
		return c.json({ v: 1, call: serializeCall(call) });
	} catch (error) {
		if (error instanceof ForkToolDetailRefusal) return refuse(c, error.code);
		throw error;
	}
});

export { forkToolCallsRouter };
