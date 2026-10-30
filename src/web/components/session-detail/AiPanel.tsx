import "../../lib/watcher-api-errors.js";
import { useCallback, useEffect, useState } from "react";
import { plainErrorMessage } from "../../lib/api-errors.js";
import {
	type AiProposal,
	type AiProvider,
	type AiWatcherConfig,
	type AiWatcherPolicy,
	type AiWatcherReport,
	type NotificationChannelRecord,
	type PromptDelivery,
	api,
} from "../../lib/api.js";
import { useAiStatusStore } from "../../stores/ai-status-store.js";
import { useLabsStore } from "../../stores/labs-store.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { SummaryLabsPointer } from "./SummaryLabsPointer.js";
import { WatcherHitlCard } from "./WatcherHitlCard.js";
import { WatcherModeSwitches } from "./WatcherModeSwitches.js";
import { WatcherReports } from "./WatcherReports.js";
import { autoConfirmationPoints } from "./watcher-panel-model.js";

interface AiPanelProps {
	sessionId: string;
}

/** The AI tab: a line about Session summaries while they're off, above whatever the tab itself shows. */
export function AiPanel(props: AiPanelProps) {
	return (
		<>
			<div className="px-4 pt-4 empty:hidden md:px-6">
				<SummaryLabsPointer />
			</div>
			<AiWatcherPanel {...props} />
		</>
	);
}

function AiWatcherPanel({ sessionId }: AiPanelProps) {
	const featureActive = useAiStatusStore((s) => s.status?.active ?? null);
	const [providers, setProviders] = useState<AiProvider[]>([]);
	const [config, setConfig] = useState<AiWatcherConfig | null>(null);
	const [proposals, setProposals] = useState<AiProposal[]>([]);
	const [reports, setReports] = useState<AiWatcherReport[]>([]);
	const [delivery, setDelivery] = useState<PromptDelivery | null>(null);
	const [autoDialog, setAutoDialog] = useState<{ error: string | null; busy: boolean } | null>(
		null,
	);
	const [channels, setChannels] = useState<NotificationChannelRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [banner, setBanner] = useState<{ kind: "error" | "info"; text: string } | null>(null);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const telegramEnabled = useLabsStore((s) => s.isEnabled("telegramChannel"));

	const reload = useCallback(async () => {
		try {
			const status = await useAiStatusStore.getState().refresh();
			if (!status.build) {
				setLoading(false);
				return;
			}
			const [p, w] = await Promise.all([api.getAiProviders(), api.getAiWatcher(sessionId)]);
			setProviders(p.providers);
			setConfig(w.config);
			setProposals(w.proposals);
			setReports(w.reports);
			setDelivery(w.promptDelivery);
			if (telegramEnabled) {
				try {
					const ch = await api.getChannels();
					setChannels(ch.channels.filter((c) => c.verifiedAt && c.isActive));
				} catch {
					setChannels([]);
				}
			}
		} catch (err) {
			setBanner({ kind: "error", text: plainErrorMessage(err) });
		} finally {
			setLoading(false);
		}
	}, [sessionId, telegramEnabled]);

	useEffect(() => {
		void reload();
		const interval = setInterval(reload, 5000);
		return () => clearInterval(interval);
	}, [reload]);

	async function enableWatcher() {
		const def = providers.find((p) => p.isDefault) ?? providers[0];
		if (!def) {
			setBanner({ kind: "error", text: "Add a provider in Settings first." });
			return;
		}
		try {
			// The modes come from the server's defaults for a new watcher.
			await api.updateAiWatcher(sessionId, {
				enabled: true,
				providerId: def.id,
				policy: "ask_always",
				maxContinuations: 10,
			});
			await reload();
		} catch (err) {
			setBanner({ kind: "error", text: plainErrorMessage(err) });
		}
	}

	async function disableWatcher() {
		try {
			await api.updateAiWatcher(sessionId, { enabled: false });
			await reload();
		} catch (err) {
			setBanner({ kind: "error", text: plainErrorMessage(err) });
		}
	}

	async function updateConfigField<K extends keyof AiWatcherConfig>(
		key: K,
		value: AiWatcherConfig[K],
	) {
		if (!config) return;
		try {
			await api.updateAiWatcher(sessionId, { [key]: value } as Record<string, unknown>);
			await reload();
		} catch (err) {
			setBanner({ kind: "error", text: plainErrorMessage(err) });
		}
	}

	async function resetAutoSends() {
		try {
			await api.updateAiWatcher(sessionId, { resetContinuations: true });
			await reload();
		} catch (err) {
			setBanner({ kind: "error", text: plainErrorMessage(err) });
		}
	}

	async function changePolicy(policy: AiWatcherPolicy) {
		if (policy === "auto") {
			setAutoDialog({ error: null, busy: false });
			return;
		}
		await updateConfigField("policy", policy);
	}

	async function confirmAuto() {
		setAutoDialog({ error: null, busy: true });
		try {
			await api.updateAiWatcher(sessionId, { policy: "auto" });
			setAutoDialog(null);
			await reload();
		} catch (err) {
			setAutoDialog({ error: plainErrorMessage(err), busy: false });
		}
	}

	if (loading) {
		return <div className="p-6 text-sm text-muted-foreground">Loading watcher…</div>;
	}

	if (featureActive === false) {
		return (
			<div className="p-6 text-sm text-muted-foreground">
				AI watcher is disabled. Enable it in{" "}
				<a href="/settings" className="text-primary hover:underline">
					Settings
				</a>
				.
			</div>
		);
	}

	if (providers.length === 0) {
		return (
			<div className="p-6 text-sm text-muted-foreground">
				Add a provider in{" "}
				<a href="/settings" className="text-primary hover:underline">
					Settings
				</a>{" "}
				to enable a watcher on this session.
			</div>
		);
	}

	const openHitl = proposals.find((p) => p.state === "hitl_waiting");

	return (
		<div className="p-4 md:p-6 space-y-4">
			{banner && (
				<div
					className={`rounded border p-3 text-xs ${
						banner.kind === "error"
							? "border-red-500/30 bg-red-500/10 text-red-300"
							: "border-primary/30 bg-primary/10 text-primary"
					}`}
				>
					{banner.text}
				</div>
			)}

			{/* Top card: state + primary action */}
			<div className="rounded-lg border border-border bg-card p-4 space-y-3">
				<div className="flex items-center justify-between gap-3">
					<div>
						<div className="flex items-center gap-2">
							<span className="text-sm font-semibold">Watcher</span>
							<WatcherStateBadge state={deriveState(config, openHitl)} />
						</div>
						<div className="text-xs text-muted-foreground mt-0.5">
							{config?.enabled
								? "Watching this session."
								: "Off — no LLM calls fire for this session."}
						</div>
					</div>
					{config?.enabled ? (
						<button
							type="button"
							onClick={disableWatcher}
							className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted/50"
						>
							Disable
						</button>
					) : (
						<button
							type="button"
							onClick={enableWatcher}
							className="text-xs px-3 py-1.5 rounded bg-primary/15 border border-primary/30 text-primary hover:bg-primary/20"
						>
							Enable watcher
						</button>
					)}
				</div>
				{config?.enabled && (
					<WatcherModeSwitches
						config={config}
						delivery={delivery}
						onToggle={(key, value) => void updateConfigField(key, value)}
						onReset={() => void resetAutoSends()}
					/>
				)}
			</div>

			{/* HITL card (only when something is waiting) */}
			{openHitl && (
				<WatcherHitlCard
					proposal={openHitl}
					delivery={delivery ?? { deliverable: false, reason: "observed" }}
					onResolved={reload}
					onError={(e) => setBanner({ kind: "error", text: e })}
				/>
			)}

			<WatcherReports reports={reports} />

			{/* Recent proposals */}
			{proposals.length > 0 && (
				<div className="rounded-lg border border-border bg-card/30">
					<div className="px-4 py-2 border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
						Recent proposals
					</div>
					<ul className="divide-y divide-border">
						{proposals.slice(0, 10).map((p) => (
							<li key={p.id} className="px-4 py-2 flex items-center gap-3">
								<ProposalBadge state={p.state} decision={p.decision} />
								<div className="flex-1 min-w-0 text-xs">
									<div className="truncate font-mono text-foreground/80">
										{p.suggestedPrompt ||
											p.nextPrompt ||
											p.reportSummary ||
											p.errorMessage ||
											"(no content)"}
									</div>
									<div className="text-muted-foreground mt-0.5">
										{new Date(p.createdAt).toLocaleString()} · {p.tokensIn}/{p.tokensOut} tok
										{p.costCents > 0 ? ` · ¢${p.costCents}` : ""}
										{p.usageEstimated ? " (est)" : ""}
									</div>
								</div>
							</li>
						))}
					</ul>
				</div>
			)}

			{/* Advanced */}
			{config?.enabled && (
				<details
					open={advancedOpen}
					onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}
					className="rounded-lg border border-border bg-card/30"
				>
					<summary className="px-4 py-2 text-xs font-semibold cursor-pointer select-none">
						Advanced
					</summary>
					<div className="px-4 pb-4 pt-2 space-y-3 text-xs">
						<Field label="Provider">
							<select
								value={config.providerId}
								onChange={(e) => updateConfigField("providerId", e.target.value)}
								className="w-full bg-background border border-border rounded px-2 py-1"
							>
								{providers.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name} ({p.kind} / {p.model})
									</option>
								))}
							</select>
						</Field>
						<Field label="Policy">
							<select
								value={config.policy}
								onChange={(e) => void changePolicy(e.target.value as AiWatcherPolicy)}
								className="w-full bg-background border border-border rounded px-2 py-1"
							>
								<option value="ask_always">Always ask</option>
								<option value="ask_on_risk">Ask on risky actions</option>
								<option value="auto">Send fixed nudges automatically…</option>
							</select>
							{config.policy === "auto" && !config.autoConfirmedAt && (
								<div className="mt-1 text-[11px] text-amber-300">
									Automatic sending is on hold until you confirm it again.{" "}
									<button
										type="button"
										onClick={() => setAutoDialog({ error: null, busy: false })}
										className="underline"
									>
										Confirm
									</button>
								</div>
							)}
						</Field>
						<Field label="Most automatic sends in total">
							<input
								type="number"
								min={0}
								max={50}
								value={config.maxContinuations}
								onChange={(e) => {
									const value = Number.parseInt(e.target.value, 10);
									if (Number.isFinite(value)) void updateConfigField("maxContinuations", value);
								}}
								className="w-full bg-background border border-border rounded px-2 py-1 font-mono"
							/>
						</Field>
						<Field label="Custom system prompt (optional)">
							<textarea
								rows={4}
								value={config.systemPrompt ?? ""}
								onChange={(e) => updateConfigField("systemPrompt", e.target.value || null)}
								placeholder="Leave blank to use the default watcher policy."
								className="w-full bg-background border border-border rounded px-2 py-1 font-mono text-[11px]"
							/>
						</Field>
						{telegramEnabled && (
							<Field
								label={
									<span className="flex items-center gap-1.5">
										Notification channel
										<span className="rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[9px] font-semibold uppercase px-1 py-0.5">
											Labs
										</span>
									</span>
								}
							>
								<select
									value={config.channelId ?? ""}
									onChange={(e) => updateConfigField("channelId", e.target.value || null)}
									className="w-full bg-background border border-border rounded px-2 py-1"
								>
									<option value="">In-app only</option>
									{channels.map((ch) => (
										<option key={ch.id} value={ch.id}>
											{ch.label} · {ch.kind}
										</option>
									))}
								</select>
								<div className="mt-1 text-[10px] text-muted-foreground">
									{channels.length === 0
										? "No verified channels. Enroll one in Settings → Telegram HITL channel."
										: "HITL requests will be delivered here in addition to the in-app inbox."}
								</div>
							</Field>
						)}
					</div>
				</details>
			)}
			{autoDialog && (
				<ConfirmDialog
					title="Turn on automatic sending?"
					confirmLabel="Turn on automatic sending"
					focusCancel
					busy={autoDialog.busy}
					error={autoDialog.error}
					onConfirm={() => void confirmAuto()}
					onCancel={() => setAutoDialog(null)}
				>
					<ul className="list-disc space-y-1 pl-5">
						{autoConfirmationPoints(config?.maxContinuations ?? 10).map((point) => (
							<li key={point}>{point}</li>
						))}
					</ul>
				</ConfirmDialog>
			)}
		</div>
	);
}

function deriveState(config: AiWatcherConfig | null, openHitl: AiProposal | undefined): string {
	if (!config || !config.enabled) return "off";
	if (openHitl) return "awaiting_human";
	return "idle";
}

function WatcherStateBadge({ state }: { state: string }) {
	const styles: Record<string, string> = {
		off: "bg-muted/40 text-muted-foreground border-border",
		idle: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
		thinking: "bg-violet-500/10 text-violet-300 border-violet-500/30",
		awaiting_human: "bg-amber-500/10 text-amber-300 border-amber-500/30",
		cooling_down: "bg-slate-500/20 text-slate-300 border-slate-500/30",
	};
	return (
		<span
			className={`text-[10px] font-mono rounded border px-1.5 py-0.5 ${styles[state] ?? styles.off}`}
		>
			{state.replace("_", " ")}
		</span>
	);
}

function ProposalBadge({ state, decision }: { state: string; decision: string | null }) {
	const base =
		"flex-shrink-0 text-[10px] font-mono rounded border px-1.5 py-0.5 uppercase tracking-wider";
	if (state === "failed") {
		return <span className={`${base} bg-red-500/10 text-red-300 border-red-500/30`}>failed</span>;
	}
	if (state === "hitl_waiting") {
		return (
			<span className={`${base} bg-amber-500/10 text-amber-300 border-amber-500/30`}>awaiting</span>
		);
	}
	if (state === "hitl_declined") {
		return (
			<span className={`${base} bg-muted/40 text-muted-foreground border-border`}>declined</span>
		);
	}
	if (state === "hitl_applied") {
		return (
			<span className={`${base} bg-emerald-500/10 text-emerald-300 border-emerald-500/30`}>
				applied
			</span>
		);
	}
	if (state === "cancelled") {
		return (
			<span className={`${base} bg-muted/40 text-muted-foreground border-border`}>cancelled</span>
		);
	}
	return (
		<span className={`${base} bg-card text-muted-foreground border-border`}>
			{decision ?? state}
		</span>
	);
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
	return (
		<div>
			<label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
				{label}
			</label>
			{children}
		</div>
	);
}
