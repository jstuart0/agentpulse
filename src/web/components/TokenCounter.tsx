interface TokenCounterProps {
	toolUses: number;
	className?: string;
}

export function TokenCounter({ toolUses, className }: TokenCounterProps) {
	return (
		<div className={className}>
			<span className="text-xs text-muted-foreground">
				{toolUses} tool {toolUses === 1 ? "use" : "uses"}
			</span>
		</div>
	);
}
