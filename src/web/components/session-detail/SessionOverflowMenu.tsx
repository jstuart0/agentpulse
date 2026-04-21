import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Session, SessionEvent } from "../../../shared/types.js";
import { buildExportMarkdown } from "./export-markdown.js";

interface SessionOverflowMenuProps {
	session: Session;
	displayName: string;
	allEvents: SessionEvent[];
	canStop: boolean;
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
	onJumpTop,
	onJumpBottom,
	onStop,
}: SessionOverflowMenuProps) {
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const navigate = useNavigate();

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

	function handleExport() {
		navigator.clipboard.writeText(buildExportMarkdown(displayName, session, allEvents));
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
				<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
							label="View launch"
							onClick={() => {
								navigate(`/launches/${session.managedSession?.launchRequestId}`);
								setOpen(false);
							}}
						/>
					)}
					{canStop && (
						<MenuItem
							label="Stop session"
							tone="danger"
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
}: {
	label: string;
	onClick: () => void;
	tone?: "default" | "danger";
}) {
	return (
		<button
			type="button"
			role="menuitem"
			onClick={onClick}
			className={`block w-full text-left px-3 py-1.5 hover:bg-muted ${
				tone === "danger" ? "text-red-300" : "text-foreground"
			}`}
		>
			{label}
		</button>
	);
}
