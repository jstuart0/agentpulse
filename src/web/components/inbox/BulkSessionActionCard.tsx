import { useState } from "react";
import type { SessionMutationKind } from "../../../shared/types.js";
import type { InboxWorkItem } from "../../lib/api.js";
import { KindBadge } from "./shared/KindBadge.js";
import { severityBorderClass, severityPillClass } from "./shared/cardUtils.js";
import { relTime } from "./shared/relTime.js";

type ActionBulkSessionItem = Extract<InboxWorkItem, { kind: "action_bulk_session" }>;

const actionColors: Record<SessionMutationKind, string> = {
	stop: "bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30",
	archive: "bg-slate-500/20 text-slate-300 border border-slate-500/30 hover:bg-slate-500/30",
	delete: "bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30",
};

export function BulkSessionActionCard({
	item,
	onDecide,
}: {
	item: ActionBulkSessionItem;
	onDecide: (id: string, decision: "applied" | "declined") => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	async function handleDecide(decision: "applied" | "declined") {
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

	const approveColor = actionColors[item.action];
	const actionLabel = item.action.charAt(0).toUpperCase() + item.action.slice(1);

	return (
		<div className={`rounded-lg border p-4 ${severityBorderClass(item.severity)}`}>
			<div className="flex items-center justify-between gap-2 mb-2">
				<div className="flex items-center gap-2">
					<KindBadge kind={item.kind} />
					<span className="text-sm font-medium">
						{actionLabel} {item.sessionCount} session{item.sessionCount !== 1 ? "s" : ""}
					</span>
				</div>
				<span
					className={`text-[10px] font-mono rounded px-1.5 py-0.5 border ${severityPillClass(item.severity)}`}
				>
					{item.severity}
				</span>
			</div>

			<div className="flex flex-wrap gap-1 mb-2">
				{item.sessionNames.map((name) => (
					<span
						key={name}
						className="text-[10px] font-mono bg-muted border border-border rounded px-1.5 py-0.5 truncate max-w-[200px]"
						title={name}
					>
						{name}
					</span>
				))}
				{item.hasMore && (
					<span className="text-[10px] text-muted-foreground px-1.5 py-0.5">
						+{item.sessionCount - item.sessionNames.length} more
					</span>
				)}
			</div>

			{item.exclusionCount > 0 && (
				<div className="text-[11px] text-amber-400/80 mb-2">
					{item.exclusionCount} session{item.exclusionCount !== 1 ? "s" : ""} excluded from this
					action (hook-only or active — cannot be acted on).
				</div>
			)}

			<div className="text-xs text-muted-foreground mb-2">
				Origin: <span className="font-mono">{item.origin}</span>
			</div>

			<div className="flex items-center gap-2 mt-3">
				<button
					type="button"
					disabled={busy}
					onClick={() => handleDecide("applied")}
					className={`text-xs px-3 py-1 rounded disabled:opacity-50 ${approveColor}`}
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
