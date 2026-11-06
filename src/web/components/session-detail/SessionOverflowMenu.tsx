import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Session, SessionEvent } from "../../../shared/types.js";
import { useCopyFeedback } from "../../hooks/useCopyFeedback.js";
import { buildExportMarkdown } from "./export-markdown.js";
import { launchLinkLabel } from "./session-takeover-view.js";

interface SessionOverflowMenuProps {
	session: Session;
	displayName: string;
	allEvents: SessionEvent[];
	canStop: boolean;
	/** The menu item's words: "Stop turn" for a launched Claude, "Stop session" for Codex. */
	stopLabel: string;
	/** Why Stop is off for this viewer or host (not the owner, host offline), shown under the disabled item. */
	stopDisabledReason?: string | null;
	/** A stop is on its way: the item is off, with no sentence (the composer says it). */
	stopping?: boolean;
	onJumpTop: () => void;
	onJumpBottom: () => void;
	onStop: () => void;
}

/**
 * Mobile-first overflow menu for secondary session actions. Keeps the
 * header top row tight on phones so messages have more vertical room.
 */
export function SessionOverflowMenu({
	session,
	displayName,
	allEvents,
	canStop,
	stopLabel,
	stopDisabledReason = null,
	stopping = false,
	onJumpTop,
	onJumpBottom,
	onStop,
}: SessionOverflowMenuProps) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const navigate = useNavigate();
	const { copy } = useCopyFeedback();

	useEffect(() => {
		if (!open) return;
		function handlePointer(e: MouseEvent) {
			if (!containerRef.current?.contains(e.target as Node)) {
				setOpen(false);
			}
		}
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", handlePointer);
		document.addEventListener("keydown", handleKey);
		return () => {
			document.removeEventListener("mousedown", handlePointer);
			document.removeEventListener("keydown", handleKey);
		};
	}, [open]);

	async function handleExport() {
		await copy(buildExportMarkdown(displayName, session, allEvents), "Session copied as Markdown");
		setOpen(false);
	}

	return (
		<div className="relative" ref={containerRef}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-label="More actions"
				aria-haspopup="menu"
				aria-expanded={open}
				className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
			>
				<svg
					className="w-4 h-4"
					aria-hidden="true"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M12 5v.01M12 12v.01M12 19v.01"
					/>
				</svg>
			</button>
			{open && (
				<div
					role="menu"
					className="absolute right-0 top-full mt-1 z-30 min-w-[10rem] rounded-md border border-border bg-card shadow-lg py-1 text-xs"
				>
					<MenuItem
						label="Jump to top"
						onClick={() => {
							onJumpTop();
							setOpen(false);
						}}
					/>
					<MenuItem
						label="Jump to bottom"
						onClick={() => {
							onJumpBottom();
							setOpen(false);
						}}
					/>
					<MenuItem label="Copy as Markdown" onClick={handleExport} />
					{session.managedSession?.launchRequestId && (
						<MenuItem
							label={launchLinkLabel(session.managedSession)}
							onClick={() => {
								navigate(`/launches/${session.managedSession?.launchRequestId}`);
								setOpen(false);
							}}
						/>
					)}
					{canStop && (
						<MenuItem
							label={stopLabel}
							tone="danger"
							disabledReason={stopDisabledReason}
							disabled={stopDisabledReason !== null || stopping}
							onClick={() => {
								onStop();
								setOpen(false);
							}}
						/>
					)}
				</div>
			)}
		</div>
	);
}

function MenuItem({
	label,
	onClick,
	tone = "default",
	disabled = false,
	disabledReason = null,
}: {
	label: string;
	onClick: () => void;
	tone?: "default" | "danger";
	disabled?: boolean;
	/** The reason this item is off, said under it. */
	disabledReason?: string | null;
}) {
	const reasonId = useId();
	return (
		<>
			<button
				type="button"
				role="menuitem"
				onClick={onClick}
				disabled={disabled}
				aria-describedby={disabledReason ? reasonId : undefined}
				className={`block w-full text-left px-3 py-1.5 hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent ${
					tone === "danger" ? "text-red-700 dark:text-red-300" : "text-foreground"
				}`}
			>
				{label}
			</button>
			{disabledReason ? (
				<p id={reasonId} className="px-3 pb-1.5 text-[11px] text-muted-foreground">
					{disabledReason}
				</p>
			) : null}
		</>
	);
}
