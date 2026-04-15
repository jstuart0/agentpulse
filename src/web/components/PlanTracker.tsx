interface PlanTrackerProps {
	plan: string[] | null;
	className?: string;
}

export function PlanTracker({ plan, className }: PlanTrackerProps) {
	if (!plan || plan.length === 0) return null;

	return (
		<div className={className}>
			<div className="space-y-1">
				{plan.map((step, i) => {
					const isCurrent = step.startsWith(">>");
					const display = isCurrent ? step.replace(/^>>\s*/, "") : step;
					const isDone = i < plan.findIndex((s) => s.startsWith(">>"));

					return (
						<div
							key={i}
							className={`flex items-center gap-2 text-xs ${
								isCurrent
									? "text-primary font-medium"
									: isDone
										? "text-muted-foreground line-through"
										: "text-muted-foreground"
							}`}
						>
							<span className="flex-shrink-0 w-4 text-center">
								{isDone ? "\u2713" : isCurrent ? "\u25B6" : "\u25CB"}
							</span>
							<span className="truncate">{display}</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}
