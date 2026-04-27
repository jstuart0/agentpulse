import { Link } from "react-router-dom";
import type { InboxWorkItem } from "../../lib/api.js";
import { KindBadge } from "./shared/KindBadge.js";
import { severityBorderClass, severityPillClass } from "./shared/cardUtils.js";

type RiskyItem = Extract<InboxWorkItem, { kind: "risky" }>;

export function RiskyCard({ item }: { item: RiskyItem }) {
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

			<div className="text-xs text-muted-foreground mb-1">
				Reason: <span className="font-mono">{item.reason}</span>
			</div>
			{item.evidence.length > 0 && (
				<ul className="text-[11px] text-muted-foreground list-disc list-inside">
					{item.evidence.slice(0, 4).map((e) => (
						<li key={e} className="font-mono">
							{e}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
