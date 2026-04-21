import { Link } from "react-router-dom";
import type { LaunchRequest } from "../../../shared/types.js";
import { formatLaunchTime, launchModeLabels } from "./utils.js";

/**
 * Lightweight list of the most recent launch requests visible from
 * the preview panel. Kept in its own file so the preview panel can
 * stay focused on launch-spec rendering.
 */
export function RecentLaunchesPanel({
	recentLaunches,
}: {
	recentLaunches: LaunchRequest[];
}) {
	if (recentLaunches.length === 0) return null;
	return (
		<div className="rounded-md border border-border p-3">
			<div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
				Recent launch requests
			</div>
			<div className="space-y-2">
				{recentLaunches.map((launch) => (
					<Link
						key={launch.id}
						to={`/launches/${launch.id}`}
						className="block rounded-md bg-background/60 px-3 py-2 text-xs transition-colors hover:bg-background"
					>
						<div className="flex items-center justify-between gap-2">
							<span className="font-medium text-foreground">
								{launch.agentType === "claude_code" ? "Claude Code" : "Codex CLI"}
							</span>
							<div className="text-right">
								<span className="text-muted-foreground">
									{launch.status} · {launchModeLabels[launch.requestedLaunchMode]}
								</span>
								{formatLaunchTime(launch.createdAt) && (
									<div className="mt-1 text-[10px] text-muted-foreground">
										{formatLaunchTime(launch.createdAt)}
									</div>
								)}
							</div>
						</div>
						<div className="mt-1 break-all text-muted-foreground">{launch.cwd}</div>
						{launch.validationSummary && (
							<div className="mt-1 text-muted-foreground">{launch.validationSummary}</div>
						)}
						{launch.error && <div className="mt-1 text-red-300">{launch.error}</div>}
					</Link>
				))}
			</div>
		</div>
	);
}
