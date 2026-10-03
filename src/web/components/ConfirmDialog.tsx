import { type ReactNode, useId, useRef } from "react";
import { DialogShell } from "./DialogShell.js";

interface ConfirmDialogProps {
	title: string;
	children: ReactNode;
	confirmLabel: string;
	cancelLabel?: string;
	/** Red confirm button, and Cancel focused first: the safe default for something that can't be undone. */
	destructive?: boolean;
	/** Cancel is focused first without the red styling: for a change that is deliberate but replaces something. */
	focusCancel?: boolean;
	busy?: boolean;
	/** The confirm button waits (for data the sentence depends on) without freezing Cancel. */
	confirmDisabled?: boolean;
	/** A refusal or failure from the last attempt, in plain words. */
	error?: string | null;
	/** Where focus lands on close if the control that opened this is gone. */
	fallbackFocusId?: string;
	onConfirm: () => void;
	onCancel: () => void;
}

/**
 * A small confirmation: what will happen, in specifics, and two buttons. The
 * safe button is focused first; Escape and the backdrop cancel (not while the
 * request is running).
 */
export function ConfirmDialog({
	title,
	children,
	confirmLabel,
	cancelLabel = "Cancel",
	destructive = false,
	focusCancel = false,
	busy = false,
	confirmDisabled = false,
	error = null,
	fallbackFocusId,
	onConfirm,
	onCancel,
}: ConfirmDialogProps) {
	const headingId = useId();
	const descriptionId = useId();
	const cancelRef = useRef<HTMLButtonElement>(null);

	return (
		<DialogShell
			labelledBy={headingId}
			describedBy={descriptionId}
			role={destructive ? "alertdialog" : "dialog"}
			onClose={busy ? undefined : onCancel}
			fallbackFocusId={fallbackFocusId}
		>
			<div className="flex-1 p-5 md:p-6">
				<h2 id={headingId} className="mb-2 text-base font-semibold text-foreground">
					{title}
				</h2>
				<div id={descriptionId} className="space-y-3 text-sm text-hint">
					{children}
				</div>
				{error && (
					<p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
						{error}
					</p>
				)}
			</div>
			<div className="flex flex-col-reverse gap-2 border-t border-border p-4 md:flex-row md:justify-end md:px-6">
				<button
					ref={cancelRef}
					type="button"
					data-autofocus={destructive || focusCancel ? "" : undefined}
					onClick={onCancel}
					disabled={busy}
					className="min-h-[44px] rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:opacity-50 md:min-h-0"
				>
					{cancelLabel}
				</button>
				<button
					type="button"
					data-autofocus={destructive || focusCancel ? undefined : ""}
					onClick={onConfirm}
					disabled={busy || confirmDisabled}
					className={`min-h-[44px] rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0 ${
						destructive
							? "bg-red-700 text-white hover:bg-red-600"
							: "bg-primary text-primary-foreground hover:bg-primary/90"
					}`}
				>
					{busy ? "Working…" : confirmLabel}
				</button>
			</div>
		</DialogShell>
	);
}
