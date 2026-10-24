import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TELEGRAM_ACTOR } from "../auth/actor.js";
import { type AuthUser, requireAuth } from "../auth/middleware.js";
import {
	getRequestActor,
	isHumanCaller,
	refuseBadOrigin,
	requireOperatorScope,
} from "../auth/route-scope-policy.js";
import { config } from "../config.js";
import { getDb } from "../db/client.js";
import { users } from "../db/schema/index.js";
import { getActionRequest, resolveActionRequest } from "../services/ai/action-requests-service.js";
import { isAiActive, isAiBuildEnabled } from "../services/ai/feature.js";
import { getHitlRequest } from "../services/ai/hitl-service.js";
import { resolveProposal } from "../services/ai/proposal-resolution.js";
import {
	ASK_MESSAGE_MAX_CHARS,
	findOrCreateTelegramThread,
	runAskTurn,
} from "../services/ask/ask-service.js";
import { AskBusyError, acquireAskTurn } from "../services/ask/ask-turn-limiter.js";
import { logAdminAction } from "../services/audit-log.js";
import {
	NotOwnerError,
	assertCanDecideProposal,
	assertCanManageChannel,
} from "../services/authorization.js";
import {
	completeEnrollment,
	createPendingChannel,
	deleteChannel,
	findPendingByEnrollmentCode,
	getChannel,
	getChannelCredential,
	getChannelStats,
	listChannels,
	relinkChannel,
	relinkReason,
	updateChannelConfig,
} from "../services/channels/channels-service.js";
import {
	type TelegramCallerResult,
	authorizeTelegramCaller,
} from "../services/channels/telegram-caller.js";
import {
	type TelegramDeliveryMode,
	clearTelegramCredentials,
	generateWebhookSecret,
	getTelegramBotToken,
	getTelegramBotTokenHint,
	getTelegramCredentialsSource,
	getTelegramDeliveryMode,
	getTelegramWebhookSecret,
	saveTelegramCredentials,
} from "../services/channels/telegram-credentials.js";
import {
	getTelegramPollerStatus,
	startTelegramPolling,
	stopTelegramPolling,
} from "../services/channels/telegram-poller.js";
import {
	ASK_BUSY_REPLY,
	ASK_FAILED_REPLY,
	ASK_TOO_LONG_REPLY,
} from "../services/channels/telegram-replies.js";
import {
	type TelegramCallbackQuery,
	type TelegramMessage,
	type TelegramUpdate,
	answerCallbackQuery,
	deleteTelegramWebhook,
	getTelegramBotInfo,
	getTelegramWebhookInfo,
	sendTelegramMessage,
	sendTelegramPlain,
	sendTelegramRaw,
	sendTelegramTest,
	setTelegramWebhook,
} from "../services/channels/telegram.js";
import {
	type NotificationChannelRecord,
	parseActionCallbackData,
	parseHitlCallbackData,
} from "../services/channels/types.js";
import { getMode } from "../services/instance-mode.js";
import { isLabsFlagEnabled } from "../services/labs-service.js";
import { FixedWindowCounter } from "../services/util/fixed-window-counter.js";

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

/** A Telegram update is a few KiB of JSON; 1 MiB is far beyond any real one. */
const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

/** Constant-time comparison of the shared secret; lengths are compared first because timingSafeEqual throws on unequal lengths. */
function secretMatches(provided: string, expected: string): boolean {
	const providedBuf = Buffer.from(provided);
	const expectedBuf = Buffer.from(expected);
	return providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
}

telegramWebhookRouter.post(
	"/channels/telegram/webhook",
	// The secret is checked first, so an unauthenticated caller's body is never read.
	async (c, next) => {
		if (!getTelegramBotToken()) return c.json({ error: "telegram_disabled" }, 404);
		const providedSecret = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";
		const expectedSecret = getTelegramWebhookSecret();
		if (!expectedSecret || !secretMatches(providedSecret, expectedSecret)) {
			return c.json({ error: "invalid secret" }, 401);
		}
		await next();
	},
	bodyLimit({
		maxSize: WEBHOOK_BODY_LIMIT_BYTES,
		onError: (c) => c.json({ error: "payload_too_large" }, 413),
	}),
	async (c) => {
		// Only malformed JSON is acknowledged and dropped; any other failure, such as
		// the body limit cutting off an oversized read, must propagate.
		const update = (await c.req.json().catch((err: unknown) => {
			if (!(err instanceof SyntaxError)) throw err;
			return null;
		})) as TelegramUpdate | null;
		if (!update) return c.json({ ok: true });

		await handleTelegramUpdate(update);
		return c.json({ ok: true });
	},
);

/**
 * Process a Telegram update (from webhook *or* long-poll). Shapes we
 * care about: `/start <code>` enrollment, `callback_query` HITL taps,
 * and plain-text messages from enrolled chats (routed into the Ask
 * assistant when that labs feature is enabled and the channel opts in).
 *
 * Everything but `/start <code>` is authorized by one gate first (a private
 * chat, a linked channel, the enrolled Telegram user); the handlers receive the
 * channel it resolved and never look one up by chat id themselves.
 */
async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
	if (update.message?.text?.startsWith("/start ")) {
		await handleEnrollmentStart(update.message);
		return;
	}
	if (!update.callback_query && !update.message?.text) return;

	const caller = await authorizeTelegramCaller(update);
	if (!caller.ok) {
		await replyToRefusedCaller(update, caller.reply);
		return;
	}
	if (update.callback_query) {
		const data = update.callback_query.data ?? "";
		if (data.startsWith("act:")) {
			await handleActionCallback(update.callback_query, caller.channel);
		} else {
			await handleHitlCallback(update.callback_query, caller);
		}
		return;
	}
	if (update.message?.text) {
		await handleTelegramAskMessage(update.message, caller.channel);
	}
}

/** What a refused caller hears: a tapped button is told so, a private chat nobody linked gets one hint, the rest nothing. */
async function replyToRefusedCaller(
	update: TelegramUpdate,
	reply: "not_authorized" | "not_linked" | "silent",
): Promise<void> {
	if (reply === "silent") return;
	if (reply === "not_authorized") {
		if (update.callback_query)
			await answerCallbackQuery(update.callback_query.id, "Not authorized.");
		return;
	}
	const message = update.message;
	if (!message?.text) return;
	// Same conditions the Ask path always had: only when the assistant is on,
	// and not for a bare command with nothing to ask.
	const text = message.text.trim();
	const normalized = text.startsWith("/") ? text.replace(/^\/\S+\s*/, "") : text;
	if (!normalized) return;
	if (!isAiBuildEnabled() || !(await isAiActive())) return;
	if (!(await isLabsFlagEnabled("askAssistant"))) return;
	await telegramSendMessage(
		String(message.chat.id),
		"This chat isn't linked to AgentPulse yet. Open Settings → Telegram to enroll.",
	);
}

async function handleTelegramAskMessage(
	message: TelegramMessage,
	channel: NotificationChannelRecord,
): Promise<void> {
	const text = message.text?.trim();
	if (!text) return;
	// Bot commands that aren't `/start <code>` fall through to the ask
	// path too — we strip the leading slash so the LLM sees intent.
	const normalized = text.startsWith("/") ? text.replace(/^\/\S+\s*/, "") : text;
	if (!normalized) return;
	const chatId = String(message.chat.id);

	// Feature gate: ask assistant labs flag must be on. Otherwise do
	// nothing (silent so unexpected DMs don't leak auto-replies).
	if (!isAiBuildEnabled() || !(await isAiActive())) return;
	if (!(await isLabsFlagEnabled("askAssistant"))) return;

	// Per-channel opt-out: admins can flip `askEnabled: false` in the
	// channel config to silence the assistant for a chat even if labs
	// is on globally.
	if (channel.config && (channel.config as Record<string, unknown>).askEnabled === false) {
		return;
	}

	// Refused before a thread exists or any work is done; the user is told why.
	if (normalized.length > ASK_MESSAGE_MAX_CHARS) {
		await telegramSendMessage(chatId, ASK_TOO_LONG_REPLY);
		return;
	}

	// The slot comes before a thread exists or a typing indicator is shown, so a
	// message refused as busy leaves no trace but the reply.
	let slot: Awaited<ReturnType<typeof acquireAskTurn>>;
	try {
		slot = await acquireAskTurn();
	} catch (err) {
		if (!(err instanceof AskBusyError)) throw err;
		await telegramSendMessage(chatId, ASK_BUSY_REPLY).catch(() => {
			// ignore
		});
		return;
	}
	// The slot guards the turn, not the Telegram calls around it: those have no
	// timeout, so a stalled connection must never be able to hold a slot.
	let answer: string;
	try {
		const thread = await findOrCreateTelegramThread({
			telegramChatId: chatId,
			seedTitle: normalized,
		});

		// Typing indicator so the user sees the bot is thinking. Informational, so
		// not waited on.
		telegramChatAction(chatId, "typing").catch(() => {
			// ignore
		});

		const res = await runAskTurn({
			threadId: thread.id,
			message: normalized,
			origin: "telegram",
			telegramChatId: chatId,
			actor: TELEGRAM_ACTOR,
			slot,
		});
		answer = res.assistantMessage.errorMessage
			? `⚠️ ${res.assistantMessage.content}`
			: res.assistantMessage.content;
	} catch (err) {
		// The detail goes to the log; the chat is told nothing about it.
		const detail = err instanceof Error ? err.message : String(err);
		console.error(
			JSON.stringify({
				kind: "telegram_ask_failed",
				level: "error",
				error: detail.slice(0, 300),
			}),
		);
		answer = ASK_FAILED_REPLY;
	} finally {
		slot.release();
	}
	await telegramSendMessage(chatId, answer).catch(() => {
		// ignore
	});
}

/**
 * Plain sendMessage that splits over 4096-char chunks (Telegram's cap).
 * Uses the global bot token; falls through silently if it isn't set.
 */
async function telegramSendMessage(chatId: string, text: string): Promise<void> {
	await sendTelegramMessage(getTelegramBotToken(), chatId, text, { chunkSplit: true });
}

async function telegramChatAction(chatId: string, action: "typing"): Promise<void> {
	const token = getTelegramBotToken();
	if (!token) return;
	await sendTelegramRaw(token, "sendChatAction", { chat_id: chatId, action });
}

/** Failed enrollment attempts per chat: five in a window, then the chat is ignored for the rest of it. */
const ENROLLMENT_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const ENROLLMENT_FAILURE_LIMIT = 5;
const enrollmentFailures = new FixedWindowCounter(ENROLLMENT_FAILURE_WINDOW_MS);

const ENROLLMENT_REFUSED_REPLY = "This code isn't valid.";
const ENROLLMENT_PRIVATE_ONLY_REPLY =
	"Link the bot from a private chat: open a direct message with it and send the code there.";

async function handleEnrollmentStart(message: TelegramMessage): Promise<void> {
	const code = (message.text ?? "").slice("/start ".length).trim();
	if (!code) return;
	const chatId = String(message.chat.id);
	if (enrollmentFailures.isAtLimit(chatId, ENROLLMENT_FAILURE_LIMIT)) return;

	const reject = async (reply: string) => {
		enrollmentFailures.tryConsume(chatId, ENROLLMENT_FAILURE_LIMIT);
		await sendEnrollmentReply(chatId, reply);
	};

	// Only a private chat can enroll: a group can't bind one person.
	if (message.chat.type !== "private" || !message.from) {
		await reject(ENROLLMENT_PRIVATE_ONLY_REPLY);
		return;
	}
	const pending = await findPendingByEnrollmentCode(code);
	if (!pending) {
		await reject(ENROLLMENT_REFUSED_REPLY);
		return;
	}
	const bound = await completeEnrollment({
		channelId: pending.id,
		chatId,
		fromUserId: String(message.from.id),
		code,
	});
	if (!bound) {
		await reject(ENROLLMENT_REFUSED_REPLY);
		return;
	}
	await sendEnrollmentReply(
		chatId,
		`✅ Linked to AgentPulse channel "${pending.label}". You'll get HITL requests here.`,
	);
}

async function sendEnrollmentReply(chatId: string, text: string): Promise<void> {
	await sendTelegramMessage(getTelegramBotToken(), chatId, text);
}

const RELINK_TO_APPROVE_REPLY = "Re-link this channel to approve from Telegram.";

/**
 * In team mode a channel owned by "local" belongs to nobody, so it may not
 * approve anything until a person re-links it (which gives it an owner).
 * Declining sends nothing and stays available.
 */
async function approvalsRefusedFor(channel: NotificationChannelRecord): Promise<boolean> {
	return channel.userId === "local" && (await getMode()) === "team";
}

/** What the person who tapped is told, per outcome of the decision. */
function hitlOutcomeReply(
	action: "approve" | "decline",
	result: Awaited<ReturnType<typeof resolveProposal>>,
): string {
	if (result.ok) return action === "approve" ? "Sent to the session." : "Declined ✗";
	switch (result.code) {
		case "prompt_not_deliverable":
			return "This session can't receive prompts; copy it from the dashboard.";
		case "dispatch_blocked":
		case "prompt_unsafe":
			return "Blocked by the safety filter.";
		case "stale_proposal":
		case "prompt_changed":
			return "This suggestion is out of date.";
		case "not_approvable":
			return "Open the dashboard to review this one.";
		case "expired":
			return "This request expired.";
		case "already_resolved":
			return "Already resolved.";
		case "ai_paused":
			return "AI is paused.";
		default:
			return "Could not send it.";
	}
}

/**
 * May the person behind this channel decide on this session? The channel's
 * owner must be allowed to act on it as an owner or an admin would. Solo mode
 * has no ownership to enforce. Declining sends nothing and is never refused.
 */
async function channelOwnerMayApprove(
	channel: NotificationChannelRecord,
	sessionId: string,
): Promise<boolean> {
	const mode = await getMode();
	if (mode === "solo") return true;
	if (channel.userId === "local") return false;
	const [owner] = await getDb()
		.select({ role: users.role, disabledAt: users.disabledAt })
		.from(users)
		.where(eq(users.id, channel.userId))
		.limit(1);
	if (!owner || owner.disabledAt !== null) return false;
	try {
		await assertCanDecideProposal(
			{
				userId: channel.userId,
				label: "telegram",
				role: owner.role === "admin" ? "admin" : "member",
				mode,
			},
			sessionId,
		);
		return true;
	} catch (err) {
		if (err instanceof NotOwnerError) return false;
		throw err;
	}
}

async function handleHitlCallback(
	cb: TelegramCallbackQuery,
	caller: Extract<TelegramCallerResult, { ok: true }>,
): Promise<void> {
	const { channel } = caller;
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
	// The HITL must belong to the channel this update arrived through; one
	// that was never tied to a channel can't be acted on from Telegram at all.
	if (!hitl.channelId || hitl.channelId !== channel.id) {
		await answerCallbackQuery(cb.id, "Not authorized.");
		return;
	}
	if (data.action === "approve" && (await approvalsRefusedFor(channel))) {
		await answerCallbackQuery(cb.id, RELINK_TO_APPROVE_REPLY);
		return;
	}
	if (data.action === "approve" && !(await channelOwnerMayApprove(channel, hitl.sessionId))) {
		await answerCallbackQuery(cb.id, "Approve this in the dashboard.");
		return;
	}

	// The callback names a HITL and an action, nothing else. The prompt, its
	// hash and the TTL always come from the server's own rows (that is why the
	// callback needs no signature): nothing from `cb` is passed on below.
	const result = await resolveProposal({
		hitlId: hitl.id,
		action: data.action,
		promptSha256: hitl.promptSha256 ?? undefined,
		actor: TELEGRAM_ACTOR,
		actorKind: "telegram",
		telegram: { fromId: caller.fromId, chatId: caller.chatId },
	});
	await answerCallbackQuery(cb.id, hitlOutcomeReply(data.action, result));
	if (result.ok) {
		await sendTelegramPlain(
			hitl.channelId,
			data.action === "approve" ? "✅ Sent to the session." : "❌ Declined.",
		);
	}
}

/**
 * Handle approve/decline callbacks for ai_action_requests. Mirrors
 * handleHitlCallback but routes to the separate action-requests table.
 * Callback data prefix: `act:approve:<id>` / `act:decline:<id>`.
 */
async function handleActionCallback(
	cb: TelegramCallbackQuery,
	channel: NotificationChannelRecord,
): Promise<void> {
	const data = parseActionCallbackData(cb.data ?? "");
	if (!data) {
		await answerCallbackQuery(cb.id, "Unknown action.");
		return;
	}
	const request = await getActionRequest(data.actionRequestId);
	if (!request) {
		await answerCallbackQuery(cb.id, "Action request not found.");
		return;
	}
	// An action request must be tied to the channel this update arrived
	// through. One with no channel can't be approved from Telegram.
	if (!request.channelId || request.channelId !== channel.id) {
		await answerCallbackQuery(cb.id, "Not authorized.");
		return;
	}
	if (data.action === "approve" && (await approvalsRefusedFor(channel))) {
		await answerCallbackQuery(cb.id, RELINK_TO_APPROVE_REPLY);
		return;
	}
	if (request.status !== "awaiting_reply") {
		await answerCallbackQuery(cb.id, "Already resolved.");
		return;
	}

	const decision = data.action === "approve" ? "applied" : "declined";
	const resolvedBy = String(cb.from.id);
	// A Telegram chat is a member with no identity: team mode refuses it every
	// owner-or-admin operation an approved action would run, and leaves the
	// request open for the dashboard.
	const result = await resolveActionRequest({
		id: request.id,
		decision,
		resolvedBy,
		actor: TELEGRAM_ACTOR,
	});

	if (!result.ok) {
		await answerCallbackQuery(
			cb.id,
			result.reason === "not_owner"
				? "Approve this in the dashboard. Chat approvals can't act on a member's session in team mode."
				: "Already claimed by another approval.",
		);
		return;
	}
	await answerCallbackQuery(
		cb.id,
		data.action === "approve" ? "Approved — launching." : "Declined.",
	);
}

// --- Authenticated admin CRUD below ---
//
// The public Telegram webhook lives on `telegramWebhookRouter`, which is
// mounted directly on the root app *outside* the `api` bundle. That means
// any `.use("*", ...)` here on channelsRouter cannot reach it — so we can
// safely use router-level middleware without shadowing the webhook. (M-1)
const channelsRouter = new Hono();
channelsRouter.use("*", requireAuth());
channelsRouter.use("*", requireOperatorScope());

function authUserOf(c: Context): AuthUser | undefined {
	return c.get("authUser") as AuthUser | undefined;
}

/**
 * The channel, when the caller may manage it; null otherwise. A channel the
 * caller can't see answers exactly like one that doesn't exist, so ids can't
 * be probed.
 */
async function manageableChannel(c: Context, id: string) {
	const actor = await getRequestActor(c);
	const channel = await getChannel(id);
	if (!channel) return null;
	try {
		await assertCanManageChannel(actor, channel);
	} catch (err) {
		if (err instanceof NotOwnerError) return null;
		throw err;
	}
	return { channel, actor };
}

/** A channel as the API returns it: with whether it needs re-linking before Telegram can act through it. */
async function withRelinkHint(channel: NotificationChannelRecord, mode: "solo" | "team") {
	return { ...channel, needsRelink: await relinkReason(channel, mode) };
}

channelsRouter.get("/channels", async (c) => {
	const actor = await getRequestActor(c);
	const mode = actor.mode ?? (await getMode());
	const channels = await Promise.all(
		(await listChannels(actor)).map((channel) => withRelinkHint(channel, mode)),
	);
	return c.json({
		channels,
		bot: {
			configured: Boolean(getTelegramBotToken()),
			webhookSecretConfigured: Boolean(getTelegramWebhookSecret()),
		},
	});
});

channelsRouter.post("/channels", async (c) => {
	if (!getTelegramBotToken()) {
		return c.json({ error: "Telegram bot token not configured" }, 400);
	}
	const body = await c.req.json<{
		kind: "telegram";
		label?: string;
	}>();
	if (body.kind !== "telegram") return c.json({ error: "Unsupported kind" }, 400);
	const actor = await getRequestActor(c);
	const result = await createPendingChannel({
		kind: "telegram",
		label: (body.label ?? "Telegram").slice(0, 80),
		// "local" is the single operator in solo mode (and an actor with no user
		// id, such as DISABLE_AUTH); in team mode it belongs to nobody.
		userId: actor.userId ?? "local",
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
	if (!(await manageableChannel(c, id))) return c.json({ error: "Channel not found" }, 404);
	const ok = await deleteChannel(id);
	if (!ok) return c.json({ error: "Channel not found" }, 404);
	return c.json({ ok: true });
});

/**
 * Patch per-channel config flags (currently: askEnabled, detail). Rejects any
 * key not on the allow-list so callers can't poke at enrollment codes
 * or status strings through this endpoint.
 *
 * `detail` is how much of a watcher's output a message may carry: `minimal`
 * (the default) holds no prompt text and no Approve button, `full` holds the
 * redacted text. A channel enrolled in a group (negative chat id) can never be
 * set to `full`: anyone in the group would read it.
 */
channelsRouter.patch("/channels/:id/config", async (c) => {
	const id = c.req.param("id") ?? "";
	const body = await c.req.json<{ askEnabled?: boolean; detail?: unknown }>();
	const patch: Record<string, unknown> = {};
	if (typeof body.askEnabled === "boolean") patch.askEnabled = body.askEnabled;
	if (body.detail !== undefined) {
		if (body.detail !== "minimal" && body.detail !== "full") {
			return c.json({ error: "detail must be 'minimal' or 'full'" }, 400);
		}
		patch.detail = body.detail;
	}
	if (Object.keys(patch).length === 0) {
		return c.json({ error: "No supported fields in body" }, 400);
	}
	if (!(await manageableChannel(c, id))) return c.json({ error: "Channel not found" }, 404);
	if (patch.detail === "full") {
		const credential = await getChannelCredential(id);
		if (credential?.chatId.startsWith("-")) {
			return c.json({ error: "detail_full_needs_private_chat" }, 400);
		}
	}
	const updated = await updateChannelConfig(id, patch);
	if (!updated) return c.json({ error: "Channel not found" }, 404);
	return c.json({ channel: updated });
});

channelsRouter.get("/channels/:id", async (c) => {
	const id = c.req.param("id") ?? "";
	const found = await manageableChannel(c, id);
	if (!found) return c.json({ error: "Channel not found" }, 404);
	const mode = found.actor.mode ?? (await getMode());
	return c.json({ channel: await withRelinkHint(found.channel, mode) });
});

/**
 * Put a channel back to pending with a fresh code. Whoever held it loses every
 * inbound right at once (the stored chat and Telegram user are cleared) and the
 * new code binds the next private chat that redeems it. The channel id stays,
 * so watcher configs and HITLs keep pointing at it. A person's action: an API
 * key can't do it. In team mode an admin re-linking a channel owned by "local"
 * claims it for themselves.
 */
channelsRouter.post("/channels/:id/relink", async (c) => {
	const badOrigin = refuseBadOrigin(c);
	if (badOrigin) return badOrigin;
	const authUser = authUserOf(c);
	if (!(authUser && isHumanCaller(authUser))) return c.json({ error: "human_required" }, 403);
	const id = c.req.param("id") ?? "";
	const found = await manageableChannel(c, id);
	if (!found) return c.json({ error: "Channel not found" }, 404);
	if (!getTelegramBotToken()) return c.json({ error: "Telegram bot token not configured" }, 400);

	const claimForUserId =
		found.channel.userId === "local" && found.actor.userId !== null
			? found.actor.userId
			: undefined;
	const result = await relinkChannel(id, { claimForUserId });
	if (!result) return c.json({ error: "Channel not found" }, 404);
	logAdminAction("channel_relinked", found.actor, { channelId: id });
	return c.json({
		channel: result.channel,
		enrollmentCode: result.enrollmentCode,
		instructions: `Open Telegram and send \`/start ${result.enrollmentCode}\` to the bot from a private chat.`,
	});
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
channelsRouter.post("/channels/telegram/setup-webhook", async (c) => {
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
channelsRouter.get("/channels/telegram/credentials", async (c) => {
	return c.json({
		configured: Boolean(getTelegramBotToken()),
		webhookSecretConfigured: Boolean(getTelegramWebhookSecret()),
		source: getTelegramCredentialsSource(),
		botTokenHint: getTelegramBotTokenHint(),
		deliveryMode: getTelegramDeliveryMode(),
		polling: getTelegramPollerStatus(),
	});
});

channelsRouter.post("/channels/telegram/credentials", async (c) => {
	const body = await c.req.json<{
		botToken?: string;
		webhookSecret?: string;
		rotateWebhookSecret?: boolean;
		publicUrl?: string;
		deliveryMode?: TelegramDeliveryMode;
	}>();

	const trimmedToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
	const explicitSecret = typeof body.webhookSecret === "string" ? body.webhookSecret.trim() : "";
	const requestedMode: TelegramDeliveryMode | undefined =
		body.deliveryMode === "webhook" || body.deliveryMode === "polling"
			? body.deliveryMode
			: undefined;

	// A token is required on first save or when rotating. If nothing is
	// being changed at all (not even a delivery-mode flip) we reject to
	// avoid silent no-ops.
	if (!trimmedToken && !explicitSecret && !body.rotateWebhookSecret && !requestedMode) {
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
			deliveryMode: requestedMode,
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
	} else if (secretToPersist !== null || requestedMode) {
		await saveTelegramCredentials({
			webhookSecret: secretToPersist,
			deliveryMode: requestedMode,
		});
	}

	// Flip the delivery machinery to match the persisted mode. Webhook
	// and polling are mutually exclusive at Telegram's end (setWebhook
	// and getUpdates conflict), so the caller must always be in exactly
	// one state — no partial transitions.
	const effectiveMode = getTelegramDeliveryMode();
	let webhookResult: { ok: boolean; url?: string; error?: string } = { ok: false };
	if (effectiveMode === "webhook") {
		await stopTelegramPolling();
		const base = resolvePublicUrl(body.publicUrl);
		if (base) {
			const url = `${base}/api/v1/channels/telegram/webhook`;
			const res = await setTelegramWebhook(url, getTelegramWebhookSecret());
			webhookResult = res.ok ? { ok: true, url } : { ok: false, error: res.description };
		} else {
			webhookResult = { ok: false, error: "no public URL provided" };
		}
	} else {
		// Polling mode: make sure any webhook is torn down, then start
		// the long-poll loop.
		await deleteTelegramWebhook().catch(() => {
			// ignore
		});
		await startTelegramPolling(handleTelegramUpdate);
	}

	const botInfo = await getTelegramBotInfo();

	return c.json({
		ok: true,
		source: getTelegramCredentialsSource(),
		botTokenHint: getTelegramBotTokenHint(),
		webhookSecretConfigured: Boolean(getTelegramWebhookSecret()),
		deliveryMode: effectiveMode,
		bot: botInfo.ok ? botInfo.info : null,
		webhook: webhookResult,
		polling: getTelegramPollerStatus(),
	});
});

channelsRouter.delete("/channels/telegram/credentials", async (c) => {
	if (getTelegramBotToken()) {
		await deleteTelegramWebhook().catch(() => {
			// ignore — we're wiping credentials regardless of Telegram's
			// ability to tell us the webhook got cleared
		});
	}
	await stopTelegramPolling();
	await clearTelegramCredentials();
	return c.json({
		ok: true,
		source: getTelegramCredentialsSource(),
		botTokenHint: getTelegramBotTokenHint(),
	});
});

channelsRouter.post("/channels/telegram/teardown-webhook", async (c) => {
	if (!getTelegramBotToken()) return c.json({ error: "Telegram bot token not configured" }, 400);
	await deleteTelegramWebhook();
	return c.json({ ok: true });
});

channelsRouter.get("/channels/telegram/bot-info", async (c) => {
	if (!getTelegramBotToken()) return c.json({ error: "Telegram bot token not configured" }, 400);
	const res = await getTelegramBotInfo();
	if (!res.ok) return c.json({ error: res.error }, 502);
	return c.json({ bot: res.info });
});

channelsRouter.get("/channels/telegram/webhook-info", async (c) => {
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

channelsRouter.post("/channels/:id/test", async (c) => {
	const id = c.req.param("id") ?? "";
	const found = await manageableChannel(c, id);
	if (!found) return c.json({ error: "Channel not found" }, 404);
	const ch = found.channel;
	if (ch.kind !== "telegram") return c.json({ error: "Test only supported for telegram" }, 400);
	if (!ch.verifiedAt) return c.json({ error: "Channel is not verified" }, 400);
	const res = await sendTelegramTest(id);
	if (!res.ok) return c.json({ error: res.error ?? "send failed" }, 502);
	return c.json({ ok: true, externalMessageId: res.externalMessageId });
});

channelsRouter.get("/channels/:id/stats", async (c) => {
	const id = c.req.param("id") ?? "";
	if (!(await manageableChannel(c, id))) return c.json({ error: "Channel not found" }, 404);
	const stats = await getChannelStats(id);
	return c.json({ stats });
});

export { channelsRouter, telegramWebhookRouter, handleTelegramUpdate };
