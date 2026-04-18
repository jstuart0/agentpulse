import { useState } from "react";
import { SessionGrid } from "../components/SessionGrid.js";
import { useSessions } from "../hooks/useSessions.js";

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
	const { sessions, stats, isLoading } = useSessions();

	const [filter, setFilter] = useState<string>("active");
	const [search, setSearch] = useState("");

	// Filter by status
	let filtered =
		filter === "all"
			? sessions.filter((s) => s.status !== "archived")
			: sessions.filter((s) => s.status === filter);

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

	const activeSessions = sessions.filter((s) => s.status === "active");
	const workingCount = sessions.filter((s) => s.isWorking).length;

	return (
		<div className="p-3 md:p-6">
			{/* Header */}
			<div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between mb-4 md:mb-6">
				<div>
					<h1 className="text-xl md:text-2xl font-bold text-foreground">Dashboard</h1>
					<p className="text-sm text-muted-foreground mt-0.5 max-w-xl">
						Monitor your AI coding agents in real time
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
				<StatCard
					label="Sessions Today"
					value={stats?.totalSessionsToday ?? 0}
				/>
				<StatCard
					label="Tool Uses Today"
					value={stats?.totalToolUsesToday ?? 0}
				/>
				<StatCard
					label="Total Sessions"
					value={sessions.length}
				/>
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
								({f === "all"
									? sessions.filter((s) => s.status !== "archived").length
									: sessions.filter((s) => s.status === f).length})
							</span>
						</button>
					))}
				</div>

				<div className="relative w-full md:max-w-xs">
					<svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
					</svg>
					<input
						type="text"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search sessions..."
						className="w-full rounded-md border border-input bg-background pl-8 pr-3 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
					/>
					{search && (
						<button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
							<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
						</button>
					)}
				</div>
			</div>

			{/* Session Grid */}
			<SessionGrid sessions={filtered} isLoading={isLoading} />
		</div>
	);
}
