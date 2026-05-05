import { useState } from "react";
import type { TelegramBotInfo, TelegramWebhookInfo } from "../../lib/api.js";

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
 * Bot identity row + live webhook / polling status.
 * Rendered below BotCredentialsStatus once the bot is configured.
 */
export function BotHeader({
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

/**
 * Bot credentials status bar: token source, delivery mode, rotate / remove.
 */
export function BotCredentialsStatus({
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
