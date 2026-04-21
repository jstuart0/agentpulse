import type { ControlAction } from "../../../shared/types.js";

/**
 * Tiny card summarizing the last five managed control actions for a
 * session. Pure presentation — extracted from SessionDetailPage so the
 * page body is orchestration, not UI composition.
 */
export function ControlHistory({ actions }: { actions: ControlAction[] }) {
	if (actions.length === 0) return null;
	const recent = actions.slice(-5).reverse();
	return (
		<div className="mx-6 mt-3 rounded-lg border border-border bg-card px-3 py-2.5">
			<div className="text-xs font-medium text-foreground">Control History</div>
			<div className="mt-2 space-y-1.5">
				{recent.map((action) => (
					<div key={action.id} className="flex items-center justify-between gap-3 text-[11px]">
						<span className="text-muted-foreground">
							{action.actionType}
							{action.error ? `: ${action.error}` : ""}
						</span>
						<span className="font-mono text-foreground">{action.status}</span>
					</div>
				))}
			</div>
		</div>
	);
}
