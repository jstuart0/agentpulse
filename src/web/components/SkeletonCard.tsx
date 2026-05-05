/**
 * Generic skeleton card for loading states (U-H2).
 *
 * Renders a shimmer placeholder matching the visual weight of a content
 * card. Import wherever you'd otherwise show a bare "Loading…" string.
 *
 * Props:
 *   lines  — number of text-line shimmer rows (default 3)
 *   className — additional classes on the outer card
 */
export function SkeletonCard({
	lines = 3,
	className = "",
}: {
	lines?: number;
	className?: string;
}) {
	return (
		<div
			aria-hidden="true"
			className={`rounded-lg border border-border bg-card p-4 motion-safe:animate-pulse ${className}`}
		>
			{/* Header row */}
			<div className="flex items-center gap-3 mb-3">
				<div className="h-4 w-24 rounded bg-muted" />
				<div className="h-4 w-16 rounded bg-muted/60 ml-auto" />
			</div>
			{/* Body lines */}
			{Array.from({ length: lines }, (_, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows, index is identity
					key={i}
					className={`h-3 rounded bg-muted/50 mb-2 ${i === lines - 1 ? "w-3/5" : "w-full"}`}
				/>
			))}
		</div>
	);
}

/**
 * A vertical stack of skeleton cards — convenience wrapper for page-level
 * loading states.
 */
export function SkeletonCardList({
	count = 3,
	lines,
}: {
	count?: number;
	lines?: number;
}) {
	return (
		<div className="space-y-3">
			{Array.from({ length: count }, (_, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows, index is identity
				<SkeletonCard key={i} lines={lines} />
			))}
		</div>
	);
}
