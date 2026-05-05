import { useEffect, useState } from "react";
import { useDropdownClose } from "../../../hooks/useDropdownClose.js";

const SNOOZE_OPTIONS: Array<{ label: string; ms: number }> = [
	{ label: "1h", ms: 60 * 60 * 1000 },
	{ label: "4h", ms: 4 * 60 * 60 * 1000 },
	{ label: "24h", ms: 24 * 60 * 60 * 1000 },
	{ label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
];

/**
 * Snooze duration picker (U-H4).
 *
 * Semantics: `role="group"` wrapping plain `<button>` elements. Each button
 * is a command (activating it immediately fires onSnooze and closes the
 * dropdown). Tab cycles through buttons in DOM order; Enter/Space activates;
 * Escape closes (via useDropdownClose + keydown listener); click-outside
 * closes (via useDropdownClose).
 *
 * Why not listbox/menu: those roles carry a contract (arrow-key navigation,
 * aria-selected / roving tabindex). Dropping the keyboard contract while
 * keeping the role produces confusing screen reader narration. Plain buttons
 * in a group are both honest and sufficient.
 */
export function SnoozeDropdown({
	disabled,
	onSnooze,
}: {
	disabled?: boolean;
	onSnooze: (ms: number) => void | Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const containerRef = useDropdownClose(() => setOpen(false));

	// Escape closes the dropdown.
	useEffect(() => {
		if (!open) return;
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open]);

	return (
		<div className="relative" ref={containerRef}>
			<button
				type="button"
				disabled={disabled}
				aria-expanded={open}
				aria-haspopup="true"
				onClick={() => setOpen((v) => !v)}
				className="text-xs px-3 py-1 rounded border border-border bg-background hover:bg-muted disabled:opacity-50"
			>
				Snooze ▾
			</button>
			{open && (
				<fieldset
					aria-label="Snooze duration"
					className="absolute top-full left-0 mt-1 z-10 rounded border border-border bg-card shadow-lg m-0 p-0"
				>
					{SNOOZE_OPTIONS.map((opt) => (
						<button
							type="button"
							key={opt.label}
							onClick={() => {
								setOpen(false);
								void onSnooze(opt.ms);
							}}
							className="block w-full text-left text-xs px-3 py-1.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{opt.label}
						</button>
					))}
				</fieldset>
			)}
		</div>
	);
}
