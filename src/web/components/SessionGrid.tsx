import { SessionCard } from "./SessionCard.js";
import type { Session } from "../../shared/types.js";

interface SessionGridProps {
	sessions: Session[];
	isLoading: boolean;
}

export function SessionGrid({ sessions, isLoading }: SessionGridProps) {
	if (isLoading) {
		return (
			<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
				{Array.from({ length: 4 }).map((_, i) => (
					<div
						key={i}
						className="rounded-lg border border-border bg-card p-4 animate-pulse"
					>
						<div className="h-4 bg-muted rounded w-3/4 mb-3" />
						<div className="h-3 bg-muted rounded w-1/2 mb-2" />
						<div className="h-3 bg-muted rounded w-2/3" />
					</div>
				))}
			</div>
		);
	}

	if (sessions.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
				<svg className="w-16 h-16 mb-4 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
				</svg>
				<p className="text-lg font-medium mb-1">No sessions yet</p>
				<p className="text-sm">
					Start a Claude Code or Codex session with hooks configured to see it here.
				</p>
			</div>
		);
	}

	// Sort: active first, then by last activity
	const sorted = [...sessions].sort((a, b) => {
		const statusOrder: Record<string, number> = { active: 0, idle: 1, completed: 2, failed: 3 };
		const statusDiff = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
		if (statusDiff !== 0) return statusDiff;
		return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
	});

	return (
		<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
			{sorted.map((session) => (
				<SessionCard key={session.sessionId} session={session} />
			))}
		</div>
	);
}
