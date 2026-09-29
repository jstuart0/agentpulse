import { AGENT_METADATA } from "../../../shared/constants.js";
import type { AgentType, Session } from "../../../shared/types.js";
import { useCopyFeedback } from "../../hooks/useCopyFeedback.js";

/**
 * F24 (D35): the caveat text for an observe-only agent (Copilot CLI), or
 * null when `agentType` has nothing to show. Extracted as a pure function
 * so it's testable without a DOM-rendering harness (see StatusHints.test.ts).
 */
export function resolveObserveOnlyHint(agentType: AgentType): string | null {
	return AGENT_METADATA[agentType]?.observeOnlyHint ?? null;
}

/** F24 (D35): renders AGENT_METADATA[agentType].observeOnlyHint when non-null. */
export function AgentObserveOnlyHint({ agentType }: { agentType: AgentType }) {
	const hint = resolveObserveOnlyHint(agentType);
	if (!hint) return null;
	return (
		<div className="mx-3 md:mx-6 mt-2 md:mt-3 rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/5 px-3 py-2.5">
			<p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
		</div>
	);
}

export function CodexStatusHint({ displayName }: { displayName: string }) {
	const renameCommand = `/rename ${displayName}`;
	const { copy } = useCopyFeedback();

	return (
		<div className="mx-3 md:mx-6 mt-2 md:mt-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-xs font-medium text-foreground">Show this name inside Codex</p>
					<p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
						Run <span className="font-mono text-foreground">{renameCommand}</span> in Codex, then
						enable <span className="font-mono text-foreground">thread-title</span> in{" "}
						<span className="font-mono text-foreground">/statusline</span>. This uses Codex&apos;s
						built-in status line instead of terminal-specific hacks.
					</p>
				</div>
				<button
					type="button"
					onClick={() => void copy(renameCommand, "Rename command copied")}
					className="flex-shrink-0 rounded border border-primary/30 px-2 py-1 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors"
				>
					Copy
				</button>
			</div>
		</div>
	);
}

export function ManagedCodexStatus({
	managedSession,
}: {
	managedSession: NonNullable<Session["managedSession"]>;
}) {
	const syncTone =
		managedSession.providerSyncState === "synced"
			? "text-emerald-400 border-emerald-500/20 bg-emerald-500/10"
			: managedSession.providerSyncState === "failed"
				? "text-red-400 border-red-500/20 bg-red-500/10"
				: "text-amber-400 border-amber-500/20 bg-amber-500/10";

	return (
		<div className="mx-3 md:mx-6 mt-2 md:mt-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-xs font-medium text-foreground">Managed Codex</p>
					<p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
						Thread title sync is managed by AgentPulse.
						{managedSession.hostName && (
							<>
								{" "}
								Host <span className="font-mono text-foreground">{managedSession.hostName}</span>.
							</>
						)}
						{managedSession.providerThreadId && (
							<>
								{" "}
								Thread{" "}
								<span className="font-mono text-foreground">{managedSession.providerThreadId}</span>
								.
							</>
						)}
					</p>
					{managedSession.providerThreadTitle && (
						<p className="mt-1 text-[11px] text-muted-foreground">
							Provider title:{" "}
							<span className="font-mono text-foreground">
								{managedSession.providerThreadTitle}
							</span>
						</p>
					)}
					{managedSession.providerSyncError && (
						<p className="mt-1 text-[11px] text-red-300">{managedSession.providerSyncError}</p>
					)}
				</div>
				<span className={`rounded-full border px-2 py-1 text-[10px] font-medium ${syncTone}`}>
					{managedSession.providerSyncState}
				</span>
			</div>
		</div>
	);
}

export function ManagedClaudeStatus({
	managedSession,
}: {
	managedSession: NonNullable<Session["managedSession"]>;
}) {
	const tone =
		managedSession.managedState === "completed"
			? "text-emerald-400 border-emerald-500/20 bg-emerald-500/10"
			: managedSession.managedState === "failed"
				? "text-red-400 border-red-500/20 bg-red-500/10"
				: "text-sky-400 border-sky-500/20 bg-sky-500/10";
	const mode =
		managedSession.managedState === "headless"
			? "Headless Claude"
			: managedSession.managedState === "interactive_terminal"
				? "Interactive Claude"
				: "Launched Claude";

	return (
		<div className="mx-3 md:mx-6 mt-2 md:mt-3 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2.5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-xs font-medium text-foreground">{mode}</p>
					<p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
						{managedSession.managedState === "interactive_terminal"
							? "This session is controlled in the host terminal and mirrored here for observability."
							: "This session was launched from AgentPulse and streams visible progress into the session timeline."}
						{managedSession.hostName && (
							<>
								{" "}
								Host <span className="font-mono text-foreground">{managedSession.hostName}</span>.
							</>
						)}
					</p>
				</div>
				<span className={`rounded-full border px-2 py-1 text-[10px] font-medium ${tone}`}>
					{managedSession.managedState}
				</span>
			</div>
		</div>
	);
}
