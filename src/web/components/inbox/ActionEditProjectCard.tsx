import { useState } from "react";
import type { ActionRequestDecision, InboxWorkItem } from "../../lib/api.js";
import { KindBadge } from "./shared/KindBadge.js";
import { severityBorderClass, severityPillClass } from "./shared/cardUtils.js";
import { relTime } from "./shared/relTime.js";

type ActionEditProjectItem = Extract<InboxWorkItem, { kind: "action_edit_project" }>;

export function ActionEditProjectCard({
	item,
	onDecide,
}: {
	item: ActionEditProjectItem;
	onDecide: (id: string, decision: ActionRequestDecision) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	async function handleDecide(decision: ActionRequestDecision) {
		setBusy(true);
		setErr(null);
		try {
			await onDecide(item.id, decision);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	const fieldEntries = Object.entries(item.fields);

	return (
		<div className={`rounded-lg border p-4 ${severityBorderClass(item.severity)}`}>
			<div className="flex items-center justify-between gap-2 mb-2">
				<div className="flex items-center gap-2">
					<KindBadge kind={item.kind} />
					<span className="text-sm font-medium">{item.projectName}</span>
				</div>
				<span
					className={`text-[10px] font-mono rounded px-1.5 py-0.5 border ${severityPillClass(item.severity)}`}
				>
					{item.severity}
				</span>
			</div>

			<div className="text-xs text-muted-foreground mb-2 space-y-1">
				{fieldEntries.length > 0 ? (
					fieldEntries.map(([key, value]) => (
						<div key={key}>
							<span className="font-mono">{key}:</span>{" "}
							<span className="font-mono">{value === null ? "(clear)" : String(value)}</span>
						</div>
					))
				) : (
					<div className="italic">No fields specified</div>
				)}
				<div>
					Origin: <span className="font-mono">{item.origin}</span>
				</div>
			</div>

			<div className="flex items-center gap-2 mt-3">
				<button
					type="button"
					disabled={busy}
					onClick={() => handleDecide("applied")}
					className="text-xs px-3 py-1 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 hover:bg-blue-500/30 disabled:opacity-50"
				>
					Approve
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => handleDecide("declined")}
					className="text-xs px-3 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
				>
					Decline
				</button>
				<span className="text-[10px] text-muted-foreground ml-auto">{relTime(item.createdAt)}</span>
			</div>

			{err && <div className="mt-2 text-[11px] text-red-300">{err}</div>}
		</div>
	);
}
