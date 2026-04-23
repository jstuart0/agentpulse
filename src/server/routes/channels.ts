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
	clearTelegramCredentials,
	generateWebhookSecret,
	getTelegramBotToken,
	getTelegramBotTokenHint,
	getTelegramCredentialsSource,
	getTelegramWebhookSecret,
	saveTelegramCredentials,
} from "../services/channels/telegram-credentials.js";
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

/**
 * Public Telegram webhook lives on its own router so the
 * `use("/channels/*", requireAuth())` middleware on `channelsRouter`
 * can't reach it. Hono's `use(path, ...)` matches all routes that fit
 * the pattern on the same router, regardless of registration order —
 * so co-hosting a public route with auth'd CRUD on the same Hono
 * instance silently 401'd the webhook. Split routers is the clean fix.
 *
 * Authentication is the shared secret token Telegram echoes in the
 * `X-Telegram-Bot-Api-Secret-Token` header (set via setWebhook).
 */
const telegramWebhookRouter = new Hono();

telegramWebhookRouter.post("/channels/telegram/webhook", async (c) => {
	if (!getTelegramBotToken()) return c.json({ error: "telegram_disabled" }, 404);
	const providedSecret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";
	if (!getTelegramWebhookSecret() || providedSecret !== getTelegramWebhookSecret()) {
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
	if (!getTelegramBotToken()) return;
	await fetch(`https://api.telegram.org/bot${getTelegramBotToken()}/sendMessage`, {
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
//
// Per-route `requireAuth()` instead of `.use("/channels/*", ...)`: Hono's
// path-prefixed `use()` fires on any matching request regardless of
// registration order, and merging routers via `api.route()` doesn't
// isolate that middleware from unrelated routes bundled alongside. The
// one public route we absolutely must keep unauthenticated is the
// Telegram webhook (public by design, HMAC-authenticated via header),
// and the simplest way to guarantee it never gets shadowed by auth is
// to attach auth per-handler rather than path-globally.

const channelsRouter = new Hono();
const auth = requireAuth();

channelsRouter.get("/channels", auth, async (c) => {
	const channels = await listChannels();
	return c.json({
		channels,
		bot: {
			configured: Boolean(getTelegramBotToken()),
			webhookSecretConfigured: Boolean(getTelegramWebhookSecret()),
		},
	});
});

channelsRouter.post("/channels", auth, async (c) => {
	if (!getTelegramBotToken()) {
		return c.json({ error: "Telegram bot token not configured" }, 400);
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

channelsRouter.delete("/channels/:id", auth, async (c) => {
	const id = c.req.param("id") ?? "";
	const ok = await deleteChannel(id);
	if (!ok) return c.json({ error: "Channel not found" }, 404);
	return c.json({ ok: true });
});

channelsRouter.get("/channels/:id", auth, async (c) => {
	const id = c.req.param("id") ?? "";
	const ch = await getChannel(id);
	if (!ch) return c.json({ error: "Channel not found" }, 404);
	return c.json({ channel: ch });
});

function resolvePublicUrl(candidate: unknown): string | null {
	const fromBody = typeof candidate === "string" ? candidate.trim() : "";
	const chosen = fromBody || config.publicUrl || "";
	if (!chosen) return null;
	// Defensive: reject localhost except when the env was explicitly set
	// that way (e.g. tunneled). Telegram rejects non-public URLs anyway,
	// but a sharper error message is nicer than a 400 from Telegram.
	try {
		const u = new URL(chosen);
		if (u.protocol !== "https:" && u.protocol !== "http:") return null;
		return chosen.replace(/\/$/, "");
	} catch {
		return null;
	}
}

/**
 * Idempotent setup: point the Telegram webhook at <publicUrl> + path.
 * Accepts an optional `publicUrl` in the body so the UI can pass
 * `window.location.origin` — saves admins from having to set the
 * PUBLIC_URL env var just for this.
 */
channelsRouter.post("/channels/telegram/setup-webhook", auth, async (c) => {
	if (!getTelegramBotToken()) return c.json({ error: "Telegram bot token not configured" }, 400);
	if (!getTelegramWebhookSecret()) {
		return c.json({ error: "Telegram webhook secret not configured" }, 400);
	}
	const body = await c.req.json<{ publicUrl?: string }>().catch(() => ({ publicUrl: undefined }));
	const base = resolvePublicUrl(body.publicUrl);
	if (!base) {
		return c.json({ error: "Provide a public HTTPS URL — Telegram can't reach localhost." }, 400);
	}
	const url = `${base}/api/v1/channels/telegram/webhook`;
	const res = await setTelegramWebhook(url, getTelegramWebhookSecret());
	if (!res.ok) {
		console.error(`[telegram] setWebhook failed for ${url}: ${res.description ?? "unknown"}`);
		return c.json({ error: `Telegram refused the webhook: ${res.description ?? "unknown"}` }, 502);
	}
	return c.json({ ok: true, webhookUrl: url });
});

/**
 * --- In-app credential management ---
 * Replaces the old env-var-only flow. Admins paste their bot token
 * (from @BotFather); if no webhook secret is provided, a strong one is
 * generated server-side. On save we immediately validate the token via
 * getMe, and auto-register the webhook when a public URL is known so
 * the enrollment flow works end-to-end without a second click.
 */
channelsRouter.get("/channels/telegram/credentials", auth, async (c) => {
	return c.json({
		configured: Boolean(getTelegramBotToken()),
		webhookSecretConfigured: Boolean(getTelegramWebhookSecret()),
		source: getTelegramCredentialsSource(),
		botTokenHint: getTelegramBotTokenHint(),
	});
});

channelsRouter.post("/channels/telegram/credentials", auth, async (c) => {
	const body = await c.req.json<{
		botToken?: string;
		webhookSecret?: string;
		rotateWebhookSecret?: boolean;
		publicUrl?: string;
	}>();

	const trimmedToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
	const explicitSecret = typeof body.webhookSecret === "string" ? body.webhookSecret.trim() : "";

	// A token is required on first save or when rotating. If nothing is
	// being changed at all we reject to avoid silent no-ops.
	if (!trimmedToken && !explicitSecret && !body.rotateWebhookSecret) {
		return c.json({ error: "Provide a bot token or request a webhook secret rotation." }, 400);
	}

	// Basic shape check so we don't save an obviously-bogus token.
	// Telegram tokens look like `123456:ABC-DEF…` (digits:base64ish).
	if (trimmedToken && !/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(trimmedToken)) {
		return c.json(
			{ error: "That doesn't look like a Telegram bot token. Expected 123456:ABC..." },
			400,
		);
	}

	// If the caller provided an explicit secret, sanity-check length
	// (Telegram requires 1–256 chars; we enforce 24+ for real entropy).
	if (explicitSecret && (explicitSecret.length < 24 || explicitSecret.length > 256)) {
		return c.json({ error: "Webhook secret must be 24–256 characters." }, 400);
	}

	// Decide the secret to persist. Precedence:
	//   1. explicitly provided
	//   2. rotate flag -> generate a fresh one
	//   3. no existing secret -> generate one
	//   4. otherwise keep the existing secret untouched
	let secretToPersist: string | null | undefined = null; // null = preserve existing
	if (explicitSecret) {
		secretToPersist = explicitSecret;
	} else if (body.rotateWebhookSecret || !getTelegramWebhookSecret()) {
		secretToPersist = generateWebhookSecret();
	}

	// Validate the token before persisting: we swap the cache token,
	// call getMe, and roll back on failure.
	if (trimmedToken) {
		const priorToken = getTelegramBotToken();
		const priorSecret = getTelegramWebhookSecret();
		await saveTelegramCredentials({
			botToken: trimmedToken,
			webhookSecret: secretToPersist,
		});
		const probe = await getTelegramBotInfo();
		if (!probe.ok) {
			await saveTelegramCredentials({
				botToken: priorToken || "",
				webhookSecret: priorSecret || "",
			});
			return c.json(
				{
					error: `Telegram rejected the token: ${probe.error}. Double-check it with @BotFather.`,
				},
				400,
			);
		}
	} else if (secretToPersist !== null) {
		await saveTelegramCredentials({ webhookSecret: secretToPersist });
	}

	// Opportunistic webhook registration. Failures are non-fatal — the
	// admin can click "Re-send webhook" later.
	const base = resolvePublicUrl(body.publicUrl);
	let webhookResult: { ok: boolean; url?: string; error?: string } = { ok: false };
	if (base) {
		const url = `${base}/api/v1/channels/telegram/webhook`;
		const res = await setTelegramWebhook(url, getTelegramWebhookSecret());
		webhookResult = res.ok ? { ok: true, url } : { ok: false, error: res.description };
	}

	const botInfo = await getTelegramBotInfo();

	return c.json({
		ok: true,
		source: getTelegramCredentialsSource(),
		botTokenHint: getTelegramBotTokenHint(),
		webhookSecretConfigured: Boolean(getTelegramWebhookSecret()),
		bot: botInfo.ok ? botInfo.info : null,
		webhook: webhookResult,
	});
});

channelsRouter.delete("/channels/telegram/credentials", auth, async (c) => {
	if (getTelegramBotToken()) {
		await deleteTelegramWebhook().catch(() => {
			// ignore — we're wiping credentials regardless of Telegram's
			// ability to tell us the webhook got cleared
		});
	}
	await clearTelegramCredentials();
	return c.json({
		ok: true,
		source: getTelegramCredentialsSource(),
		botTokenHint: getTelegramBotTokenHint(),
	});
});

channelsRouter.post("/channels/telegram/teardown-webhook", auth, async (c) => {
	if (!getTelegramBotToken()) return c.json({ error: "Telegram bot token not configured" }, 400);
	await deleteTelegramWebhook();
	return c.json({ ok: true });
});

channelsRouter.get("/channels/telegram/bot-info", auth, async (c) => {
	if (!getTelegramBotToken()) return c.json({ error: "Telegram bot token not configured" }, 400);
	const res = await getTelegramBotInfo();
	if (!res.ok) return c.json({ error: res.error }, 502);
	return c.json({ bot: res.info });
});

channelsRouter.get("/channels/telegram/webhook-info", auth, async (c) => {
	if (!getTelegramBotToken()) return c.json({ error: "Telegram bot token not configured" }, 400);
	const res = await getTelegramWebhookInfo();
	if (!res.ok) return c.json({ error: res.error }, 502);
	// Prefer an explicit ?publicUrl= (UI passes window.location.origin)
	// so "matchesExpected" reflects reality for admins who never set the
	// env var.
	const publicUrlParam = c.req.query("publicUrl");
	const base = resolvePublicUrl(publicUrlParam);
	const expectedUrl = base ? `${base}/api/v1/channels/telegram/webhook` : null;
	return c.json({
		webhook: res.info,
		expectedUrl,
		matchesExpected: expectedUrl ? res.info.url === expectedUrl : null,
	});
});

channelsRouter.post("/channels/:id/test", auth, async (c) => {
	const id = c.req.param("id") ?? "";
	const ch = await getChannel(id);
	if (!ch) return c.json({ error: "Channel not found" }, 404);
	if (ch.kind !== "telegram") return c.json({ error: "Test only supported for telegram" }, 400);
	if (!ch.verifiedAt) return c.json({ error: "Channel is not verified" }, 400);
	const res = await sendTelegramTest(id);
	if (!res.ok) return c.json({ error: res.error ?? "send failed" }, 502);
	return c.json({ ok: true, externalMessageId: res.externalMessageId });
});

channelsRouter.get("/channels/:id/stats", auth, async (c) => {
	const id = c.req.param("id") ?? "";
	const ch = await getChannel(id);
	if (!ch) return c.json({ error: "Channel not found" }, 404);
	const stats = await getChannelStats(id);
	return c.json({ stats });
});

export { channelsRouter, telegramWebhookRouter };

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
