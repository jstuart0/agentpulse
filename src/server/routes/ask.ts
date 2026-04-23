import type { Context } from "hono";
import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { isAiActive, isAiBuildEnabled } from "../services/ai/feature.js";
import {
	archiveThread,
	getThread,
	listMessages,
	listThreads,
	runAskTurn,
} from "../services/ask/ask-service.js";
import { isLabsFlagEnabled } from "../services/labs-service.js";

/**
 * Ask chat: global conversational assistant over the user's sessions.
 * Reuses the default LLM provider configured in Settings → AI. All
 * endpoints require the askAssistant labs flag to be enabled so users
 * who haven't opted in don't accidentally spin up LLM calls.
 */
const askRouter = new Hono();
askRouter.use("/ai/ask/*", requireAuth());
askRouter.use("/ai/ask", requireAuth());

async function ensureEnabled(c: Context) {
	if (!isAiBuildEnabled()) {
		return c.json({ error: "AI feature is not compiled into this build." }, 404);
	}
	if (!(await isAiActive())) {
		return c.json({ error: "AI is disabled at runtime. Enable in Settings → AI." }, 409);
	}
	if (!(await isLabsFlagEnabled("askAssistant"))) {
		return c.json(
			{ error: "Ask is a Labs feature. Enable 'Ask assistant' in Settings → Labs." },
			409,
		);
	}
	return null;
}

askRouter.get("/ai/ask/threads", async (c) => {
	const gate = await ensureEnabled(c);
	if (gate) return gate;
	const threads = await listThreads(50);
	return c.json({ threads });
});

askRouter.get("/ai/ask/threads/:id", async (c) => {
	const gate = await ensureEnabled(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const thread = await getThread(id);
	if (!thread) return c.json({ error: "Thread not found" }, 404);
	const messages = await listMessages(id);
	return c.json({ thread, messages });
});

askRouter.delete("/ai/ask/threads/:id", async (c) => {
	const gate = await ensureEnabled(c);
	if (gate) return gate;
	const id = c.req.param("id") ?? "";
	const ok = await archiveThread(id);
	if (!ok) return c.json({ error: "Thread not found or already archived" }, 404);
	return c.json({ ok: true });
});

askRouter.post("/ai/ask", async (c) => {
	const gate = await ensureEnabled(c);
	if (gate) return gate;
	const body = await c.req.json<{
		threadId?: string | null;
		message?: string;
		sessionIds?: string[];
	}>();
	if (!body.message || typeof body.message !== "string") {
		return c.json({ error: "message required" }, 400);
	}
	try {
		const res = await runAskTurn({
			threadId: body.threadId ?? null,
			message: body.message,
			sessionIds: body.sessionIds,
		});
		return c.json(res);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return c.json({ error: message }, 500);
	}
});

export { askRouter };
