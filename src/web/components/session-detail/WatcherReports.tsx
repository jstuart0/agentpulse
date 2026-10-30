import { WATCHER_REPORT_PREFIX } from "../../../shared/types.js";
import type { AiReportVerdict, AiWatcherReport } from "../../lib/api.js";
import { formatTimeAgo } from "../../lib/utils.js";
import { VERDICT_LABEL, reportStatusLine } from "./watcher-panel-model.js";

const VERDICT_STYLE: Record<AiReportVerdict, string> = {
	finished: "bg-blue-500/10 text-blue-300 border-blue-500/30",
	stuck: "bg-amber-500/10 text-amber-300 border-amber-500/30",
	needs_you: "bg-red-500/10 text-red-300 border-red-500/30",
};

/**
 * The newest Notify reports for the session. Each starts with the fixed line
 * saying the text under it came from content AgentPulse doesn't control.
 */
export function WatcherReports({ reports }: { reports: AiWatcherReport[] }) {
	if (reports.length === 0) return null;
	return (
		<section aria-label="Recent reports" className="rounded-lg border border-border bg-card/30">
			<h3 className="border-b border-border px-4 py-2 text-xs uppercase tracking-wider text-muted-foreground">
				Recent reports
			</h3>
			<ul className="divide-y divide-border">
				{reports.slice(0, 10).map((r) => {
					const delivered = r.status === "delivered" && r.verdict !== null && r.why !== null;
					return (
						<li key={r.id} className={`space-y-1 px-4 py-2 ${delivered ? "" : "opacity-70"}`}>
							<div className="text-[10px] text-muted-foreground">{WATCHER_REPORT_PREFIX}</div>
							<div className="flex items-center gap-2">
								{delivered && r.verdict && (
									<span
										className={`flex-shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] ${VERDICT_STYLE[r.verdict]}`}
									>
										{VERDICT_LABEL[r.verdict]}
									</span>
								)}
								<span className="text-[10px] text-muted-foreground">
									{formatTimeAgo(r.createdAt)}
								</span>
							</div>
							{delivered && <div className="whitespace-pre-line break-words text-xs">{r.why}</div>}
							<div className="text-[11px] text-muted-foreground">{reportStatusLine(r)}</div>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
