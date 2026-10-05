import { SummaryLink } from "./SummaryLink.js";

/** Open Workspace, Open Activity and (while Summaries are available) Open Summary for the dashboard's selected session. */
export function SelectedSessionActions({
	sessionId,
	navigate,
}: { sessionId: string; navigate: (to: string) => void }) {
	return (
		<div className="flex flex-wrap items-start gap-2">
			<button
				type="button"
				onClick={() => navigate(`/sessions/${sessionId}`)}
				className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
			>
				Open Workspace
			</button>
			<button
				type="button"
				onClick={() => navigate(`/sessions/${sessionId}?tab=activity`)}
				className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
			>
				Open Activity
			</button>
			<SummaryLink sessionId={sessionId} variant="button" />
		</div>
	);
}
