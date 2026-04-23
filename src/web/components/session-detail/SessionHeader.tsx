import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Session, SessionEvent } from "../../../shared/types.js";
import { formatDuration } from "../../lib/utils.js";
import { useLabsStore } from "../../stores/labs-store.js";
import { AgentTypeBadge } from "../AgentTypeBadge.js";
import { StatusBadge } from "../StatusBadge.js";
import { InlineRename } from "./InlineRename.js";
import { SessionOverflowMenu } from "./SessionOverflowMenu.js";
import {
	FilterToggle,
	ModeButton,
	ScrollJumpControls,
	WorkspaceTabButton,
} from "./SharedControls.js";
import type { TimelineMode } from "./TimelineView.js";
import { buildExportMarkdown } from "./export-markdown.js";

export type WorkspaceTab = "overview" | "activity" | "notes" | "instructions" | "launch" | "ai";

export const WORKSPACE_TABS: WorkspaceTab[] = [
	"overview",
	"activity",
	"notes",
	"instructions",
	"launch",
	"ai",
];

interface SessionHeaderProps {
	session: Session;
	displayName: string;
	allEvents: SessionEvent[];
	workspaceTab: WorkspaceTab;
	onSelectTab: (tab: WorkspaceTab) => void;
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
	onStop: () => void;
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
		onStop,
	} = props;
	const navigate = useNavigate();
	const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
	const aiTabEnabled = useLabsStore((s) => s.isEnabled("aiSessionTab"));

	const canStop =
		session.agentType === "codex_cli" && session.managedSession?.managedState === "managed";

	return (
		<div className="sticky top-0 z-10 bg-background border-b border-border flex-shrink-0">
			{/* Top row */}
			<div className="px-3 md:px-6 py-2 md:py-2.5 flex items-center gap-2 md:gap-3">
				<button
					type="button"
					onClick={() => navigate("/")}
					className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
					aria-label="Back to dashboard"
				>
					<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
						onRenamed={onRename}
					/>
					{session.isWorking && (
						<span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5 flex-shrink-0">
							<span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
							working
						</span>
					)}
					{/* Desktop-only inline metadata */}
					<span className="hidden md:inline text-xs text-muted-foreground truncate">
						{session.cwd?.split("/").pop()}
					</span>
					<span className="hidden md:inline text-xs text-muted-foreground">
						{formatDuration(session.startedAt)}
					</span>
					{session.gitBranch && (
						<span className="hidden md:inline text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5">
							{session.gitBranch}
						</span>
					)}
				</div>

				{/* Mobile: single overflow menu. Desktop: full action row. */}
				<div className="ml-auto flex items-center gap-2 flex-shrink-0">
					<div className="hidden md:flex items-center gap-2">
						<ScrollJumpControls onTop={onJumpTop} onBottom={onJumpBottom} />
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
								className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/20 transition-colors"
							>
								Stop
							</button>
						)}
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								navigator.clipboard.writeText(buildExportMarkdown(displayName, session, allEvents));
							}}
							title="Export as Markdown"
							className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
						>
							<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
						<StatusBadge status={session.status} />
					</div>
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
				<div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto md:flex-wrap md:gap-2">
					<WorkspaceTabButton
						active={workspaceTab === "overview"}
						label="Overview"
						onClick={() => onSelectTab("overview")}
					/>
					<WorkspaceTabButton
						active={workspaceTab === "activity"}
						label="Activity"
						badge={session.isWorking ? "Working" : null}
						onClick={() => onSelectTab("activity")}
					/>
					<WorkspaceTabButton
						active={workspaceTab === "notes"}
						label="Notes"
						onClick={() => onSelectTab("notes")}
					/>
					<WorkspaceTabButton
						active={workspaceTab === "instructions"}
						label={session.agentType === "codex_cli" ? "AGENTS.md" : "CLAUDE.md"}
						onClick={() => onSelectTab("instructions")}
					/>
					{session.managedSession?.launchRequestId && (
						<WorkspaceTabButton
							active={workspaceTab === "launch"}
							label="Launch"
							onClick={() => onSelectTab("launch")}
						/>
					)}
					{aiTabEnabled && (
						<WorkspaceTabButton
							active={workspaceTab === "ai"}
							label="AI"
							onClick={() => onSelectTab("ai")}
						/>
					)}
				</div>
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
