import type { RefObject } from "react";

/**
 * What the session page shows when it has no session. `deleted` is for a session the server has said no
 * longer exists (and whose tab is closed): the heading says so itself, and it takes focus, which is what a
 * screen reader announces. Otherwise it is a link that led nowhere, and the wording stays hedged.
 */
export function SessionGoneCard({
	deleted,
	headingRef,
	onDashboard,
	onSearch,
}: {
	deleted: boolean;
	headingRef?: RefObject<HTMLHeadingElement | null>;
	onDashboard: () => void;
	onSearch: () => void;
}) {
	return (
		<div className="flex items-center justify-center p-6 min-h-[40vh]">
			<div className="rounded-lg border border-border bg-card p-8 max-w-sm w-full text-center space-y-4">
				<div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto">
					<svg
						aria-hidden="true"
						className="w-6 h-6 text-muted-foreground"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						strokeWidth={1.5}
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
						/>
					</svg>
				</div>
				<div>
					<h2
						ref={headingRef}
						tabIndex={-1}
						className="text-base font-semibold text-foreground focus:outline-none"
					>
						{deleted ? "Session deleted" : "Session not found"}
					</h2>
					<p className="text-xs text-muted-foreground mt-1">
						{deleted
							? "Its tab is closed."
							: "This session may have been deleted, or the link is incorrect."}
					</p>
				</div>
				<div className="flex flex-col gap-2">
					<button
						type="button"
						onClick={onDashboard}
						className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
					>
						Back to dashboard
					</button>
					<button
						type="button"
						onClick={onSearch}
						className="w-full rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-accent transition-colors"
					>
						Search sessions
					</button>
				</div>
			</div>
		</div>
	);
}
