import { useState } from "react";
import { Link } from "react-router-dom";
import { WATCHER_REPORT_PREFIX } from "../../../shared/types.js";
import { plainErrorMessage } from "../../lib/api-errors.js";
import type { InboxWorkItem } from "../../lib/api.js";
import { formatTimeAgo } from "../../lib/utils.js";
import { KindBadge } from "./shared/KindBadge.js";
import { SnoozeDropdown } from "./shared/SnoozeDropdown.js";
import { severityBorderClass, severityPillClass } from "./shared/cardUtils.js";

type ReportItem = Extract<InboxWorkItem, { kind: "watcher_report" }>;

const VERDICT_LABEL: Record<ReportItem["verdict"], string> = {
	finished: "Finished",
	stuck: "Looks stuck",
	needs_you: "Waiting for you",
};

/**
 * A Notify report. The prefix line is fixed text: everything under it was
 * written by a model from session content AgentPulse does not control.
 */
export function WatcherReportCard({
	item,
	onSnooze,
}: {
	item: ReportItem;
	onSnooze: (id: string, kind: ReportItem["kind"], ms: number) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	return (
		<div className={`rounded-lg border p-4 ${severityBorderClass(item.severity)}`}>
			<div className="flex items-center justify-between gap-2 mb-2">
				<div className="flex items-center gap-2">
					<KindBadge kind={item.kind} />
					<Link
						to={`/sessions/${item.sessionId}`}
						className="text-primary hover:underline font-medium"
					>
						{item.sessionName ?? item.sessionId.slice(0, 8)}
					</Link>
				</div>
				<span
					className={`text-[10px] font-mono rounded px-1.5 py-0.5 border ${severityPillClass(item.severity)}`}
				>
					{VERDICT_LABEL[item.verdict]}
				</span>
			</div>

			<div className="text-[10px] text-muted-foreground mb-1">{WATCHER_REPORT_PREFIX}</div>
			<div className="text-sm whitespace-pre-line break-words">{item.why}</div>
			<div className="flex items-center gap-2 mt-2">
				<SnoozeDropdown
					disabled={busy}
					onSnooze={async (ms) => {
						setBusy(true);
						setErr(null);
						try {
							await onSnooze(item.id, item.kind, ms);
						} catch (e) {
							setErr(plainErrorMessage(e));
						} finally {
							setBusy(false);
						}
					}}
				/>
				<span className="text-[10px] text-muted-foreground ml-auto">{formatTimeAgo(item.at)}</span>
			</div>

			{err && <div className="mt-2 text-[11px] text-red-300">{err}</div>}
		</div>
	);
}
