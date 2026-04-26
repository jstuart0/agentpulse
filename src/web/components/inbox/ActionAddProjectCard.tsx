import { useState } from "react";
import type { InboxWorkItem } from "../../lib/api.js";
import { severityBorderClass, severityPillClass } from "./shared/cardUtils.js";
import { KindBadge } from "./shared/KindBadge.js";
import { relTime } from "./shared/relTime.js";

type ActionAddProjectItem = Extract<InboxWorkItem, { kind: "action_add_project" }>;

export function ActionAddProjectCard({
	item,
	onDecide,
}: {
	item: ActionAddProjectItem;
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

	return (
		<div className={`rounded-lg border p-4 ${severityBorderClass(item.severity)}`}>
			<div className="flex items-center justify-between gap-2 mb-2">
				<div className="flex items-center gap-2">
					<KindBadge kind={item.kind} />
					<span className="text-sm font-medium">New project request</span>
				</div>
				<span
					className={`text-[10px] font-mono rounded px-1.5 py-0.5 border ${severityPillClass(item.severity)}`}
				>
					{item.severity}
				</span>
			</div>

			<div className="text-xs text-muted-foreground mb-2 space-y-1">
				<div>
					Name: <span className="font-mono">{item.projectName}</span>
				</div>
				<div className="font-mono text-[10px] break-all">{item.projectCwd}</div>
				{item.defaultAgentType && (
					<div>
						Agent: <span className="font-mono">{item.defaultAgentType}</span>
					</div>
				)}
				{item.defaultLaunchMode && (
					<div>
						Mode: <span className="font-mono">{item.defaultLaunchMode}</span>
					</div>
				)}
				{item.defaultModel && (
					<div>
						Model: <span className="font-mono">{item.defaultModel}</span>
					</div>
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
