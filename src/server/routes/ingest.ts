import { Hono } from "hono";
import { requireApiKey } from "../auth/middleware.js";
import { processHookEvent, detectAgentType, processStatusUpdate } from "../services/event-processor.js";
import { notifyChannel, notifySessionCreated, notifySessionUpdated } from "../services/notifier.js";
import { getSession } from "../services/session-tracker.js";
import { normalizeHookEvent } from "../services/event-normalizer.js";
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
			if (isNew) {
				notifySessionCreated(session);
			} else {
				notifySessionUpdated(session);
			}

			for (const event of normalizeHookEvent(payload, agentType)) {
				notifyChannel("new_event", {
					id: 0,
					sessionId,
					eventType: event.eventType,
					category: event.category,
					content: event.content,
					isNoise: event.isNoise,
					providerEventType: event.providerEventType,
					toolName: event.toolName,
					toolInput: event.toolInput,
					toolResponse: event.toolResponse,
					rawPayload: event.rawPayload,
					createdAt: new Date().toISOString(),
				});
			}
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
				notifySessionUpdated(session);
			}
		}

		return c.json({ ok: true });
	} catch (err) {
		console.error("[ingest] Error processing status update:", err);
		return c.json({ ok: true });
	}
});

export { ingest };
