import { useState } from "react";
import { Link } from "react-router-dom";
import type { InboxWorkItem } from "../../lib/api.js";
import { KindBadge } from "./shared/KindBadge.js";
import { severityBorderClass, severityPillClass } from "./shared/cardUtils.js";
import { relTime } from "./shared/relTime.js";

type HitlItem = Extract<InboxWorkItem, { kind: "hitl" }>;

export function HitlCard({
	item,
	onDecide,
}: {
	item: HitlItem;
	onDecide: (id: string, action: "approve" | "decline") => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	async function handleDecide(action: "approve" | "decline") {
		setBusy(true);
		setErr(null);
		try {
			await onDecide(item.id, action);
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

			<div className="text-xs text-muted-foreground mb-2">
				Decision: <span className="font-mono">{item.decision}</span>
				{item.why ? ` — ${item.why}` : ""}
			</div>
			{item.prompt && (
				<pre className="text-xs font-mono bg-background/50 border border-border rounded p-2 whitespace-pre-wrap break-words max-h-40 overflow-auto">
					{item.prompt}
				</pre>
			)}
			<div className="flex items-center gap-2 mt-3">
				<button
					type="button"
					disabled={busy}
					onClick={() => handleDecide("approve")}
					className="text-xs px-3 py-1 rounded bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 disabled:opacity-50"
				>
					Approve
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => handleDecide("decline")}
					className="text-xs px-3 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
				>
					Decline
				</button>
				<span className="text-[10px] text-muted-foreground ml-auto">{relTime(item.openedAt)}</span>
			</div>

			{err && <div className="mt-2 text-[11px] text-red-300">{err}</div>}
		</div>
	);
}
