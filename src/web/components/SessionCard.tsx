import { Wand2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Session } from "../../shared/types.js";
import { type SessionIntelligence, api } from "../lib/api.js";
import { extractProjectName, formatDuration, getSessionMode, projectColor } from "../lib/utils.js";
import { useLabsStore } from "../stores/labs-store.js";
import { useProjectsStore } from "../stores/projects-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useTabsStore } from "../stores/tabs-store.js";
import { useUiPrefsStore } from "../stores/ui-prefs-store.js";
import { AgentTypeBadge } from "./AgentTypeBadge.js";
import { IntelligenceBadge } from "./IntelligenceBadge.js";
import { StatusBadge } from "./StatusBadge.js";

interface SessionCardProps {
	session: Session;
	intelligence?: SessionIntelligence | null;
}

export function SessionCard({ session, intelligence }: SessionCardProps) {
	const intelligenceEnabled = useLabsStore((s) => s.isEnabled("intelligenceBadges"));
	const navigate = useNavigate();
	const removeSession = useSessionStore((s) => s.removeSession);
	const updateSession = useSessionStore((s) => s.updateSession);
	const closeTab = useTabsStore((s) => s.close);
	const [renaming, setRenaming] = useState(false);
	const [newName, setNewName] = useState(session.displayName || "");

	const projectName = extractProjectName(session.cwd);
	const name = session.displayName || session.sessionId?.slice(0, 8) || "session";
	const linkedProject = useProjectsStore((s) => s.getById(session.projectId));
	const isScratch = (linkedProject?.tags ?? []).includes("scratch");
	const isInactive =
		session.status === "completed" || session.status === "archived" || session.status === "failed";
	const modeStyle = getSessionMode(session);
	const projectColorsEnabled = useUiPrefsStore((s) => s.projectColors);
	// Deterministic tint per project so sessions in the same repo
	// group visually on the grid and tab bar. Pinned sessions keep
	// their amber theme — don't double-color them. Skips entirely
	// when the user has disabled colors in Settings.
	const color = projectColorsEnabled ? projectColor(session.cwd) : null;

	async function handleRename() {
		if (!newName.trim()) {
			setRenaming(false);
			return;
		}
		await api.renameSession(session.sessionId, newName.trim());
		updateSession({ ...session, displayName: newName.trim() });
		setRenaming(false);
	}

	async function handlePin(e: React.MouseEvent) {
		e.stopPropagation();
		const pinned = !session.isPinned;
		await api.updateSessionPin(session.sessionId, pinned);
		updateSession({ ...session, isPinned: pinned });
	}

	async function handleArchive(e: React.MouseEvent) {
		e.stopPropagation();
		await api.archiveSession(session.sessionId);
		updateSession({ ...session, status: "archived" });
	}

	async function handleDelete(e: React.MouseEvent) {
		e.stopPropagation();
		if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
		await api.deleteSession(session.sessionId);
		removeSession(session.sessionId);
		closeTab(session.sessionId);
	}

	return (
		<div
			onClick={() => navigate(`/sessions/${session.sessionId}`)}
			// Inline style carries the per-project hue. Replaces bg-card
			// with a dark-pastel tint tuned to read as "same repo" at a
			// glance. Pinned sessions keep their amber treatment.
			style={
				!session.isPinned && color
					? { backgroundColor: color.bg, borderColor: color.border }
					: undefined
			}
			className={`group relative cursor-pointer overflow-hidden rounded-lg border bg-card p-3 md:p-4 pl-4 md:pl-5 transition-all hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5 ${
				session.isPinned ? "border-amber-500/30 bg-amber-500/[0.02]" : "border-border"
			} ${isScratch ? "border-dashed" : ""}`}
		>
			{/* Mode accent bar */}
			<div
				aria-hidden="true"
				className={`absolute left-0 top-0 bottom-0 w-1 ${modeStyle.barClass}`}
			/>
			{/* Top row: name + working + status + actions */}
			<div className="flex items-center justify-between gap-2 mb-2">
				<div className="flex items-center gap-2 min-w-0">
					{session.isPinned && (
						<span className="text-amber-500 text-xs flex-shrink-0">&#9733;</span>
					)}
					{renaming ? (
						<input
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							onBlur={handleRename}
							onKeyDown={(e) => {
								if (e.key === "Enter") handleRename();
								if (e.key === "Escape") setRenaming(false);
							}}
							onClick={(e) => e.stopPropagation()}
							className="text-xs font-mono font-bold bg-background border border-primary/30 rounded px-2 py-0.5 w-32 focus:outline-none focus:ring-1 focus:ring-primary"
						/>
					) : (
						<span
							className="text-xs font-mono font-bold text-primary bg-primary/10 border border-primary/20 rounded px-2 py-0.5 truncate max-w-[10rem] md:max-w-none inline-flex items-center gap-1"
							title={
								session.metadata?.aiInitiated === true
									? "Launched from Ask — open conversation"
									: undefined
							}
						>
							{session.metadata?.aiInitiated === true && (
								<Wand2 className="w-3 h-3 flex-shrink-0" aria-label="Launched from Ask" />
							)}
							{name}
						</span>
					)}
					{session.isWorking && (
						<span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5 flex-shrink-0">
							<span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
							working
						</span>
					)}
				</div>
				<div className="flex items-center gap-1 flex-shrink-0">
					{/* Hover actions */}
					<div className="flex md:hidden items-center gap-0.5">
						<button
							onClick={(e) => {
								e.stopPropagation();
								setRenaming(true);
								setNewName(name);
							}}
							title="Rename"
							className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
						>
							<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
								/>
							</svg>
						</button>
						<button
							onClick={handlePin}
							title={session.isPinned ? "Unpin" : "Pin"}
							className="rounded p-1 text-muted-foreground hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
						>
							<svg
								className="w-3 h-3"
								fill={session.isPinned ? "currentColor" : "none"}
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
								/>
							</svg>
						</button>
					</div>
					<div className="hidden md:group-hover:flex items-center gap-0.5">
						<button
							onClick={(e) => {
								e.stopPropagation();
								setRenaming(true);
								setNewName(name);
							}}
							title="Rename"
							className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
						>
							<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
								/>
							</svg>
						</button>
						<button
							onClick={handlePin}
							title={session.isPinned ? "Unpin" : "Pin"}
							className="rounded p-1 text-muted-foreground hover:text-amber-400 hover:bg-amber-500/10 transition-colors"
						>
							<svg
								className="w-3 h-3"
								fill={session.isPinned ? "currentColor" : "none"}
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
								/>
							</svg>
						</button>
						{isInactive && session.status !== "archived" && (
							<button
								onClick={handleArchive}
								title="Archive"
								className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
							>
								<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
									/>
								</svg>
							</button>
						)}
						{isInactive && (
							<button
								onClick={handleDelete}
								title="Delete"
								className="rounded p-1 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors"
							>
								<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
									/>
								</svg>
							</button>
						)}
					</div>
					<StatusBadge status={session.status} />
				</div>
			</div>

			{/* Project + branch */}
			<div className="mb-2">
				<h3 className="text-sm font-semibold truncate text-foreground group-hover:text-primary transition-colors">
					{projectName}
				</h3>
				<div className="flex flex-wrap items-center gap-2 mt-0.5">
					<p
						className="text-xs text-muted-foreground break-all md:truncate"
						title={session.cwd || ""}
					>
						{session.cwd}
					</p>
					{session.gitBranch && (
						<span className="flex-shrink-0 text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0">
							{session.gitBranch}
						</span>
					)}
					{linkedProject && (
						<span className="flex-shrink-0 text-[10px] font-medium text-blue-400 bg-blue-500/10 border border-blue-500/20 rounded px-1.5 py-0">
							{linkedProject.name}
						</span>
					)}
					{isScratch && (
						<span
							title="Scratch workspace — created by AgentPulse for an Ask task"
							className="flex-shrink-0 text-[10px] font-medium text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0"
						>
							scratch
						</span>
					)}
				</div>
			</div>

			{/* Agent type + mode + intelligence + duration + tools */}
			<div className="flex items-center gap-2">
				<AgentTypeBadge agentType={session.agentType} />
				<span
					title={`Session mode: ${modeStyle.label}`}
					className={`flex-shrink-0 text-[10px] font-mono rounded border px-1.5 py-0 ${modeStyle.chipClass}`}
				>
					{modeStyle.label}
				</span>
				{intelligenceEnabled && intelligence && <IntelligenceBadge intelligence={intelligence} />}
				<span className="text-xs text-muted-foreground">{formatDuration(session.startedAt)}</span>
				<span className="text-xs text-muted-foreground ml-auto">{session.totalToolUses} tools</span>
			</div>

			{/* Current task */}
			{session.currentTask && (
				<p className="text-xs text-foreground/70 truncate mt-2">{session.currentTask}</p>
			)}
		</div>
	);
}
