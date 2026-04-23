import { Hono } from "hono";
import { requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";
import { emitAiEvent } from "../services/ai/ai-events.js";
import { getHitlRequest, resolveHitlRequest } from "../services/ai/hitl-service.js";
import {
	completeEnrollment,
	createPendingChannel,
	deleteChannel,
	findActiveChannelByChatId,
	findPendingByEnrollmentCode,
	getChannel,
	getChannelStats,
	listChannels,
} from "../services/channels/channels-service.js";
import {
	answerCallbackQuery,
	deleteTelegramWebhook,
	getTelegramBotInfo,
	getTelegramWebhookInfo,
	sendTelegramPlain,
	sendTelegramTest,
	setTelegramWebhook,
} from "../services/channels/telegram.js";
import { parseHitlCallbackData } from "../services/channels/types.js";

const channelsRouter = new Hono();

/**
 * --- Public Telegram webhook ---
 * Registered BEFORE requireAuth middleware so Telegram's callback can
 * reach us. Authentication is the shared secret token header Telegram
 * echoes back (set via setWebhook).
 */
channelsRouter.post("/channels/telegram/webhook", async (c) => {
	if (!config.telegramBotToken) return c.json({ error: "telegram_disabled" }, 404);
	const providedSecret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";
	if (!config.telegramWebhookSecret || providedSecret !== config.telegramWebhookSecret) {
		return c.json({ error: "invalid secret" }, 401);
	}

	const update = (await c.req.json().catch(() => null)) as TelegramUpdate | null;
	if (!update) return c.json({ ok: true });

	// Enrollment: `/start <code>` DM from a new user.
	if (update.message?.text?.startsWith("/start ")) {
		await handleEnrollmentStart(update.message);
		return c.json({ ok: true });
	}

	// HITL resolve: callback_query with encoded data.
	if (update.callback_query) {
		await handleHitlCallback(update.callback_query);
		return c.json({ ok: true });
	}

	return c.json({ ok: true });
});

async function handleEnrollmentStart(message: TelegramMessage): Promise<void> {
	const code = (message.text ?? "").slice("/start ".length).trim();
	if (!code) return;
	const pending = await findPendingByEnrollmentCode(code);
	if (!pending) {
		await sendEnrollmentReply(
			String(message.chat.id),
			"That enrollment code is invalid or has already been used.",
		);
		return;
	}
	await completeEnrollment({ channelId: pending.id, chatId: String(message.chat.id) });
	await sendEnrollmentReply(
		String(message.chat.id),
		`✅ Linked to AgentPulse channel "${pending.label}". You'll get HITL requests here.`,
	);
}

async function sendEnrollmentReply(chatId: string, text: string): Promise<void> {
	if (!config.telegramBotToken) return;
	await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chat_id: chatId, text }),
	}).catch(() => {
		// ignore
	});
}

async function handleHitlCallback(cb: TelegramCallbackQuery): Promise<void> {
	const data = parseHitlCallbackData(cb.data ?? "");
	if (!data) {
		await answerCallbackQuery(cb.id, "Unknown action.");
		return;
	}
	const hitl = await getHitlRequest(data.hitlId);
	if (!hitl) {
		await answerCallbackQuery(cb.id, "HITL not found.");
		return;
	}
	// Verify the callback's chat belongs to the channel tied to this HITL —
	// prevents a malicious user who learns a hitl id from acting on it.
	if (hitl.channelId) {
		const matchingChannel = await findActiveChannelByChatId(String(cb.message?.chat.id ?? ""));
		if (!matchingChannel || matchingChannel.id !== hitl.channelId) {
			await answerCallbackQuery(cb.id, "Not authorized.");
			return;
		}
	}
	if (hitl.status !== "awaiting_reply") {
		await answerCallbackQuery(cb.id, "Already resolved.");
		return;
	}
	const resolved = await resolveHitlRequest({
		id: hitl.id,
		status: data.action === "decline" ? "declined" : "applied",
		replyKind: data.action,
	});
	if (!resolved) {
		await answerCallbackQuery(cb.id, "Could not resolve.");
		return;
	}
	await answerCallbackQuery(cb.id, data.action === "approve" ? "Approved ✓" : "Declined ✗");
	// Emit audit events mirroring the in-app approve/decline flow.
	await emitAiEvent({
		sessionId: hitl.sessionId,
		category: "ai_hitl_response",
		eventType: "AiHitlResponse",
		content: data.action === "approve" ? "Approved via Telegram." : "Declined via Telegram.",
		rawPayload: { proposal_id: hitl.proposalId, action: data.action, channel: "telegram" },
	});
	if (data.action === "approve") {
		await emitAiEvent({
			sessionId: hitl.sessionId,
			category: "ai_continue_sent",
			eventType: "AiContinueSent",
			content: "Approved via Telegram.",
			rawPayload: { proposal_id: hitl.proposalId, action: "approve", channel: "telegram" },
		});
	}
	if (hitl.channelId) {
		await sendTelegramPlain(
			hitl.channelId,
			data.action === "approve" ? "✅ Approved. Prompt forwarded." : "❌ Declined.",
		);
	}
}

// --- Authenticated admin CRUD below ---

channelsRouter.use("/channels", requireAuth());
channelsRouter.use("/channels/*", requireAuth());

channelsRouter.get("/channels", async (c) => {
	const channels = await listChannels();
	return c.json({
		channels,
		bot: {
			configured: Boolean(config.telegramBotToken),
			webhookSecretConfigured: Boolean(config.telegramWebhookSecret),
		},
	});
});

channelsRouter.post("/channels", async (c) => {
	if (!config.telegramBotToken) {
		return c.json({ error: "TELEGRAM_BOT_TOKEN not configured" }, 400);
	}
	const body = await c.req.json<{
		kind: "telegram";
		label?: string;
	}>();
	if (body.kind !== "telegram") return c.json({ error: "Unsupported kind" }, 400);
	const result = await createPendingChannel({
		kind: "telegram",
		label: (body.label ?? "Telegram").slice(0, 80),
	});
	return c.json(
		{
			channel: result.channel,
			enrollmentCode: result.enrollmentCode,
			instructions: `Open Telegram and send \`/start ${result.enrollmentCode}\` to the bot.`,
		},
		201,
	);
});

channelsRouter.delete("/channels/:id", async (c) => {
	const id = c.req.param("id") ?? "";
	const ok = await deleteChannel(id);
	if (!ok) return c.json({ error: "Channel not found" }, 404);
	return c.json({ ok: true });
});

channelsRouter.get("/channels/:id", async (c) => {
	const id = c.req.param("id") ?? "";
	const ch = await getChannel(id);
	if (!ch) return c.json({ error: "Channel not found" }, 404);
	return c.json({ channel: ch });
});

/**
 * Idempotent setup: point the Telegram webhook at PUBLIC_URL + path.
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET. Admins run
 * this once after configuring the bot in BotFather.
 */
channelsRouter.post("/channels/telegram/setup-webhook", async (c) => {
	if (!config.telegramBotToken) return c.json({ error: "TELEGRAM_BOT_TOKEN not set" }, 400);
	if (!config.telegramWebhookSecret) {
		return c.json({ error: "TELEGRAM_WEBHOOK_SECRET not set" }, 400);
	}
	if (!config.publicUrl) return c.json({ error: "PUBLIC_URL not set" }, 400);
	const url = `${config.publicUrl.replace(/\/$/, "")}/api/v1/channels/telegram/webhook`;
	const res = await setTelegramWebhook(url, config.telegramWebhookSecret);
	if (!res.ok) return c.json({ error: res.description ?? "setWebhook failed" }, 502);
	return c.json({ ok: true, webhookUrl: url });
});

channelsRouter.post("/channels/telegram/teardown-webhook", async (c) => {
	if (!config.telegramBotToken) return c.json({ error: "TELEGRAM_BOT_TOKEN not set" }, 400);
	await deleteTelegramWebhook();
	return c.json({ ok: true });
});

channelsRouter.get("/channels/telegram/bot-info", async (c) => {
	if (!config.telegramBotToken) return c.json({ error: "TELEGRAM_BOT_TOKEN not set" }, 400);
	const res = await getTelegramBotInfo();
	if (!res.ok) return c.json({ error: res.error }, 502);
	return c.json({ bot: res.info });
});

channelsRouter.get("/channels/telegram/webhook-info", async (c) => {
	if (!config.telegramBotToken) return c.json({ error: "TELEGRAM_BOT_TOKEN not set" }, 400);
	const res = await getTelegramWebhookInfo();
	if (!res.ok) return c.json({ error: res.error }, 502);
	const expectedUrl = config.publicUrl
		? `${config.publicUrl.replace(/\/$/, "")}/api/v1/channels/telegram/webhook`
		: null;
	return c.json({
		webhook: res.info,
		expectedUrl,
		matchesExpected: expectedUrl ? res.info.url === expectedUrl : null,
	});
});

channelsRouter.post("/channels/:id/test", async (c) => {
	const id = c.req.param("id") ?? "";
	const ch = await getChannel(id);
	if (!ch) return c.json({ error: "Channel not found" }, 404);
	if (ch.kind !== "telegram") return c.json({ error: "Test only supported for telegram" }, 400);
	if (!ch.verifiedAt) return c.json({ error: "Channel is not verified" }, 400);
	const res = await sendTelegramTest(id);
	if (!res.ok) return c.json({ error: res.error ?? "send failed" }, 502);
	return c.json({ ok: true, externalMessageId: res.externalMessageId });
});

channelsRouter.get("/channels/:id/stats", async (c) => {
	const id = c.req.param("id") ?? "";
	const ch = await getChannel(id);
	if (!ch) return c.json({ error: "Channel not found" }, 404);
	const stats = await getChannelStats(id);
	return c.json({ stats });
});

export { channelsRouter };

// --- Telegram update types (minimal, typed by hand so we don't pull in a lib) ---

interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

interface TelegramMessage {
	message_id: number;
	chat: { id: number; type: string };
	text?: string;
	from?: { id: number; username?: string };
}

interface TelegramCallbackQuery {
	id: string;
	data?: string;
	message?: TelegramMessage;
	from: { id: number; username?: string };
}
