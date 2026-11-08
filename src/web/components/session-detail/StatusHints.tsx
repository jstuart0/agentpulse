import { useState } from "react";
import { Link } from "react-router-dom";
import { AGENT_METADATA } from "../../../shared/constants.js";
import type { AgentType, Session } from "../../../shared/types.js";
import { useCopyFeedback } from "../../hooks/useCopyFeedback.js";
import { focusLandingAfterRender } from "../../lib/focus-landing.js";
import { forkInfo, forkSourceOf } from "../../lib/fork-session.js";
import { HostSentence } from "./HostSentence.js";
import { forkStatusView } from "./fork-status-view.js";
import { hostControlHint } from "./host-control-view.js";
import { isTakenOver } from "./session-takeover-view.js";

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

/**
 * F239 (tessa, Phase 7 panel): which status-hint component SessionDetailPage
 * renders above the timeline, and its props — extracted as a pure function
 * (same rationale as resolveObserveOnlyHint above: no DOM-testing harness in
 * this codebase, so the branch selection has to be exercised without
 * rendering) so all 3 agent types x managed/unmanaged are covered by a
 * table, not by eyeballing a JSX ternary chain.
 */
export type StatusHintSelection =
	| { component: "ManagedCodexStatus"; managedSession: NonNullable<Session["managedSession"]> }
	| { component: "ManagedClaudeStatus"; managedSession: NonNullable<Session["managedSession"]> }
	| { component: "ManagedForkStatus"; managedSession: NonNullable<Session["managedSession"]> }
	| { component: "CodexStatusHint"; displayName: string }
	| { component: "AgentObserveOnlyHint"; agentType: AgentType };

export function selectStatusHint(
	session: Pick<Session, "agentType" | "managedSession"> &
		Partial<Pick<Session, "forkedFromSessionId" | "metadata">>,
	displayName: string,
): StatusHintSelection {
	if (session.agentType === "claude_code" && session.managedSession && forkInfo(session)) {
		return { component: "ManagedForkStatus", managedSession: session.managedSession };
	}
	if (session.agentType === "codex_cli" && session.managedSession) {
		return { component: "ManagedCodexStatus", managedSession: session.managedSession };
	}
	if (session.agentType === "claude_code" && session.managedSession) {
		return { component: "ManagedClaudeStatus", managedSession: session.managedSession };
	}
	if (session.agentType === "codex_cli") {
		return { component: "CodexStatusHint", displayName };
	}
	// claude_code (unmanaged) and copilot_cli (managed or not — copilot is
	// never launchable, so managedSession is never actually set for it, but
	// the type doesn't forbid it) fall through here. AgentObserveOnlyHint
	// itself renders null for claude_code (resolveObserveOnlyHint has
	// nothing to say), so this is a real "nothing to show" outcome for that
	// case, not a bug — see StatusHints.test.ts.
	return { component: "AgentObserveOnlyHint", agentType: session.agentType };
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

/** Standing notice for a managed session whose host is offline or gone. Its id is what the disabled controls point at. */
export const HOST_CONTROL_HINT_ID = "host-control-hint";

export function HostControlHint({
	session,
}: {
	session: Pick<Session, "hostControl" | "managedSession" | "metadata">;
}) {
	const text = hostControlHint(session);
	if (!text) return null;
	return (
		<div
			id={HOST_CONTROL_HINT_ID}
			className="mx-3 md:mx-6 mt-2 md:mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5"
		>
			<p className="text-[11px] leading-relaxed text-foreground">{text}</p>
		</div>
	);
}

/** A taken-over session was started outside AgentPulse; the heading says so rather than implying a launch. */
export function managedCodexHeading(managedSession: {
	hostAffinityReason?: string | null;
}): string {
	return isTakenOver(managedSession) ? "Managed Codex · taken over" : "Managed Codex";
}

export function ManagedCodexStatus({
	managedSession,
	showSyncState = true,
	showSyncError = true,
}: {
	managedSession: NonNullable<Session["managedSession"]>;
	/** False once the session has ended: a stored error is old news, not something to fix. */
	showSyncError?: boolean;
	/** False when the host isn't live: a "synced" pill would describe a connection that isn't there. */
	showSyncState?: boolean;
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
					<p className="text-xs font-medium text-foreground">
						{managedCodexHeading(managedSession)}
					</p>
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
					{showSyncError && managedSession.providerSyncError && (
						<p className="mt-1 text-[11px] text-red-300">{managedSession.providerSyncError}</p>
					)}
				</div>
				{showSyncState && (
					<span className={`rounded-full border px-2 py-1 text-[10px] font-medium ${syncTone}`}>
						{managedSession.providerSyncState}
					</span>
				)}
			</div>
		</div>
	);
}

/**
 * The block under the header of a continued Claude session: what it continues and where, which settings apply
 * (from the stored mode, before any prompt), and the way back to the original. On a phone it is one line that
 * can be dismissed, with the settings behind a disclosure, so the timeline keeps its room; the first row of the
 * timeline and the prompt box's own "What waits for you" say the same things.
 */
export function ManagedForkStatus({ session }: { session: Session }) {
	const [dismissed, setDismissed] = useState(false);
	const fork = forkInfo(session);
	if (!fork) return null;
	const view = forkStatusView({
		fork,
		source: forkSourceOf(session),
		machine: session.managedSession?.hostName,
		managedState: session.managedSession?.managedState,
	});
	const link =
		view.link.kind === "link" ? (
			<Link
				to={`/sessions/${encodeURIComponent(view.link.sourceId)}`}
				className="inline-flex min-h-[44px] items-center underline underline-offset-2 md:min-h-0"
			>
				{view.link.text}
			</Link>
		) : (
			<span>{view.link.text}</span>
		);
	return (
		<>
			{/* A phone: one line that opens to the settings and the way back; dismissing removes the block. */}
			<div
				data-fork-status=""
				className={`mx-3 mt-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-1 md:mx-6 md:mt-3 md:py-2.5 ${dismissed ? "hidden md:block" : ""}`}
			>
				<div className="flex items-start gap-2 md:hidden">
					<details className="min-w-0 flex-1 text-[11px] text-muted-foreground">
						<summary className="flex min-h-[44px] cursor-pointer items-center">
							<span className="truncate text-foreground">{view.line}</span>
						</summary>
						{view.modeLine ? (
							<p className="pb-1 leading-relaxed [overflow-wrap:anywhere]">
								<HostSentence text={view.modeLine} />
							</p>
						) : null}
						{view.optionsLine ? (
							<p className="pb-1 leading-relaxed [overflow-wrap:anywhere]">{view.optionsLine}</p>
						) : null}
						<p className="[overflow-wrap:anywhere]">{link}</p>
					</details>
					<button
						type="button"
						onClick={() => {
							setDismissed(true);
							// The button is about to go: focus lands on the session header, never on the page.
							focusLandingAfterRender();
						}}
						aria-label="Dismiss this note"
						className="min-h-[44px] min-w-[44px] flex-shrink-0 text-muted-foreground"
					>
						<span aria-hidden="true">×</span>
					</button>
				</div>
				<div className="hidden md:block">
					<p className="text-xs font-medium text-foreground">{view.heading}</p>
					<p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{view.line}</p>
					{view.modeLine ? (
						<p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
							<HostSentence text={view.modeLine} />
						</p>
					) : null}
					{view.optionsLine ? (
						<p className="mt-1 text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
							{view.optionsLine}
						</p>
					) : null}
					<p className="mt-1 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{link}</p>
				</div>
			</div>
			{view.endedLine ? (
				<p className="mx-3 mt-2 text-[11px] leading-relaxed text-foreground md:mx-6">
					{view.endedLine}
				</p>
			) : null}
		</>
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
