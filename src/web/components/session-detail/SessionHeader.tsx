import { AlertTriangle, Check, Info, Undo2, Wand2 } from "lucide-react";
import { type Ref, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { AGENT_METADATA } from "../../../shared/constants.js";
import { getOperationalStatus } from "../../../shared/session-state.js";
import type { AgentType, Session, SessionEvent } from "../../../shared/types.js";
import { useCopyFeedback } from "../../hooks/useCopyFeedback.js";
import { useOwnershipUi } from "../../hooks/useOwnershipUi.js";
import { useSummaryAvailability } from "../../hooks/useSummaryAvailable.js";
import type { OwnerChipModel } from "../../lib/owner-chip.js";
import { RENAME_BLOCKED_REASON, sessionActionAccess } from "../../lib/ownership-ui.js";
import { sessionHostLabel } from "../../lib/session-host.js";
import type { WorkspaceTabId } from "../../lib/session-summary-view.js";
import { formatDuration } from "../../lib/utils.js";
import { type AckActionKind, ackActionLabel } from "../../pages/dashboard-view-state.js";
import { useLabsStore } from "../../stores/labs-store.js";
import { useProjectsStore } from "../../stores/projects-store.js";
import { useUserStore } from "../../stores/user-store.js";
import { AgentTypeBadge } from "../AgentTypeBadge.js";
import { OwnerChip } from "../OwnerChip.js";
import { SessionHostTag } from "../SessionHostTag.js";
import { StatusBadge } from "../StatusBadge.js";
import { InlineRename } from "./InlineRename.js";
import { SessionOverflowMenu } from "./SessionOverflowMenu.js";
import { FilterToggle, ModeButton, ScrollJumpControls } from "./SharedControls.js";
import type { TimelineMode } from "./TimelineView.js";
import { WorkspaceTabBar } from "./WorkspaceTabBar.js";
import { buildExportMarkdown } from "./export-markdown.js";

interface SessionHeaderProps {
	session: Session;
	displayName: string;
	allEvents: SessionEvent[];
	/** The tab showing now; null while a `?tab=summary` link waits for availability. */
	workspaceTab: WorkspaceTabId | null;
	onSelectTab: (tab: WorkspaceTabId) => void;
	/** The word on the Summary tab while a summary runs or a new one is waiting. */
	summaryBadge: string | null;
	mode: TimelineMode;
	onModeChange: (mode: TimelineMode) => void;
	showTools: boolean;
	onToggleTools: () => void;
	showNoisyTools: boolean;
	onToggleNoisyTools: () => void;
	showSystem: boolean;
	onToggleSystem: () => void;
	onJumpTop: () => void;
	onJumpBottom: () => void;
	onRename: (name: string) => void;
	/** F95: re-fetch the session (used after a name reset). */
	onRefresh?: () => Promise<void> | void;
	onStop: () => void;
	/** The one acknowledge-family action available right now (AGEN), or null when none applies (see permissionWaitNote/notOwnerNote for why). */
	ackAction: { kind: AckActionKind; forOwnerName?: string | null; onClick: () => void } | null;
	/** Set when a WAITING session is blocked on an outstanding permission prompt — no button can clear it (deriveAckAction). */
	permissionWaitNote?: string | null;
	/** Set when the viewer isn't the session's owner. */
	notOwnerNote?: string | null;
	/** Where focus goes after an action whose own button is gone (an acknowledge). */
	headerRef?: Ref<HTMLDivElement>;
	/** Team mode: who owns the session, shown in the header on desktop (the page opens on Activity, where the Overview's Owner field isn't). */
	ownerChip?: OwnerChipModel | null;
}

/**
 * Session workspace header. Mobile-aware: on phones the top row is
 * just back + rename + working chip + overflow menu, and the filter
 * toolbar collapses behind a single "Filters" button. Desktop
 * continues to show everything inline.
 */
export function SessionHeader(props: SessionHeaderProps) {
	const {
		session,
		displayName,
		allEvents,
		workspaceTab,
		onSelectTab,
		summaryBadge,
		mode,
		onModeChange,
		showTools,
		onToggleTools,
		showNoisyTools,
		onToggleNoisyTools,
		showSystem,
		onToggleSystem,
		onJumpTop,
		onJumpBottom,
		onRename,
		onRefresh,
		onStop,
		ackAction,
		permissionWaitNote,
		notOwnerNote,
		headerRef,
	} = props;
	const navigate = useNavigate();
	const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
	const summaryAvailable = useSummaryAvailability() === "available";
	const aiTabEnabled = useLabsStore((s) => s.isEnabled("aiSessionTab"));
	const linkedProject = useProjectsStore((s) => s.getById(session.projectId));
	const { copy } = useCopyFeedback();
	const ownership = useOwnershipUi();
	const viewerUserId = useUserStore((s) => s.userId);
	const effectiveRole = useUserStore((s) => s.effectiveRole);
	const access = sessionActionAccess(ownership, session, { userId: viewerUserId, effectiveRole });
	// Operational state (WAITING/WORKING/IDLE/ERROR), FAILED for a
	// dismissed error, or ARCHIVED — the same badge/classifier the
	// dashboard cards use (SessionCard.tsx's badgeStatus), so a WAITING
	// session never reads ACTIVE here just because that's the raw
	// lifecycle status.
	const rawOpStatus = getOperationalStatus(session);
	const operationalStatus = session.isArchived
		? "archived"
		: session.status === "failed" && rawOpStatus === "completed"
			? "failed"
			: rawOpStatus;

	const canStop =
		session.agentType === "codex_cli" && session.managedSession?.managedState === "managed";
	const hostLabel = sessionHostLabel(session);

	return (
		<div
			ref={headerRef}
			tabIndex={-1}
			className="sticky top-0 z-10 bg-background border-b border-border flex-shrink-0 focus:outline-none"
		>
			{/* Top row */}
			<div className="px-3 md:px-6 py-2 md:py-2.5 flex items-center gap-2 md:gap-3">
				<button
					type="button"
					onClick={() => navigate("/")}
					className="self-start mt-1.5 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
					aria-label="Back to dashboard"
				>
					<svg
						className="w-4 h-4"
						aria-hidden="true"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={2}
							d="M15 19l-7-7 7-7"
						/>
					</svg>
				</button>
				<div className="min-w-0 flex items-center gap-2 flex-wrap">
					<InlineRename
						sessionId={session.sessionId}
						currentName={displayName}
						nameSource={session.nameSource}
						nativeName={session.nativeName}
						agentType={session.agentType}
						onRenamed={onRename}
						onRefresh={onRefresh}
						renameBlockedReason={access.canRename ? null : RENAME_BLOCKED_REASON}
					/>
					{session.isWorking && (
						<span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-900 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5 flex-shrink-0">
							<span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
							working
						</span>
					)}
					{/* AGEN: visible on phone widths too -- this was previously
					    inside the "hidden md:flex" action row below, so a phone
					    visitor saw no operational state at all. */}
					<StatusBadge status={operationalStatus} className="flex-shrink-0" />
					{/* Desktop-only inline metadata */}
					<span className="hidden md:inline text-xs text-muted-foreground truncate">
						{session.cwd?.split("/").pop()}
					</span>
					<span className="hidden md:inline text-xs text-muted-foreground">
						{formatDuration(session.startedAt)}
					</span>
					{props.ownerChip && (
						<span className="inline-flex min-w-0">
							<OwnerChip chip={props.ownerChip} widthClass="max-w-[16rem]" />
						</span>
					)}
					{hostLabel && <SessionHostTag label={hostLabel} className="max-w-[16rem]" />}
					{session.gitBranch && (
						<span className="hidden md:inline text-[10px] font-mono text-[hsl(var(--working-text))] dark:text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5">
							{session.gitBranch}
						</span>
					)}
					{linkedProject && (
						<NavLink
							to="/projects"
							className="hidden md:inline text-[10px] font-medium text-blue-800 dark:text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-1.5 py-0.5 hover:bg-blue-500/20 transition-colors"
							title={`Project: ${linkedProject.name}`}
						>
							{linkedProject.name}
						</NavLink>
					)}
					{typeof session.metadata?.askThreadId === "string" && (
						<Link
							to={`/ask?thread=${encodeURIComponent(session.metadata.askThreadId)}`}
							className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
							title="Open the Ask conversation that launched this session"
						>
							<Wand2 className="w-3 h-3" aria-hidden="true" />
							<span>from Ask</span>
						</Link>
					)}
				</div>

				{/* Mobile: single overflow menu. Desktop: full action row. */}
				<div className="ml-auto flex items-center gap-2 flex-shrink-0">
					<div className="hidden md:flex items-center gap-2">
						<ScrollJumpControls onTop={onJumpTop} onBottom={onJumpBottom} />
						{ackAction && (
							<button
								type="button"
								onClick={ackAction.onClick}
								className={
									ackAction.kind === "dismiss_error"
										? "inline-flex min-h-[44px] md:min-h-0 items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-800 dark:text-red-300 hover:bg-red-500/20 transition-colors"
										: ackAction.kind === "restore_error"
											? "inline-flex min-h-[44px] md:min-h-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
											: "inline-flex min-h-[44px] md:min-h-0 items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-medium text-amber-800 dark:text-amber-300 hover:bg-amber-500/20 transition-colors"
								}
							>
								{ackAction.kind === "dismiss_error" ? (
									<AlertTriangle className="w-3 h-3" aria-hidden="true" />
								) : ackAction.kind === "restore_error" ? (
									<Undo2 className="w-3 h-3" aria-hidden="true" />
								) : (
									<Check className="w-3 h-3" aria-hidden="true" />
								)}
								{ackActionLabel(ackAction.kind, ackAction.forOwnerName)}
							</button>
						)}
						{/* No button applies (an outstanding permission prompt, or the
						    viewer isn't the owner) -- say why instead of showing
						    nothing at all (AGEN). */}
						{!ackAction && (permissionWaitNote || notOwnerNote) && (
							<span className="inline-flex items-center gap-1 text-[11px] text-foreground max-w-[14rem]">
								<Info className="w-3 h-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
								<span className="truncate">{permissionWaitNote || notOwnerNote}</span>
							</span>
						)}
						{session.managedSession?.launchRequestId && (
							<button
								type="button"
								onClick={() => navigate(`/launches/${session.managedSession?.launchRequestId}`)}
								className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-accent transition-colors"
							>
								View launch
							</button>
						)}
						{canStop && (
							<button
								type="button"
								onClick={onStop}
								className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-800 dark:text-red-300 hover:bg-red-500/20 transition-colors"
							>
								Stop
							</button>
						)}
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								void copy(
									buildExportMarkdown(displayName, session, allEvents),
									"Session copied as Markdown",
								);
							}}
							title="Export as Markdown"
							className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
						>
							<svg
								className="w-4 h-4"
								aria-hidden="true"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"
								/>
							</svg>
						</button>
						<span className="text-xs text-muted-foreground">{session.totalToolUses} tools</span>
						<AgentTypeBadge agentType={session.agentType} />
					</div>
					{/* AGEN: the primary ack action, visible (not buried in the
					    overflow menu) on phone widths too -- same button the
					    desktop row shows, sized for touch. */}
					{ackAction && (
						<button
							type="button"
							onClick={ackAction.onClick}
							className={
								ackAction.kind === "dismiss_error"
									? "md:hidden inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 text-[11px] font-medium text-red-800 dark:text-red-300"
									: ackAction.kind === "restore_error"
										? "md:hidden inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] font-medium text-muted-foreground"
										: "md:hidden inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 text-[11px] font-medium text-amber-800 dark:text-amber-300"
							}
						>
							{ackAction.kind === "dismiss_error" ? (
								<AlertTriangle className="w-3 h-3" aria-hidden="true" />
							) : ackAction.kind === "restore_error" ? (
								<Undo2 className="w-3 h-3" aria-hidden="true" />
							) : (
								<Check className="w-3 h-3" aria-hidden="true" />
							)}
							{ackActionLabel(ackAction.kind, ackAction.forOwnerName)}
						</button>
					)}
					{!ackAction && (permissionWaitNote || notOwnerNote) && (
						<span className="md:hidden inline-flex items-center gap-1 text-[11px] text-foreground max-w-[10rem]">
							<Info className="w-3 h-3 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
							<span className="truncate">{permissionWaitNote || notOwnerNote}</span>
						</span>
					)}
					<div className="md:hidden">
						<SessionOverflowMenu
							session={session}
							displayName={displayName}
							allEvents={allEvents}
							canStop={canStop}
							onJumpTop={onJumpTop}
							onJumpBottom={onJumpBottom}
							onStop={onStop}
						/>
					</div>
				</div>
			</div>

			{/* Workspace tabs + activity filters */}
			<div className="px-3 md:px-6 py-1.5 md:py-2 border-t border-border/70 flex flex-col items-stretch gap-1.5 md:flex-row md:flex-wrap md:items-center md:justify-between md:gap-3">
				<WorkspaceTabBar
					active={workspaceTab}
					onSelect={onSelectTab}
					instructionsLabel={
						AGENT_METADATA[session.agentType as AgentType]?.instructionsFile ?? "CLAUDE.md"
					}
					isWorking={session.isWorking}
					hasLaunch={Boolean(session.managedSession?.launchRequestId)}
					aiTabEnabled={aiTabEnabled}
					summaryAvailable={summaryAvailable}
					summaryBadge={summaryBadge}
				/>
				{workspaceTab === "activity" && (
					<>
						{/* Mobile: one-button toggle. Desktop: inline toolbar. */}
						<div className="md:hidden flex items-center justify-end">
							<button
								type="button"
								onClick={() => setMobileFiltersOpen((v) => !v)}
								className="text-[11px] px-2.5 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted"
								aria-expanded={mobileFiltersOpen}
							>
								{mobileFiltersOpen ? "Hide filters" : `Filters · ${mode}`}
							</button>
						</div>
						{mobileFiltersOpen && (
							<div className="md:hidden flex flex-wrap items-center gap-1.5 pt-1.5 border-t border-border/60">
								<FilterRow
									mode={mode}
									onModeChange={onModeChange}
									showTools={showTools}
									onToggleTools={onToggleTools}
									showNoisyTools={showNoisyTools}
									onToggleNoisyTools={onToggleNoisyTools}
									showSystem={showSystem}
									onToggleSystem={onToggleSystem}
								/>
							</div>
						)}
						<div className="hidden md:flex flex-wrap items-center gap-2">
							<FilterRow
								mode={mode}
								onModeChange={onModeChange}
								showTools={showTools}
								onToggleTools={onToggleTools}
								showNoisyTools={showNoisyTools}
								onToggleNoisyTools={onToggleNoisyTools}
								showSystem={showSystem}
								onToggleSystem={onToggleSystem}
							/>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

/**
 * Shared mode + filter row for both the mobile collapsed drawer and
 * the desktop inline toolbar.
 */
function FilterRow(props: {
	mode: TimelineMode;
	onModeChange: (mode: TimelineMode) => void;
	showTools: boolean;
	onToggleTools: () => void;
	showNoisyTools: boolean;
	onToggleNoisyTools: () => void;
	showSystem: boolean;
	onToggleSystem: () => void;
}) {
	const {
		mode,
		onModeChange,
		showTools,
		onToggleTools,
		showNoisyTools,
		onToggleNoisyTools,
		showSystem,
		onToggleSystem,
	} = props;
	return (
		<>
			<ModeButton
				active={mode === "prompts"}
				label="Prompts"
				onClick={() => onModeChange("prompts")}
			/>
			<ModeButton
				active={mode === "conversation"}
				label="Conversation"
				onClick={() => onModeChange("conversation")}
			/>
			<ModeButton
				active={mode === "progress"}
				label="Progress"
				onClick={() => onModeChange("progress")}
			/>
			<ModeButton
				active={mode === "terminal"}
				label="Terminal"
				onClick={() => onModeChange("terminal")}
			/>
			<ModeButton active={mode === "debug"} label="Debug" onClick={() => onModeChange("debug")} />
			<FilterToggle
				active={showSystem}
				label="System"
				onClick={onToggleSystem}
				disabled={mode === "prompts" || mode === "conversation"}
			/>
			<FilterToggle
				active={showTools || mode === "debug" || mode === "terminal"}
				label="Tools"
				onClick={onToggleTools}
			/>
			<FilterToggle
				active={showNoisyTools}
				label="Noisy"
				onClick={onToggleNoisyTools}
				disabled={!(showTools || mode === "debug" || mode === "terminal")}
			/>
		</>
	);
}
