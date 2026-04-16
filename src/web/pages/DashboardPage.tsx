import { useEffect, useState } from "react";
import { SessionGrid } from "../components/SessionGrid.js";
import { useSessions } from "../hooks/useSessions.js";
import { useWebSocket } from "../hooks/useWebSocket.js";
import type { DashboardStats } from "../../shared/types.js";

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
	useWebSocket();

	const [filter, setFilter] = useState<string>("active");

	const filteredSessions =
		filter === "all"
			? sessions.filter((s) => s.status !== "archived")
			: sessions.filter((s) => s.status === filter);

	const activeSessions = sessions.filter((s) => s.status === "active");

	return (
		<div className="p-6">
			{/* Header */}
			<div className="flex items-center justify-between mb-6">
				<div>
					<h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
					<p className="text-sm text-muted-foreground mt-0.5">
						Monitor your AI coding agents in real time
					</p>
				</div>
			</div>

			{/* KPI Row */}
			<div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
				<StatCard
					label="Active Sessions"
					value={stats?.activeSessions ?? 0}
					sub={`${activeSessions.filter((s) => s.agentType === "claude_code").length} Claude, ${activeSessions.filter((s) => s.agentType === "codex_cli").length} Codex`}
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

			{/* Filter tabs */}
			<div className="flex gap-1 mb-4 bg-muted rounded-lg p-1 w-fit">
				{["active", "idle", "completed", "archived", "all"].map((f) => (
					<button
						key={f}
						onClick={() => setFilter(f)}
						className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
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

			{/* Session Grid */}
			<SessionGrid sessions={filteredSessions} isLoading={isLoading} />
		</div>
	);
}
