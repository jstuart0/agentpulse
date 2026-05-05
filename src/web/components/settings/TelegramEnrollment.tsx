import QRCode from "qrcode";
import { useEffect, useState } from "react";

/**
 * Enrollment flow: QR code + deep link + manual /start command.
 * Shown when a pending channel is awaiting verification.
 */
export function EnrollmentCard({
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

/**
 * Add-channel form: label input + "Generate code" button.
 */
export function AddChannelCard({
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
				<label htmlFor="channel-label" className="sr-only">
					Channel label
				</label>
				<input
					id="channel-label"
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

/**
 * Initial setup wizard (no bot token configured yet). Guides the user
 * through @BotFather → paste token → choose delivery mode → save.
 */
export function BotCredentialsWizard({
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
