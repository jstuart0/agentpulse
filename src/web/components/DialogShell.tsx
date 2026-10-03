import { type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useDialogFocusTrap } from "../hooks/useDialogFocusTrap.js";
import { registerOpenDialog } from "../lib/dialog-open.js";
import { cn } from "../lib/utils.js";

interface DialogShellProps {
	labelledBy: string;
	describedBy?: string;
	/** Escape and a click on the backdrop. Undefined while the dialog can't be dismissed. */
	onClose: (() => void) | undefined;
	role?: "dialog" | "alertdialog";
	/** "wide" for the two-screen mode dialog; "narrow" for confirmations. */
	size?: "narrow" | "wide";
	/** Where focus lands on close if what opened the dialog is gone (a heading's id). */
	fallbackFocusId?: string;
	children: ReactNode;
}

/**
 * The modal frame the team dialogs share: portal, backdrop, focus trap,
 * Escape to close, scroll lock. A centred card from `md` up. Below it the
 * narrow dialogs (confirmations, short forms) are bottom sheets sized to their
 * content; the wide, two-screen dialog is a full-screen sheet, where a card
 * would leave no room for what it holds.
 */
export function DialogShell({
	labelledBy,
	describedBy,
	onClose,
	role = "dialog",
	size = "narrow",
	fallbackFocusId,
	children,
}: DialogShellProps) {
	const panelRef = useRef<HTMLDivElement>(null);
	useDialogFocusTrap(panelRef, onClose, { fallbackFocusId });

	useEffect(() => {
		const previous = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const markClosed = registerOpenDialog();
		return () => {
			document.body.style.overflow = previous;
			markClosed();
		};
	}, []);

	return createPortal(
		<div
			className={cn(
				"fixed inset-0 z-50 flex justify-center bg-black/60 backdrop-blur-sm md:items-center md:p-4",
				size === "wide" ? "items-stretch" : "items-end",
			)}
			onMouseDown={(e) => {
				if (onClose && e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={panelRef}
				role={role}
				aria-modal="true"
				aria-labelledby={labelledBy}
				aria-describedby={describedBy}
				className={cn(
					"flex w-full flex-col overflow-y-auto border-border bg-card shadow-xl focus:outline-none md:max-h-[90dvh] md:rounded-lg md:border",
					size === "wide"
						? "md:max-w-2xl"
						: "max-h-[90dvh] rounded-t-xl border-t md:max-w-md md:rounded-t-lg md:border-t",
				)}
			>
				{children}
			</div>
		</div>,
		document.body,
	);
}
