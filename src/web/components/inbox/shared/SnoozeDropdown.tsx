import { useState } from "react";

const SNOOZE_OPTIONS: Array<{ label: string; ms: number }> = [
	{ label: "1h", ms: 60 * 60 * 1000 },
	{ label: "4h", ms: 4 * 60 * 60 * 1000 },
	{ label: "24h", ms: 24 * 60 * 60 * 1000 },
	{ label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
];

export function SnoozeDropdown({
	disabled,
	onSnooze,
}: {
	disabled?: boolean;
	onSnooze: (ms: number) => void | Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	return (
		<div className="relative">
			<button
				type="button"
				disabled={disabled}
				onClick={() => setOpen((v) => !v)}
				className="text-xs px-3 py-1 rounded border border-border bg-background hover:bg-muted disabled:opacity-50"
			>
				Snooze ▾
			</button>
			{open && (
				<div className="absolute top-full left-0 mt-1 z-10 rounded border border-border bg-card shadow-lg">
					{SNOOZE_OPTIONS.map((opt) => (
						<button
							type="button"
							key={opt.label}
							onClick={() => {
								setOpen(false);
								void onSnooze(opt.ms);
							}}
							className="block w-full text-left text-xs px-3 py-1.5 hover:bg-muted"
						>
							{opt.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
