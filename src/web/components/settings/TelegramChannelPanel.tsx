import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import {
	type ChannelStats,
	type NotificationChannelRecord,
	type TelegramBotInfo,
	type TelegramWebhookInfo,
	api,
} from "../../lib/api.js";

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

	async function copy(text: string, okText = "Copied") {
		try {
			await navigator.clipboard.writeText(text);
			showToast("ok", okText);
		} catch {
			showToast("err", "Clipboard blocked by browser.");
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
	// Previously this was a wall of env-var docs. Now the whole flow —
	// paste the token, auto-generate the webhook secret, auto-register
	// the webhook — happens in one button press.
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

// ------------------------------ subcomponents ------------------------------

function BotHeader({
	bot,
	info,
	webhook,
	webhookMatchesExpected,
	deliveryMode,
	polling,
	onSetupWebhook,
}: {
	bot: { configured: boolean; webhookSecretConfigured: boolean };
	info: TelegramBotInfo | null;
	webhook: TelegramWebhookInfo | null;
	webhookMatchesExpected: boolean | null;
	deliveryMode: "webhook" | "polling";
	polling: CredentialsState["polling"];
	onSetupWebhook: () => void;
}) {
	const webhookStatus = (() => {
		if (!bot.webhookSecretConfigured) return { tone: "warn", text: "secret missing" };
		if (!webhook) return { tone: "warn", text: "checking…" };
		if (!webhook.url) return { tone: "warn", text: "not set" };
		if (webhookMatchesExpected === false) return { tone: "warn", text: "points elsewhere" };
		if (webhook.lastErrorMessage)
			return { tone: "err", text: `error: ${webhook.lastErrorMessage}` };
		return { tone: "ok", text: "live" };
	})();

	const pollingStatus = (() => {
		if (!polling) return { tone: "warn", text: "unknown" };
		if (polling.lastError) return { tone: "err", text: `error: ${polling.lastError}` };
		if (polling.running) return { tone: "ok", text: "running" };
		return { tone: "warn", text: "stopped" };
	})();

	const status = deliveryMode === "polling" ? pollingStatus : webhookStatus;
	const toneClass =
		status.tone === "ok"
			? "text-emerald-300"
			: status.tone === "err"
				? "text-red-300"
				: "text-amber-300";

	return (
		<div className="rounded-md border border-border bg-background/40 p-3 space-y-2">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<div className="text-sm font-medium text-foreground">
						{info?.firstName ?? "Telegram bot"}
						{info?.username && (
							<span className="ml-2 font-mono text-xs text-muted-foreground">@{info.username}</span>
						)}
					</div>
					<div className="text-[11px] text-muted-foreground mt-0.5">
						Delivery: {deliveryMode} · bot token: {bot.configured ? "set" : "missing"}
						{deliveryMode === "webhook" && (
							<> · webhook secret: {bot.webhookSecretConfigured ? "set" : "missing"}</>
						)}
					</div>
				</div>
				{deliveryMode === "webhook" && (
					<button
						type="button"
						onClick={onSetupWebhook}
						disabled={!bot.webhookSecretConfigured}
						className="text-xs px-3 py-1 rounded border border-border bg-background hover:bg-muted disabled:opacity-50"
					>
						{webhookStatus.text === "live" ? "Re-send webhook" : "Set webhook"}
					</button>
				)}
			</div>
			<div className="flex flex-wrap items-center gap-2 text-[11px]">
				<span className={`font-mono ${toneClass}`}>
					● {deliveryMode === "polling" ? "polling" : "webhook"} {status.text}
				</span>
				{deliveryMode === "webhook" && webhook?.pendingUpdateCount != null && (
					<span className="text-muted-foreground">
						pending updates: {webhook.pendingUpdateCount}
					</span>
				)}
				{deliveryMode === "webhook" && webhook?.lastErrorDate && (
					<span className="text-muted-foreground">
						last error: {new Date(webhook.lastErrorDate * 1000).toLocaleString()}
					</span>
				)}
				{deliveryMode === "polling" && polling?.lastPollAt && (
					<span className="text-muted-foreground">
						last poll: {new Date(polling.lastPollAt).toLocaleTimeString()}
					</span>
				)}
				{deliveryMode === "polling" && polling && (
					<span className="text-muted-foreground">updates: {polling.updatesReceived}</span>
				)}
			</div>
			{deliveryMode === "webhook" && !bot.webhookSecretConfigured && (
				<div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-[11px] text-amber-200">
					No webhook secret is set. Click <em>Rotate webhook secret</em> in the status bar above to
					generate a strong one — Telegram uses it to verify every callback.
				</div>
			)}
		</div>
	);
}

function EnrollmentCard({
	botUsername,
	code,
	onCopy,
	onCancel,
}: {
	botUsername: string;
	code: string;
	onCopy: (text: string, okText?: string) => Promise<void>;
	onCancel: () => void;
}) {
	const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
	const deepLink = `https://t.me/${botUsername}?start=${code}`;
	const tgDeepLink = `tg://resolve?domain=${botUsername}&start=${code}`;
	useEffect(() => {
		let cancelled = false;
		QRCode.toDataURL(deepLink, { width: 160, margin: 1 })
			.then((url) => {
				if (!cancelled) setQrDataUrl(url);
			})
			.catch(() => {
				if (!cancelled) setQrDataUrl(null);
			});
		return () => {
			cancelled = true;
		};
	}, [deepLink]);

	return (
		<div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
			<div className="flex items-center justify-between gap-3">
				<div className="text-sm font-semibold text-foreground">Finish enrollment</div>
				<button
					type="button"
					onClick={onCancel}
					className="text-[11px] text-muted-foreground hover:text-foreground"
				>
					Cancel
				</button>
			</div>
			<div className="grid grid-cols-1 md:grid-cols-[auto,1fr] gap-4 items-start">
				{qrDataUrl ? (
					<img
						src={qrDataUrl}
						alt="Enrollment QR code"
						className="rounded bg-white p-1 w-40 h-40 mx-auto md:mx-0"
					/>
				) : (
					<div className="w-40 h-40 bg-muted rounded animate-pulse mx-auto md:mx-0" />
				)}
				<div className="space-y-2 text-xs text-muted-foreground">
					<p>
						<strong className="text-foreground">On mobile:</strong> tap the button below to open
						Telegram with the code pre-filled.
					</p>
					<div className="flex flex-wrap gap-2">
						<a
							href={tgDeepLink}
							className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
						>
							Open in Telegram app
						</a>
						<a
							href={deepLink}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted"
						>
							Open in browser
						</a>
					</div>
					<p>
						<strong className="text-foreground">Or manually:</strong> scan the QR code, or DM{" "}
						<code className="font-mono">@{botUsername}</code> with:
					</p>
					<div className="flex items-center gap-2">
						<code className="flex-1 font-mono text-primary bg-background/60 px-2 py-1.5 rounded select-all break-all">
							/start {code}
						</code>
						<button
							type="button"
							onClick={() => onCopy(`/start ${code}`, "Command copied")}
							className="text-[11px] px-2 py-1.5 rounded border border-border bg-background hover:bg-muted"
						>
							Copy
						</button>
					</div>
					<p className="text-muted-foreground/80">Waiting for confirmation…</p>
				</div>
			</div>
		</div>
	);
}

function AddChannelCard({
	label,
	onLabelChange,
	onCreate,
	botReady,
}: {
	label: string;
	onLabelChange: (v: string) => void;
	onCreate: () => void;
	botReady: boolean;
}) {
	return (
		<div className="rounded-md border border-border bg-background/40 p-3 space-y-2">
			<div className="text-xs font-medium text-foreground">Add a channel</div>
			<div className="flex items-center gap-2">
				<input
					type="text"
					value={label}
					onChange={(e) => onLabelChange(e.target.value)}
					placeholder="Label (e.g. 'Phone')"
					className="flex-1 text-xs bg-background border border-border rounded px-2 py-1.5"
				/>
				<button
					type="button"
					onClick={onCreate}
					disabled={!label.trim() || !botReady}
					className="text-xs px-3 py-1.5 rounded bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 disabled:opacity-50"
				>
					Generate code
				</button>
			</div>
			{!botReady && (
				<div className="text-[11px] text-amber-300">
					Finish bot + webhook setup above before creating a channel.
				</div>
			)}
		</div>
	);
}

function ChannelList({
	channels,
	stats,
	onTest,
	onDelete,
	onAskToggle,
}: {
	channels: NotificationChannelRecord[];
	stats: Record<string, ChannelStats>;
	onTest: (id: string) => void;
	onDelete: (id: string) => void;
	onAskToggle: (id: string, askEnabled: boolean) => void;
}) {
	if (channels.length === 0) {
		return (
			<div className="rounded-md border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
				No channels yet. Create one above and link it via Telegram to receive HITL requests on your
				phone.
			</div>
		);
	}
	return (
		<ul className="space-y-2">
			{channels.map((ch) => {
				const s = stats[ch.id];
				return (
					<li
						key={ch.id}
						className="rounded-md border border-border bg-card px-3 py-2.5 text-xs space-y-2"
					>
						<div className="flex items-start justify-between gap-2">
							<div className="min-w-0">
								<div className="text-foreground font-medium">{ch.label}</div>
								<div className="text-[10px] text-muted-foreground mt-0.5">
									{ch.kind} ·{" "}
									<span className={ch.verifiedAt ? "text-emerald-300" : "text-amber-300"}>
										{ch.verifiedAt ? "verified" : "pending enrollment"}
									</span>
									{!ch.isActive && " · inactive"}
								</div>
							</div>
							<div className="flex flex-shrink-0 gap-1">
								{ch.verifiedAt && (
									<button
										type="button"
										onClick={() => onTest(ch.id)}
										className="text-[11px] px-2 py-1 rounded border border-border text-foreground hover:bg-muted"
									>
										Test
									</button>
								)}
								<button
									type="button"
									onClick={() => onDelete(ch.id)}
									className="text-[11px] px-2 py-1 rounded border border-border text-red-300 hover:bg-red-500/10"
								>
									Delete
								</button>
							</div>
						</div>
						{ch.verifiedAt && (
							<label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer">
								<input
									type="checkbox"
									checked={
										!(ch.config && (ch.config as Record<string, unknown>).askEnabled === false)
									}
									onChange={(e) => onAskToggle(ch.id, e.target.checked)}
									className="h-3.5 w-3.5"
								/>
								<span>
									Answer free-form DMs via the Ask assistant
									<span className="ml-1 text-muted-foreground/70">
										(requires Labs → Ask assistant)
									</span>
								</span>
							</label>
						)}
						{s && (
							<div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
								<span>
									Assigned sessions:{" "}
									<span className="text-foreground">{s.assignedSessionCount}</span>
								</span>
								<span>
									HITL delivered: <span className="text-foreground">{s.hitlTotal}</span>
								</span>
								<span>
									Open:{" "}
									<span className={s.hitlOpen > 0 ? "text-amber-300" : "text-foreground"}>
										{s.hitlOpen}
									</span>
								</span>
								<span>
									Resolved: <span className="text-foreground">{s.hitlResolved}</span>
								</span>
								{s.lastHitlAt && (
									<span>
										Last: <span className="text-foreground">{relTime(s.lastHitlAt)}</span>
									</span>
								)}
							</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}

function BotCredentialsWizard({
	publicUrl,
	onSave,
}: {
	publicUrl: string;
	onSave: (input: {
		botToken?: string;
		webhookSecret?: string;
		deliveryMode?: "webhook" | "polling";
	}) => Promise<{ ok: boolean; error?: string }>;
}) {
	const [token, setToken] = useState("");
	const [mode, setMode] = useState<"webhook" | "polling">("polling");
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [customSecret, setCustomSecret] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		if (!token.trim()) {
			setError("Paste your bot token from @BotFather to continue.");
			return;
		}
		setSubmitting(true);
		const res = await onSave({
			botToken: token.trim(),
			webhookSecret: customSecret.trim() || undefined,
			deliveryMode: mode,
		});
		setSubmitting(false);
		if (!res.ok) {
			setError(res.error ?? "Save failed.");
			return;
		}
		setToken("");
		setCustomSecret("");
	}

	const publicUrlLooksProd = /^https:\/\//i.test(publicUrl);

	return (
		<form
			onSubmit={handleSubmit}
			className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-4"
		>
			<div>
				<h3 className="text-sm font-semibold text-foreground">Connect your Telegram bot</h3>
				<p className="text-xs text-muted-foreground mt-1">
					Two-minute setup, no command line. Your bot token is stored encrypted in the DB
					(AES-256-GCM) — never logged, never shown back to the UI after save.
				</p>
			</div>

			<ol className="space-y-3 text-xs text-foreground">
				<li className="flex gap-2">
					<span className="w-5 h-5 shrink-0 rounded-full bg-primary/15 text-primary text-[10px] font-bold flex items-center justify-center">
						1
					</span>
					<div>
						Open Telegram and DM{" "}
						<a
							href="https://t.me/BotFather"
							target="_blank"
							rel="noreferrer"
							className="text-primary hover:underline"
						>
							@BotFather
						</a>
						. Send <code className="font-mono">/newbot</code>, pick a name, and copy the token it
						hands you (looks like <code className="font-mono">123456:ABC-DEF…</code>).
					</div>
				</li>
				<li className="flex gap-2">
					<span className="w-5 h-5 shrink-0 rounded-full bg-primary/15 text-primary text-[10px] font-bold flex items-center justify-center">
						2
					</span>
					<div>Pick how AgentPulse should receive Telegram updates:</div>
				</li>
			</ol>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-2">
				<label
					className={`cursor-pointer rounded-md border p-3 text-xs transition-colors ${
						mode === "polling"
							? "border-primary/50 bg-primary/10"
							: "border-border bg-background/40 hover:bg-muted"
					}`}
				>
					<input
						type="radio"
						name="delivery-mode"
						value="polling"
						checked={mode === "polling"}
						onChange={() => setMode("polling")}
						className="sr-only"
					/>
					<div className="font-semibold text-foreground">Polling</div>
					<div className="mt-1 text-muted-foreground">
						AgentPulse dials out to Telegram on a loop. Works from any network — home-lab, NAT,
						air-gapped. No public URL needed. 1–2 second delivery latency.
					</div>
					<div className="mt-1 text-emerald-300">
						✓ Recommended if AgentPulse isn&apos;t publicly reachable
					</div>
				</label>
				<label
					className={`cursor-pointer rounded-md border p-3 text-xs transition-colors ${
						mode === "webhook"
							? "border-primary/50 bg-primary/10"
							: "border-border bg-background/40 hover:bg-muted"
					}`}
				>
					<input
						type="radio"
						name="delivery-mode"
						value="webhook"
						checked={mode === "webhook"}
						onChange={() => setMode("webhook")}
						className="sr-only"
					/>
					<div className="font-semibold text-foreground">Webhook</div>
					<div className="mt-1 text-muted-foreground">
						Telegram pushes updates to{" "}
						<code className="font-mono break-all">
							{publicUrl}/api/v1/channels/telegram/webhook
						</code>
						. Instant delivery, less outbound traffic, but this instance must be reachable over the
						public internet.
					</div>
				</label>
			</div>

			<div className="space-y-1.5">
				<label htmlFor="telegram-token" className="text-xs font-medium text-foreground">
					Bot token
				</label>
				<input
					id="telegram-token"
					type="password"
					autoComplete="off"
					value={token}
					onChange={(e) => setToken(e.target.value)}
					placeholder="123456:ABC-DEF…"
					className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring font-mono"
				/>
			</div>

			{mode === "webhook" && (
				<details
					open={showAdvanced}
					onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}
					className="text-xs"
				>
					<summary className="cursor-pointer text-muted-foreground hover:text-foreground">
						Advanced: bring your own webhook secret
					</summary>
					<div className="mt-2 space-y-1.5">
						<input
							type="text"
							autoComplete="off"
							value={customSecret}
							onChange={(e) => setCustomSecret(e.target.value)}
							placeholder="Leave blank to auto-generate (recommended)"
							className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring font-mono"
						/>
						<p className="text-[11px] text-muted-foreground">
							Must be 24–256 chars. Used to verify that incoming webhooks came from Telegram.
						</p>
					</div>
				</details>
			)}

			{mode === "webhook" && !publicUrlLooksProd && (
				<div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
					This tab&apos;s URL ({publicUrl || "unknown"}) isn&apos;t HTTPS. Telegram will reject the
					webhook. Pick Polling above, or deploy AgentPulse behind HTTPS (or a tunnel like
					Cloudflared / ngrok) before saving.
				</div>
			)}

			{error && (
				<div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-200">
					{error}
				</div>
			)}

			<div className="flex items-center justify-between gap-2">
				<span className="text-[11px] text-muted-foreground">
					You can rotate or remove the token later without downtime.
				</span>
				<button
					type="submit"
					disabled={submitting || !token.trim() || (mode === "webhook" && !publicUrlLooksProd)}
					className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
				>
					{submitting ? "Validating…" : "Save & activate"}
				</button>
			</div>
		</form>
	);
}

function BotCredentialsStatus({
	creds,
	onRotateSecret,
	onClear,
	onSwitchMode,
}: {
	creds: CredentialsState | null;
	onRotateSecret: () => Promise<{ ok: boolean }>;
	onClear: () => void;
	onSwitchMode: (mode: "webhook" | "polling") => Promise<{ ok: boolean }>;
}) {
	const [rotating, setRotating] = useState(false);
	const [switching, setSwitching] = useState(false);
	if (!creds) return null;
	async function doRotate() {
		setRotating(true);
		try {
			await onRotateSecret();
		} finally {
			setRotating(false);
		}
	}
	async function doSwitch(mode: "webhook" | "polling") {
		setSwitching(true);
		try {
			await onSwitchMode(mode);
		} finally {
			setSwitching(false);
		}
	}
	const sourceLabel =
		creds.source === "db"
			? "stored in this instance"
			: creds.source === "env"
				? "loaded from environment"
				: "missing";
	const otherMode = creds.deliveryMode === "webhook" ? "polling" : "webhook";
	return (
		<div className="rounded-md border border-border bg-background/40 p-3 text-xs space-y-2">
			<div className="flex items-center justify-between gap-3 flex-wrap">
				<div>
					<div className="text-foreground font-medium">Bot credentials</div>
					<div className="text-[11px] text-muted-foreground mt-0.5">
						Token {creds.botTokenHint ?? "—"} · {sourceLabel} · delivery:{" "}
						<span className="text-foreground">{creds.deliveryMode}</span>
					</div>
				</div>
				<div className="flex gap-1 flex-wrap">
					<button
						type="button"
						onClick={() => doSwitch(otherMode)}
						disabled={switching}
						className="text-[11px] px-2 py-1 rounded border border-border text-foreground hover:bg-muted disabled:opacity-50"
						title={
							otherMode === "polling"
								? "Use long-polling — works without a public URL"
								: "Use a Telegram webhook — requires this instance to be publicly reachable"
						}
					>
						{switching ? "Switching…" : `Switch to ${otherMode}`}
					</button>
					{creds.deliveryMode === "webhook" && (
						<button
							type="button"
							onClick={doRotate}
							disabled={rotating}
							className="text-[11px] px-2 py-1 rounded border border-border text-foreground hover:bg-muted disabled:opacity-50"
						>
							{rotating ? "Rotating…" : "Rotate webhook secret"}
						</button>
					)}
					<button
						type="button"
						onClick={onClear}
						className="text-[11px] px-2 py-1 rounded border border-border text-red-300 hover:bg-red-500/10"
					>
						Remove
					</button>
				</div>
			</div>
			{creds.source === "env" && (
				<p className="text-[11px] text-amber-300">
					These credentials are coming from environment variables (legacy path). Save through the
					form above to migrate them into the encrypted settings table — you&apos;ll be able to
					rotate without a restart.
				</p>
			)}
		</div>
	);
}

function relTime(iso: string): string {
	const t = new Date(iso).getTime();
	const diff = Date.now() - t;
	const m = Math.floor(diff / 60000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}
