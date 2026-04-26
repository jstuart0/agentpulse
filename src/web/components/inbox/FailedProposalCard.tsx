import { useState } from "react";
import { Link } from "react-router-dom";
import type { InboxWorkItem } from "../../lib/api.js";
import { severityBorderClass, severityPillClass } from "./shared/cardUtils.js";
import { KindBadge } from "./shared/KindBadge.js";
import { relTime } from "./shared/relTime.js";
import { SnoozeDropdown } from "./shared/SnoozeDropdown.js";

type FailedProposalItem = Extract<InboxWorkItem, { kind: "failed_proposal" }>;

export function FailedProposalCard({
	item,
	onSnooze,
}: {
	item: FailedProposalItem;
	onSnooze: (id: string, kind: FailedProposalItem["kind"], ms: number) => Promise<void>;
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
					{item.severity}
				</span>
			</div>

			<div className="text-xs text-muted-foreground">
				{item.errorSubType ? (
					<>
						<span className="font-mono">{item.errorSubType}</span>
						{item.errorMessage ? `: ${item.errorMessage}` : ""}
					</>
				) : (
					(item.errorMessage ?? "unknown error")
				)}
			</div>
			<div className="flex items-center gap-2 mt-2">
				<SnoozeDropdown
					disabled={busy}
					onSnooze={async (ms) => {
						setBusy(true);
						setErr(null);
						try {
							await onSnooze(item.id, item.kind, ms);
						} catch (e) {
							setErr(e instanceof Error ? e.message : String(e));
						} finally {
							setBusy(false);
						}
					}}
				/>
				<span className="text-[10px] text-muted-foreground ml-auto">{relTime(item.at)}</span>
			</div>

			{err && <div className="mt-2 text-[11px] text-red-300">{err}</div>}
		</div>
	);
}
