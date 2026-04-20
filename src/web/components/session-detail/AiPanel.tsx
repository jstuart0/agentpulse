import { useCallback, useEffect, useState } from "react";
import {
	api,
	type AiProposal,
	type AiProvider,
	type AiWatcherConfig,
	type AiWatcherPolicy,
} from "../../lib/api.js";

interface AiPanelProps {
	sessionId: string;
	sessionIsManaged: boolean;
}

export function AiPanel({ sessionId, sessionIsManaged }: AiPanelProps) {
	const [featureActive, setFeatureActive] = useState<boolean | null>(null);
	const [providers, setProviders] = useState<AiProvider[]>([]);
	const [config, setConfig] = useState<AiWatcherConfig | null>(null);
	const [proposals, setProposals] = useState<AiProposal[]>([]);
	const [loading, setLoading] = useState(true);
	const [banner, setBanner] = useState<{ kind: "error" | "info"; text: string } | null>(null);
	const [advancedOpen, setAdvancedOpen] = useState(false);

	const reload = useCallback(async () => {
		try {
			const status = await api.getAiStatus();
			setFeatureActive(status.active);
			if (!status.build) {
				setLoading(false);
				return;
			}
			const [p, w] = await Promise.all([
				api.getAiProviders(),
				api.getAiWatcher(sessionId),
			]);
			setProviders(p.providers);
			setConfig(w.config);
			setProposals(w.proposals);
		} catch (err) {
			setBanner({ kind: "error", text: String(err) });
		} finally {
			setLoading(false);
		}
	}, [sessionId]);

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
			await api.updateAiWatcher(sessionId, {
				enabled: true,
				providerId: def.id,
				policy: "ask_always",
				maxContinuations: 10,
			});
			await reload();
		} catch (err) {
			setBanner({ kind: "error", text: String(err) });
		}
	}

	async function disableWatcher() {
		try {
			await api.updateAiWatcher(sessionId, { enabled: false });
			await reload();
		} catch (err) {
			setBanner({ kind: "error", text: String(err) });
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
			setBanner({ kind: "error", text: String(err) });
		}
	}

	if (loading) {
		return <div className="p-6 text-sm text-muted-foreground">Loading watcher…</div>;
	}

	if (featureActive === false) {
		return (
			<div className="p-6 text-sm text-muted-foreground">
				AI watcher is disabled. Enable it in <a href="/settings" className="text-primary hover:underline">Settings</a>.
			</div>
		);
	}

	if (providers.length === 0) {
		return (
			<div className="p-6 text-sm text-muted-foreground">
				Add a provider in <a href="/settings" className="text-primary hover:underline">Settings</a> to enable a watcher on this session.
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
								? `${config.continuationsUsed} / ${config.maxContinuations} continuations this cycle`
								: "Off — no LLM calls fire for this session."}
							{!sessionIsManaged && config?.enabled && (
								<span className="ml-2 text-[10px] text-amber-300">
									observed session: watcher can propose, not dispatch
								</span>
							)}
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
			</div>

			{/* HITL card (only when something is waiting) */}
			{openHitl && (
				<HitlCard
					proposal={openHitl}
					onResolved={reload}
					onError={(e) => setBanner({ kind: "error", text: e })}
				/>
			)}

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
										{p.nextPrompt || p.reportSummary || p.errorMessage || "(no content)"}
									</div>
									<div className="text-muted-foreground mt-0.5">
										{new Date(p.createdAt).toLocaleString()} ·{" "}
										{p.tokensIn}/{p.tokensOut} tok
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
								onChange={(e) => updateConfigField("policy", e.target.value as AiWatcherPolicy)}
								className="w-full bg-background border border-border rounded px-2 py-1"
							>
								<option value="ask_always">Always ask</option>
								<option value="ask_on_risk">Ask on risky actions (coming in phase 2)</option>
							</select>
						</Field>
						<Field label="Max continuations per cycle">
							<input
								type="number"
								min={1}
								max={50}
								value={config.maxContinuations}
								onChange={(e) =>
									updateConfigField("maxContinuations", Number.parseInt(e.target.value, 10) || 10)
								}
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
					</div>
				</details>
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
		return <span className={`${base} bg-amber-500/10 text-amber-300 border-amber-500/30`}>awaiting</span>;
	}
	if (state === "hitl_declined") {
		return <span className={`${base} bg-muted/40 text-muted-foreground border-border`}>declined</span>;
	}
	if (state === "hitl_applied") {
		return <span className={`${base} bg-emerald-500/10 text-emerald-300 border-emerald-500/30`}>applied</span>;
	}
	if (state === "cancelled") {
		return <span className={`${base} bg-muted/40 text-muted-foreground border-border`}>cancelled</span>;
	}
	return <span className={`${base} bg-card text-muted-foreground border-border`}>{decision ?? state}</span>;
}

function HitlCard({
	proposal,
	onResolved,
	onError,
}: {
	proposal: AiProposal;
	onResolved: () => void;
	onError: (err: string) => void;
}) {
	const [submitting, setSubmitting] = useState(false);
	const [customOpen, setCustomOpen] = useState(false);
	const [customPrompt, setCustomPrompt] = useState(proposal.nextPrompt ?? "");

	async function act(action: "approve" | "decline" | "custom") {
		setSubmitting(true);
		try {
			await api.decideAiProposal(proposal.id, {
				action,
				customPrompt: action === "custom" ? customPrompt : undefined,
			});
			onResolved();
		} catch (err) {
			onError(String(err));
		} finally {
			setSubmitting(false);
		}
	}

	const why = (proposal.rawResponse as Record<string, unknown> | null)?.why ?? null;

	return (
		<div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
			<div className="flex items-center justify-between">
				<div className="text-sm font-semibold text-amber-200">Watcher wants your approval</div>
				<span className="text-[10px] font-mono text-muted-foreground">
					{new Date(proposal.createdAt).toLocaleTimeString()}
				</span>
			</div>
			<div className="text-xs text-muted-foreground">
				Proposed next prompt:
			</div>
			<pre className="text-xs font-mono bg-background border border-border rounded p-3 whitespace-pre-wrap break-words">
				{proposal.nextPrompt || proposal.reportSummary || "(no content)"}
			</pre>
			{typeof why === "string" && why && (
				<div className="text-xs text-muted-foreground">Why: {why}</div>
			)}

			{customOpen && (
				<div className="space-y-2">
					<label className="text-[10px] uppercase tracking-wider text-muted-foreground">
						Custom prompt
					</label>
					<textarea
						rows={5}
						value={customPrompt}
						onChange={(e) => setCustomPrompt(e.target.value)}
						className="w-full text-xs font-mono bg-background border border-border rounded p-2"
					/>
				</div>
			)}

			<div className="flex items-center gap-2 flex-wrap">
				{!customOpen ? (
					<>
						<button
							type="button"
							onClick={() => act("approve")}
							disabled={submitting || !proposal.nextPrompt}
							className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-40"
						>
							Approve
						</button>
						<button
							type="button"
							onClick={() => setCustomOpen(true)}
							className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted/40"
						>
							Custom…
						</button>
						<button
							type="button"
							onClick={() => act("decline")}
							disabled={submitting}
							className="text-xs px-3 py-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
						>
							Decline
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							onClick={() => act("custom")}
							disabled={submitting || !customPrompt.trim()}
							className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-40"
						>
							Send custom
						</button>
						<button
							type="button"
							onClick={() => setCustomOpen(false)}
							className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted/40"
						>
							Back
						</button>
					</>
				)}
			</div>
		</div>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
				{label}
			</label>
			{children}
		</div>
	);
}
