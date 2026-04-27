import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FirstRunWelcome } from "../components/FirstRunWelcome.js";
import { SessionGrid } from "../components/SessionGrid.js";
import { useSessions } from "../hooks/useSessions.js";
import { formatDuration } from "../lib/utils.js";
import { useProjectsStore } from "../stores/projects-store.js";
import { useUiPrefsStore } from "../stores/ui-prefs-store.js";

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
	return (
		<div className="rounded-lg border border-border bg-card p-4">
			<p className="text-xs text-muted-foreground mb-1">{label}</p>
			<p className="text-2xl font-bold text-foreground">{value}</p>
			{sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
		</div>
	);
}

export function DashboardPage() {
	const navigate = useNavigate();
	const { sessions, stats, isLoading } = useSessions();
	const showScratch = useUiPrefsStore((s) => s.showScratch);
	const setShowScratch = useUiPrefsStore((s) => s.setShowScratch);
	const projects = useProjectsStore((s) => s.projects);

	// scratch projects are filtered out of the dashboard by default. The toggle
	// reveals them; sessions still render with a dashed border + amber chip in
	// SessionCard so the user can tell them apart.
	const scratchProjectIds = useMemo(() => {
		const ids = new Set<string>();
		for (const p of projects) {
			if ((p.tags ?? []).includes("scratch")) ids.add(p.id);
		}
		return ids;
	}, [projects]);
	const scratchSessionCount = useMemo(
		() => sessions.filter((s) => s.projectId && scratchProjectIds.has(s.projectId)).length,
		[sessions, scratchProjectIds],
	);

	const [filter, setFilter] = useState<string>("active");
	const [search, setSearch] = useState("");
	const [selectedActiveSessionId, setSelectedActiveSessionId] = useState<string | null>(null);

	const visibleSessions = useMemo(
		() =>
			showScratch
				? sessions
				: sessions.filter((s) => !s.projectId || !scratchProjectIds.has(s.projectId)),
		[sessions, showScratch, scratchProjectIds],
	);

	// Filter by status
	let filtered =
		filter === "all"
			? visibleSessions.filter((s) => s.status !== "archived")
			: visibleSessions.filter((s) => s.status === filter);

	// Filter by search
	if (search.trim()) {
		const q = search.toLowerCase();
		filtered = filtered.filter(
			(s) =>
				(s.displayName || "").toLowerCase().includes(q) ||
				(s.cwd || "").toLowerCase().includes(q) ||
				(s.currentTask || "").toLowerCase().includes(q) ||
				(s.gitBranch || "").toLowerCase().includes(q),
		);
	}

	const activeSessions = useMemo(
		() =>
			visibleSessions
				.filter((s) => s.status === "active")
				.sort(
					(a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
				),
		[visibleSessions],
	);
	const workingCount = visibleSessions.filter((s) => s.isWorking).length;
	const selectedActiveSession =
		activeSessions.find((session) => session.sessionId === selectedActiveSessionId) ??
		activeSessions[0] ??
		null;

	useEffect(() => {
		if (!activeSessions.length) {
			setSelectedActiveSessionId(null);
			return;
		}
		if (
			!selectedActiveSessionId ||
			!activeSessions.some((session) => session.sessionId === selectedActiveSessionId)
		) {
			setSelectedActiveSessionId(activeSessions[0].sessionId);
		}
	}, [activeSessions, selectedActiveSessionId]);

	// A fresh install has zero sessions *and* has finished its first fetch
	// (sessions.length === 0 && !isLoading). In that case, skip the KPI/filter
	// chrome entirely and show the Getting-Started card — it collapses the
	// three first-run tasks (mint API key, install hook, start agent) into
	// one screen so new users don't have to hunt through Setup / Settings.
	const showFirstRun = !isLoading && sessions.length === 0;

	if (showFirstRun) {
		return (
			<div className="p-3 md:p-6 max-w-3xl">
				<div className="mb-4">
					<h1 className="text-xl md:text-2xl font-bold text-foreground">Dashboard</h1>
					<p className="text-sm text-muted-foreground mt-0.5">
						No sessions yet — follow the steps below to wire up your first agent.
					</p>
				</div>
				<FirstRunWelcome serverUrl={window.location.origin} />
			</div>
		);
	}

	return (
		<div className="p-3 md:p-6">
			{/* Header */}
			<div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between mb-4 md:mb-6">
				<div>
					<h1 className="text-xl md:text-2xl font-bold text-foreground">Dashboard</h1>
					<p className="text-sm text-muted-foreground mt-0.5 max-w-xl">
						Your AI coding agents, all in one place
					</p>
				</div>
			</div>

			{/* KPI Row */}
			<div className="grid grid-cols-2 xl:grid-cols-4 gap-3 md:gap-4 mb-4 md:mb-6">
				<StatCard
					label="Active Sessions"
					value={stats?.activeSessions ?? 0}
					sub={workingCount > 0 ? `${workingCount} working now` : undefined}
				/>
				<StatCard label="Sessions Today" value={stats?.totalSessionsToday ?? 0} />
				<StatCard label="Tool Uses Today" value={stats?.totalToolUsesToday ?? 0} />
				<StatCard label="Total Sessions" value={sessions.length} />
			</div>

			{/* Search + Filter */}
			<div className="flex flex-col gap-3 mb-4">
				<div className="flex gap-1 bg-muted rounded-lg p-1 overflow-x-auto scrollbar-none">
					{["active", "idle", "completed", "archived", "all"].map((f) => (
						<button
							key={f}
							onClick={() => setFilter(f)}
							className={`shrink-0 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
								filter === f
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							{f.charAt(0).toUpperCase() + f.slice(1)}
							<span className="ml-1 text-muted-foreground">
								(
								{f === "all"
									? visibleSessions.filter((s) => s.status !== "archived").length
									: visibleSessions.filter((s) => s.status === f).length}
								)
							</span>
						</button>
					))}
				</div>

				<div className="flex flex-wrap items-center gap-3">
					<div className="relative w-full md:max-w-xs">
						<svg
							className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={2}
								d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
							/>
						</svg>
						<input
							type="text"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							placeholder="Search sessions..."
							className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
						/>
						{search && (
							<button
								onClick={() => setSearch("")}
								className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
							>
								<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path
										strokeLinecap="round"
										strokeLinejoin="round"
										strokeWidth={2}
										d="M6 18L18 6M6 6l12 12"
									/>
								</svg>
							</button>
						)}
					</div>
					<label
						className="inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none"
						title="When on, sessions whose project is tagged scratch (AI-initiated workspaces) appear with a dashed border and amber chip. Hidden by default."
					>
						<input
							type="checkbox"
							checked={showScratch}
							onChange={(e) => setShowScratch(e.target.checked)}
							className="h-3.5 w-3.5 rounded border-input bg-background text-primary focus:ring-1 focus:ring-ring"
						/>
						Show scratch workspaces
						{scratchSessionCount > 0 && (
							<span className="text-[10px] text-muted-foreground">({scratchSessionCount})</span>
						)}
					</label>
				</div>
			</div>

			{activeSessions.length > 0 && (
				<div className="mb-4 rounded-lg border border-border bg-card">
					<div className="border-b border-border px-3 py-2.5 md:px-4">
						<div className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
							<div>
								<h2 className="text-sm font-semibold text-foreground">Live Sessions</h2>
								<p className="text-xs text-muted-foreground">
									Quick-switch between active sessions without hunting through the grid.
								</p>
							</div>
							<div className="text-xs text-muted-foreground">
								{activeSessions.length} active · {workingCount} working
							</div>
						</div>
					</div>

					<div className="border-b border-border px-2 py-2 md:px-3">
						<div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none">
							{activeSessions.map((session) => {
								const label = session.displayName || session.sessionId.slice(0, 8);
								const isSelected = session.sessionId === selectedActiveSession?.sessionId;
								return (
									<button
										key={session.sessionId}
										onClick={() => setSelectedActiveSessionId(session.sessionId)}
										className={`min-w-0 shrink-0 rounded-lg border px-3 py-2 text-left transition-colors ${
											isSelected
												? "border-primary/30 bg-primary/10 text-primary"
												: "border-border bg-background text-foreground hover:bg-accent"
										}`}
									>
										<div className="flex items-center gap-2">
											<span className="truncate text-sm font-medium">{label}</span>
											{session.isWorking && (
												<span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
													<span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
													Working
												</span>
											)}
										</div>
										<div className="mt-1 truncate text-[11px] text-muted-foreground">
											{session.cwd?.split("/").pop() || "No project"}
										</div>
									</button>
								);
							})}
						</div>
					</div>

					{selectedActiveSession && (
						<div className="grid gap-4 px-3 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:px-4">
							<div className="min-w-0">
								<div className="flex flex-wrap items-center gap-2">
									<div className="text-sm font-semibold text-foreground">
										{selectedActiveSession.displayName ||
											selectedActiveSession.sessionId.slice(0, 8)}
									</div>
									<span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
										{selectedActiveSession.agentType === "claude_code"
											? "Claude Code"
											: "Codex CLI"}
									</span>
									<span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
										{selectedActiveSession.status}
									</span>
								</div>
								<div className="mt-2 grid gap-2 text-xs text-muted-foreground md:grid-cols-2 xl:grid-cols-4">
									<div>
										<span className="text-foreground">Project:</span>{" "}
										{selectedActiveSession.cwd || "Unknown"}
									</div>
									<div>
										<span className="text-foreground">Current task:</span>{" "}
										{selectedActiveSession.currentTask || "No task reported"}
									</div>
									<div>
										<span className="text-foreground">Last activity:</span>{" "}
										{formatDuration(selectedActiveSession.lastActivityAt)}
									</div>
									<div>
										<span className="text-foreground">Tools:</span>{" "}
										{selectedActiveSession.totalToolUses}
									</div>
								</div>
							</div>
							<div className="flex items-start gap-2">
								<button
									onClick={() => navigate(`/sessions/${selectedActiveSession.sessionId}`)}
									className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
								>
									Open Workspace
								</button>
								<button
									onClick={() =>
										navigate(`/sessions/${selectedActiveSession.sessionId}?tab=activity`)
									}
									className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
								>
									Open Activity
								</button>
							</div>
						</div>
					)}
				</div>
			)}

			{/* Session Grid */}
			<SessionGrid sessions={filtered} isLoading={isLoading} />
		</div>
	);
}
