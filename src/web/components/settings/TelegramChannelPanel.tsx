import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import {
	type ChannelStats,
	type NotificationChannelRecord,
	type TelegramBotInfo,
	type TelegramWebhookInfo,
	api,
} from "../../lib/api.js";

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

	const showToast = useCallback((kind: "ok" | "err", text: string) => {
		setToast({ kind, text });
		setTimeout(() => setToast(null), 4000);
	}, []);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const res = await api.getChannels();
			setChannels(res.channels);
			setBot(res.bot);

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
					.getTelegramWebhookInfo()
					.then((r) => {
						setWebhookInfo(r.webhook);
						setWebhookMatchesExpected(r.matchesExpected);
					})
					.catch(() => {
						setWebhookInfo(null);
						setWebhookMatchesExpected(null);
					});
			}
		} catch (err) {
			showToast("err", err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [showToast]);

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
			await api.setupTelegramWebhook();
			showToast("ok", "Webhook set. Telegram will now deliver updates here.");
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

	if (!bot?.configured) {
		return <EnvVarGuidance missing="TELEGRAM_BOT_TOKEN" />;
	}

	return (
		<div className="space-y-4">
			{toast && (
				<div
					className={`rounded-md border px-3 py-2 text-xs ${
						toast.kind === "ok"
							? "border-emerald-500/30 bg-emerald-500/5 text-emerald-200"
							: "border-red-500/30 bg-red-500/5 text-red-200"
					}`}
				>
					{toast.text}
				</div>
			)}

			<BotHeader
				bot={bot}
				info={botInfo}
				webhook={webhookInfo}
				webhookMatchesExpected={webhookMatchesExpected}
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
				botReady={Boolean(botInfo?.username) && webhookMatchesExpected !== false}
			/>

			<ChannelList
				channels={channels}
				stats={statsByChannel}
				onTest={handleTest}
				onDelete={handleDelete}
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
	onSetupWebhook,
}: {
	bot: { configured: boolean; webhookSecretConfigured: boolean };
	info: TelegramBotInfo | null;
	webhook: TelegramWebhookInfo | null;
	webhookMatchesExpected: boolean | null;
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
	const toneClass =
		webhookStatus.tone === "ok"
			? "text-emerald-300"
			: webhookStatus.tone === "err"
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
						Bot token: {bot.configured ? "set" : "missing"} · webhook secret:{" "}
						{bot.webhookSecretConfigured ? "set" : "missing"}
					</div>
				</div>
				<button
					type="button"
					onClick={onSetupWebhook}
					disabled={!bot.webhookSecretConfigured}
					className="text-xs px-3 py-1 rounded border border-border bg-background hover:bg-muted disabled:opacity-50"
				>
					{webhookStatus.text === "live" ? "Re-send webhook" : "Set webhook"}
				</button>
			</div>
			<div className="flex flex-wrap items-center gap-2 text-[11px]">
				<span className={`font-mono ${toneClass}`}>● webhook {webhookStatus.text}</span>
				{webhook?.pendingUpdateCount != null && (
					<span className="text-muted-foreground">
						pending updates: {webhook.pendingUpdateCount}
					</span>
				)}
				{webhook?.lastErrorDate && (
					<span className="text-muted-foreground">
						last error: {new Date(webhook.lastErrorDate * 1000).toLocaleString()}
					</span>
				)}
			</div>
			{!bot.webhookSecretConfigured && <EnvVarGuidance missing="TELEGRAM_WEBHOOK_SECRET" compact />}
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
}: {
	channels: NotificationChannelRecord[];
	stats: Record<string, ChannelStats>;
	onTest: (id: string) => void;
	onDelete: (id: string) => void;
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

function EnvVarGuidance({
	missing,
	compact = false,
}: {
	missing: "TELEGRAM_BOT_TOKEN" | "TELEGRAM_WEBHOOK_SECRET";
	compact?: boolean;
}) {
	const blurb =
		missing === "TELEGRAM_BOT_TOKEN"
			? "Talk to @BotFather on Telegram to create a bot and get a token."
			: "Generate a random ≥24-char string. Telegram echoes it back on every webhook callback so AgentPulse can verify the sender.";
	return (
		<div
			className={`rounded-md border border-amber-500/30 bg-amber-500/5 ${compact ? "p-2" : "p-3"} text-xs text-amber-200 space-y-2`}
		>
			<div>
				<code className="font-mono">{missing}</code> is not set. {blurb}
			</div>
			<details>
				<summary className="cursor-pointer text-amber-300 hover:text-amber-200">
					Where do I set this?
				</summary>
				<div className="mt-2 space-y-2 text-amber-100/90">
					<div>
						<div className="font-semibold text-amber-200">Docker:</div>
						<pre className="bg-background/50 rounded p-2 overflow-x-auto font-mono text-[10px]">{`docker run -e ${missing}=<value> ...`}</pre>
					</div>
					<div>
						<div className="font-semibold text-amber-200">Local (macOS / Linux):</div>
						<pre className="bg-background/50 rounded p-2 overflow-x-auto font-mono text-[10px]">{`echo '${missing}=<value>' >> ~/.agentpulse/.env.local
# restart the service`}</pre>
					</div>
					<div>
						<div className="font-semibold text-amber-200">Kubernetes:</div>
						<pre className="bg-background/50 rounded p-2 overflow-x-auto font-mono text-[10px]">{`kubectl -n <ns> patch secret agentpulse-secrets \\
  --type=json -p='[{"op":"add","path":"/data/${missing}","value":"'$(echo -n "<value>" | base64)'"}]'`}</pre>
					</div>
				</div>
			</details>
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
