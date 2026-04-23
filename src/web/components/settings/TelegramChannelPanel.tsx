import { useCallback, useEffect, useState } from "react";
import { type NotificationChannelRecord, api } from "../../lib/api.js";

/**
 * Settings panel for Telegram HITL channels. Shows the enrollment flow
 * (create a pending channel → display /start code → poll for verified
 * status), lists existing channels, and exposes the webhook setup
 * buttons for admins.
 */
export function TelegramChannelPanel() {
	const [channels, setChannels] = useState<NotificationChannelRecord[]>([]);
	const [bot, setBot] = useState<{
		configured: boolean;
		webhookSecretConfigured: boolean;
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [label, setLabel] = useState("My Telegram");
	const [pending, setPending] = useState<{
		channelId: string;
		enrollmentCode: string;
		instructions: string;
	} | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await api.getChannels();
			setChannels(res.channels);
			setBot(res.bot);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// Poll for verification while a pending enrollment is outstanding.
	useEffect(() => {
		if (!pending) return;
		const interval = setInterval(async () => {
			try {
				const res = await api.getChannel(pending.channelId);
				if (res.channel.verifiedAt) {
					setPending(null);
					await load();
				}
			} catch {
				// ignore transient
			}
		}, 3000);
		return () => clearInterval(interval);
	}, [pending, load]);

	async function handleCreate() {
		setError(null);
		try {
			const res = await api.createChannel({ kind: "telegram", label });
			setPending({
				channelId: res.channel.id,
				enrollmentCode: res.enrollmentCode,
				instructions: res.instructions,
			});
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleDelete(id: string) {
		if (!confirm("Delete this Telegram channel? HITL requests will stop forwarding.")) return;
		await api.deleteChannel(id).catch(() => {});
		await load();
	}

	async function handleSetupWebhook() {
		setError(null);
		try {
			const res = await api.setupTelegramWebhook();
			alert(`Webhook set: ${res.webhookUrl}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
	if (!bot?.configured) {
		return (
			<div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
				Set <code className="font-mono">TELEGRAM_BOT_TOKEN</code> in the server environment to
				enable Telegram HITL channels. Get a token from @BotFather on Telegram and restart
				AgentPulse.
			</div>
		);
	}

	return (
		<div className="space-y-3">
			{!bot.webhookSecretConfigured && (
				<div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
					<code className="font-mono">TELEGRAM_WEBHOOK_SECRET</code> is not set. Telegram can't
					authenticate its webhook callbacks to AgentPulse without it.
				</div>
			)}

			<div className="flex items-center justify-between gap-2">
				<div className="text-xs text-muted-foreground">
					{channels.length} channel{channels.length === 1 ? "" : "s"} configured
				</div>
				<button
					type="button"
					onClick={handleSetupWebhook}
					disabled={!bot.webhookSecretConfigured}
					className="text-xs px-3 py-1 rounded border border-border bg-background hover:bg-muted disabled:opacity-50"
				>
					Set webhook
				</button>
			</div>

			{pending && (
				<div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-1 text-xs">
					<div className="font-semibold text-foreground">Finish enrollment</div>
					<div className="text-muted-foreground">{pending.instructions}</div>
					<div className="font-mono text-primary bg-background/60 px-2 py-1 rounded inline-block">
						/start {pending.enrollmentCode}
					</div>
					<div className="text-muted-foreground mt-1">Waiting for confirmation from Telegram…</div>
				</div>
			)}

			<div className="rounded-md border border-border bg-background/40 p-3 space-y-2">
				<div className="text-xs font-medium text-foreground">Add a channel</div>
				<div className="flex items-center gap-2">
					<input
						type="text"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						placeholder="Label"
						className="flex-1 text-xs bg-background border border-border rounded px-2 py-1"
					/>
					<button
						type="button"
						onClick={handleCreate}
						disabled={!label.trim()}
						className="text-xs px-3 py-1 rounded bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 disabled:opacity-50"
					>
						Generate code
					</button>
				</div>
			</div>

			{channels.length > 0 && (
				<ul className="space-y-1">
					{channels.map((ch) => (
						<li
							key={ch.id}
							className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"
						>
							<div>
								<div className="text-foreground font-medium">{ch.label}</div>
								<div className="text-[10px] text-muted-foreground">
									{ch.kind} · {ch.verifiedAt ? "verified" : "pending"}
									{ch.isActive ? "" : " · inactive"}
								</div>
							</div>
							<button
								type="button"
								onClick={() => handleDelete(ch.id)}
								className="text-[11px] px-2 py-1 rounded border border-border text-red-300 hover:bg-red-500/10"
							>
								Delete
							</button>
						</li>
					))}
				</ul>
			)}

			{error && <div className="text-xs text-red-300">{error}</div>}
		</div>
	);
}
