import { ArrowDownToLine, ArrowUpToLine } from "lucide-react";
import { cn } from "../../lib/utils.js";

export function ScrollJumpControls({
	onTop,
	onBottom,
}: {
	onTop: () => void;
	onBottom: () => void;
}) {
	return (
		<div className="flex items-center gap-1">
			<button
				onClick={onTop}
				title="Jump to top"
				aria-label="Jump to top"
				className="rounded border border-border p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
			>
				<ArrowUpToLine className="h-3.5 w-3.5" />
			</button>
			<button
				onClick={onBottom}
				title="Jump to bottom"
				aria-label="Jump to bottom"
				className="rounded border border-border p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
			>
				<ArrowDownToLine className="h-3.5 w-3.5" />
			</button>
		</div>
	);
}

export function ModeButton({
	active,
	label,
	onClick,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			onClick={onClick}
			className={cn(
				"rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
				active
					? "bg-primary text-primary-foreground"
					: "text-muted-foreground hover:text-foreground hover:bg-muted",
			)}
		>
			{label}
		</button>
	);
}

export function FilterToggle({
	active,
	label,
	onClick,
	disabled = false,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors",
				active
					? "border-primary/30 bg-primary/10 text-primary"
					: "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
				disabled && "cursor-not-allowed opacity-50",
			)}
		>
			{label}
		</button>
	);
}

export function WorkspaceTabButton({
	active,
	label,
	badge,
	onClick,
}: {
	active: boolean;
	label: string;
	badge?: string | null;
	onClick: () => void;
}) {
	return (
		<button
			onClick={onClick}
			className={cn(
				"inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors",
				active
					? "bg-primary text-primary-foreground"
					: "text-muted-foreground hover:text-foreground hover:bg-muted",
			)}
		>
			<span>{label}</span>
			{badge ? (
				<span
					className={cn(
						"rounded-full px-1.5 py-0.5 text-[10px]",
						active
							? "bg-primary-foreground/15 text-primary-foreground"
							: "bg-amber-500/10 text-amber-400",
					)}
				>
					{badge}
				</span>
			) : null}
		</button>
	);
}
