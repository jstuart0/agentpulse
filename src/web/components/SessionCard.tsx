import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { StatusBadge } from "./StatusBadge.js";
import { AgentTypeBadge } from "./AgentTypeBadge.js";
import { formatDuration, extractProjectName } from "../lib/utils.js";
import { useSessionStore } from "../stores/session-store.js";
import type { Session } from "../../shared/types.js";

interface SessionCardProps {
	session: Session;
}

export function SessionCard({ session }: SessionCardProps) {
	const navigate = useNavigate();
	const removeSession = useSessionStore((s) => s.removeSession);
	const updateSession = useSessionStore((s) => s.updateSession);
	const [renaming, setRenaming] = useState(false);
	const [newName, setNewName] = useState(session.displayName || "");

	const projectName = extractProjectName(session.cwd);
	const name = session.displayName || session.sessionId?.slice(0, 8) || "session";
	const isInactive = session.status === "completed" || session.status === "archived" || session.status === "failed";

	async function handleRename() {
		if (!newName.trim()) { setRenaming(false); return; }
		await fetch(`/api/v1/sessions/${session.sessionId}/rename`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: newName.trim() }),
		});
		updateSession({ ...session, displayName: newName.trim() });
		setRenaming(false);
	}

	async function handlePin(e: React.MouseEvent) {
		e.stopPropagation();
		const pinned = !session.isPinned;
		await fetch(`/api/v1/sessions/${session.sessionId}/pin`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pinned }),
		});
		updateSession({ ...session, isPinned: pinned });
	}

	async function handleArchive(e: React.MouseEvent) {
		e.stopPropagation();
		await fetch(`/api/v1/sessions/${session.sessionId}/archive`, { method: "PUT" });
		updateSession({ ...session, status: "archived" });
	}

	async function handleDelete(e: React.MouseEvent) {
		e.stopPropagation();
		if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
		await fetch(`/api/v1/sessions/${session.sessionId}`, { method: "DELETE" });
		removeSession(session.sessionId);
	}

	return (
		<div
			onClick={() => navigate(`/sessions/${session.sessionId}`)}
			className={`group cursor-pointer rounded-lg border bg-card p-4 transition-all hover:border-primary/50 hover:shadow-lg hover:shadow-primary/5 ${
				session.isPinned ? "border-amber-500/30 bg-amber-500/[0.02]" : "border-border"
			}`}
		>
			{/* Top row: name + working + status + actions */}
			<div className="flex items-center justify-between gap-2 mb-2">
				<div className="flex items-center gap-2 min-w-0">
					{session.isPinned && <span className="text-amber-500 text-xs flex-shrink-0">&#9733;</span>}
					{renaming ? (
						<input
							autoFocus
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
							onBlur={handleRename}
							onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setRenaming(false); }}
							onClick={(e) => e.stopPropagation()}
							className="text-xs font-mono font-bold bg-background border border-primary/30 rounded px-2 py-0.5 w-32 focus:outline-none focus:ring-1 focus:ring-primary"
						/>
					) : (
						<span className="text-xs font-mono font-bold text-primary bg-primary/10 border border-primary/20 rounded px-2 py-0.5 truncate">
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
					<div className="hidden group-hover:flex items-center gap-0.5">
						<button onClick={(e) => { e.stopPropagation(); setRenaming(true); setNewName(name); }} title="Rename" className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
							<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
						</button>
						<button onClick={handlePin} title={session.isPinned ? "Unpin" : "Pin"} className="rounded p-1 text-muted-foreground hover:text-amber-400 hover:bg-amber-500/10 transition-colors">
							<svg className="w-3 h-3" fill={session.isPinned ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
						</button>
						{isInactive && session.status !== "archived" && (
							<button onClick={handleArchive} title="Archive" className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
								<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" /></svg>
							</button>
						)}
						{isInactive && (
							<button onClick={handleDelete} title="Delete" className="rounded p-1 text-muted-foreground hover:text-red-400 hover:bg-red-500/10 transition-colors">
								<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
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
				<div className="flex items-center gap-2 mt-0.5">
					<p className="text-xs text-muted-foreground truncate" title={session.cwd || ""}>{session.cwd}</p>
					{session.gitBranch && (
						<span className="flex-shrink-0 text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0">
							{session.gitBranch}
						</span>
					)}
				</div>
			</div>

			{/* Agent type + duration + tools */}
			<div className="flex items-center gap-2">
				<AgentTypeBadge agentType={session.agentType} />
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
