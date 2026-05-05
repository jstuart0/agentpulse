import { useCallback, useEffect, useState } from "react";
import { useCopyFeedback } from "../../hooks/useCopyFeedback.js";
import {
	type ChannelStats,
	type NotificationChannelRecord,
	type TelegramBotInfo,
	type TelegramWebhookInfo,
	api,
} from "../../lib/api.js";
import { BotCredentialsStatus, BotHeader } from "./TelegramBotStatus.js";
import { ChannelList } from "./TelegramChannelList.js";
import { AddChannelCard, BotCredentialsWizard, EnrollmentCard } from "./TelegramEnrollment.js";

interface CredentialsState {
	configured: boolean;
	webhookSecretConfigured: boolean;
	source: "db" | "env" | "missing";
	botTokenHint: string | null;
	deliveryMode: "webhook" | "polling";
	polling: {
		running: boolean;
		lastPollAt: string | null;
		updatesReceived: number;
		lastError: string | null;
	} | null;
}

/**
 * First-class Telegram enrollment + status panel. Shows bot identity,
 * live webhook status, a rich enrollment UI (deep link + copy + QR),
 * per-channel stats, test-send, and delete-with-usage-warning.
 *
 * Composed from:
 *   - TelegramBotStatus   (BotHeader, BotCredentialsStatus)
 *   - TelegramEnrollment  (BotCredentialsWizard, EnrollmentCard, AddChannelCard)
 *   - TelegramChannelList (ChannelList)
 */
export function TelegramChannelPanel() {
	const [channels, setChannels] = useState<NotificationChannelRecord[]>([]);
	const [bot, setBot] = useState<{
		configured: boolean;
		webhookSecretConfigured: boolean;
	} | null>(null);
	const [creds, setCreds] = useState<CredentialsState | null>(null);
	const [botInfo, setBotInfo] = useState<TelegramBotInfo | null>(null);
	const [webhookInfo, setWebhookInfo] = useState<TelegramWebhookInfo | null>(null);
	const [webhookMatchesExpected, setWebhookMatchesExpected] = useState<boolean | null>(null);
	const [statsByChannel, setStatsByChannel] = useState<Record<string, ChannelStats>>({});
	const [loading, setLoading] = useState(true);
	const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
	const [label, setLabel] = useState("My Telegram");
	const [pending, setPending] = useState<{
		channelId: string;
		enrollmentCode: string;
	} | null>(null);

	const publicUrl = typeof window !== "undefined" ? window.location.origin : "";
	const { copy } = useCopyFeedback();

	const showToast = useCallback((kind: "ok" | "err", text: string) => {
		setToast({ kind, text });
		setTimeout(() => setToast(null), 4000);
	}, []);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const [res, credRes] = await Promise.all([api.getChannels(), api.getTelegramCredentials()]);
			setChannels(res.channels);
			setBot(res.bot);
			setCreds(credRes);

			// Fetch stats in parallel for each channel.
			const statsEntries = await Promise.all(
				res.channels.map(async (ch) => {
					try {
						const s = await api.getChannelStats(ch.id);
						return [ch.id, s.stats] as const;
					} catch {
						return null;
					}
				}),
			);
			const map: Record<string, ChannelStats> = {};
			for (const entry of statsEntries) {
				if (entry) map[entry[0]] = entry[1];
			}
			setStatsByChannel(map);

			// Kick off bot identity + webhook status if the server is wired up.
			if (res.bot.configured) {
				void api
					.getTelegramBotInfo()
					.then((r) => setBotInfo(r.bot))
					.catch(() => setBotInfo(null));
				void api
					.getTelegramWebhookInfo(publicUrl)
					.then((r) => {
						setWebhookInfo(r.webhook);
						setWebhookMatchesExpected(r.matchesExpected);
					})
					.catch(() => {
						setWebhookInfo(null);
						setWebhookMatchesExpected(null);
					});
			} else {
				setBotInfo(null);
				setWebhookInfo(null);
				setWebhookMatchesExpected(null);
			}
		} catch (err) {
			showToast("err", err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [showToast, publicUrl]);

	useEffect(() => {
		void load();
	}, [load]);

	// Poll every 3s while a pending enrollment is outstanding; flip to
	// verified as soon as the bot's /start handler completes.
	useEffect(() => {
		if (!pending) return;
		const interval = setInterval(async () => {
			try {
				const res = await api.getChannel(pending.channelId);
				if (res.channel.verifiedAt) {
					setPending(null);
					showToast("ok", `✓ Linked. HITL requests will reach "${res.channel.label}".`);
					await load();
				}
			} catch {
				// transient ignored
			}
		}, 3000);
		return () => clearInterval(interval);
	}, [pending, load, showToast]);

	async function handleCreate() {
		try {
			const res = await api.createChannel({ kind: "telegram", label });
			setPending({
				channelId: res.channel.id,
				enrollmentCode: res.enrollmentCode,
			});
			await load();
		} catch (err) {
			showToast("err", err instanceof Error ? err.message : String(err));
		}
	}

	async function handleDelete(id: string) {
		const stats = statsByChannel[id];
		const sessionCount = stats?.assignedSessionCount ?? 0;
		const warning =
			sessionCount > 0
				? `${sessionCount} session${sessionCount === 1 ? "" : "s"} currently route through this channel. Their HITL requests will stop forwarding. Continue?`
				: "Delete this Telegram channel?";
		if (!confirm(warning)) return;
		try {
			await api.deleteChannel(id);
			showToast("ok", "Channel deleted.");
			await load();
		} catch (err) {
			showToast("err", err instanceof Error ? err.message : String(err));
		}
	}

	async function handleSetupWebhook() {
		try {
			await api.setupTelegramWebhook(publicUrl);
			showToast("ok", "Webhook set. Telegram will now deliver updates here.");
			await load();
		} catch (err) {
			showToast("err", err instanceof Error ? err.message : String(err));
		}
	}

	async function handleSaveCredentials(input: {
		botToken?: string;
		webhookSecret?: string;
		rotateWebhookSecret?: boolean;
		deliveryMode?: "webhook" | "polling";
	}): Promise<{ ok: boolean; error?: string }> {
		try {
			const res = await api.saveTelegramCredentials({ ...input, publicUrl });
			if (res.deliveryMode === "polling") {
				showToast(
					"ok",
					res.polling?.running
						? "Saved. Polling Telegram — you can add channels now."
						: "Saved. Polling will start momentarily.",
				);
			} else if (res.webhook.ok) {
				showToast("ok", "Saved. Webhook is live — you can add channels now.");
			} else if (res.bot) {
				showToast(
					"ok",
					`Saved. Webhook didn't register (${res.webhook.error ?? "unknown"}). Try polling mode below if this instance isn't publicly reachable.`,
				);
			} else {
				showToast("ok", "Saved.");
			}
			await load();
			return { ok: true };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			showToast("err", msg);
			return { ok: false, error: msg };
		}
	}

	async function handleClearCredentials() {
		if (
			!confirm(
				"Remove the Telegram bot token from this instance? All existing channels will stop receiving HITL updates until a new token is added.",
			)
		)
			return;
		try {
			await api.clearTelegramCredentials();
			showToast("ok", "Bot token removed.");
			await load();
		} catch (err) {
			showToast("err", err instanceof Error ? err.message : String(err));
		}
	}

	async function handleAskToggle(id: string, askEnabled: boolean) {
		try {
			await api.updateChannelConfig(id, { askEnabled });
			showToast(
				"ok",
				askEnabled
					? "Ask enabled — DMs to this chat will get LLM replies."
					: "Ask disabled — the bot will ignore free-form messages on this channel.",
			);
			await load();
		} catch (err) {
			showToast("err", err instanceof Error ? err.message : String(err));
		}
	}

	async function handleTest(id: string) {
		try {
			await api.testChannel(id);
			showToast("ok", "Test message sent to Telegram.");
		} catch (err) {
			showToast("err", err instanceof Error ? err.message : String(err));
		}
	}

	if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;

	const toastBar = toast ? (
		<div
			className={`rounded-md border px-3 py-2 text-xs ${
				toast.kind === "ok"
					? "border-emerald-500/30 bg-emerald-500/5 text-emerald-200"
					: "border-red-500/30 bg-red-500/5 text-red-200"
			}`}
		>
			{toast.text}
		</div>
	) : null;

	// No bot token anywhere (DB or env) → show the paste-token wizard.
	if (!bot?.configured) {
		return (
			<div className="space-y-4">
				{toastBar}
				<BotCredentialsWizard publicUrl={publicUrl} onSave={handleSaveCredentials} />
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{toastBar}

			<BotCredentialsStatus
				creds={creds}
				onRotateSecret={() => handleSaveCredentials({ rotateWebhookSecret: true })}
				onClear={handleClearCredentials}
				onSwitchMode={(mode) => handleSaveCredentials({ deliveryMode: mode })}
			/>

			<BotHeader
				bot={bot}
				info={botInfo}
				webhook={webhookInfo}
				webhookMatchesExpected={webhookMatchesExpected}
				deliveryMode={creds?.deliveryMode ?? "webhook"}
				polling={creds?.polling ?? null}
				onSetupWebhook={handleSetupWebhook}
			/>

			{pending && botInfo?.username && (
				<EnrollmentCard
					botUsername={botInfo.username}
					code={pending.enrollmentCode}
					onCopy={copy}
					onCancel={async () => {
						// Cancel = delete the pending channel so the code can't be reused.
						await api.deleteChannel(pending.channelId).catch(() => {});
						setPending(null);
						await load();
					}}
				/>
			)}
			{pending && !botInfo?.username && (
				<div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
					Waiting on bot identity from Telegram — normally a second. If this persists, check
					`TELEGRAM_BOT_TOKEN`.
				</div>
			)}

			<AddChannelCard
				label={label}
				onLabelChange={setLabel}
				onCreate={handleCreate}
				botReady={
					Boolean(botInfo?.username) &&
					(creds?.deliveryMode === "polling"
						? Boolean(creds?.polling?.running)
						: webhookMatchesExpected !== false)
				}
			/>

			<ChannelList
				channels={channels}
				stats={statsByChannel}
				onTest={handleTest}
				onDelete={handleDelete}
				onAskToggle={handleAskToggle}
			/>
		</div>
	);
}
