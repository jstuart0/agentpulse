/**
 * Small muted chip that marks a surface as experimental ("Labs"). Used
 * on the header of every feature behind a labs flag so operators know
 * the thing may change or vanish without ceremony.
 */
export function LabsBadge({
	size = "sm",
	title = "This feature is experimental and may change.",
}: {
	size?: "sm" | "md";
	title?: string;
}) {
	const padding = size === "md" ? "px-2 py-0.5" : "px-1.5 py-0.5";
	const textSize = size === "md" ? "text-[11px]" : "text-[10px]";
	return (
		<span
			title={title}
			className={`inline-flex items-center gap-1 rounded ${padding} ${textSize} font-semibold uppercase tracking-wide text-amber-300 bg-amber-500/10 border border-amber-500/30`}
		>
			<span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
			Labs
		</span>
	);
}
