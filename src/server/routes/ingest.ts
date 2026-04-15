import { Hono } from "hono";
import { requireApiKey } from "../auth/middleware.js";
import { processHookEvent, detectAgentType, processStatusUpdate } from "../services/event-processor.js";
import { broadcast } from "../ws/handler.js";
import { getSession } from "../services/session-tracker.js";
import type { HookEventPayload, SemanticStatusUpdate } from "../../shared/types.js";

const ingest = new Hono();

// POST /api/v1/hooks - Receive hook events from Claude Code and Codex CLI
ingest.post("/hooks", requireApiKey(), async (c) => {
	try {
		const payload = (await c.req.json()) as HookEventPayload;

		if (!payload.session_id || !payload.hook_event_name) {
			return c.json({ error: "Missing session_id or hook_event_name" }, 400);
		}

		const agentTypeHeader = c.req.header("X-Agent-Type");
		const agentType = detectAgentType(agentTypeHeader, payload);

		const { sessionId, isNew } = await processHookEvent(payload, agentType);

		// Broadcast to WebSocket subscribers
		const session = await getSession(sessionId);
		if (session) {
			broadcast(isNew ? "session_created" : "session_updated", {
				session,
			});

			broadcast("new_event", {
				sessionId,
				eventType: payload.hook_event_name,
				toolName: payload.tool_name,
			});
		}

		return c.json({ ok: true });
	} catch (err) {
		console.error("[ingest] Error processing hook event:", err);
		return c.json({ ok: true }); // Always return 200 to not block the agent
	}
});

// POST /api/v1/hooks/status - Receive semantic status updates
ingest.post("/hooks/status", requireApiKey(), async (c) => {
	try {
		const update = (await c.req.json()) as SemanticStatusUpdate;

		if (!update.session_id) {
			return c.json({ error: "Missing session_id" }, 400);
		}

		const success = await processStatusUpdate(update);

		if (success) {
			const session = await getSession(update.session_id);
			if (session) {
				broadcast("session_updated", { session });
			}
		}

		return c.json({ ok: true });
	} catch (err) {
		console.error("[ingest] Error processing status update:", err);
		return c.json({ ok: true });
	}
});

export { ingest };
