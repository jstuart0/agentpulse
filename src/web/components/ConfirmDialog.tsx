import { type ReactNode, useEffect, useId, useRef } from "react";
import { useArmedAfter } from "../hooks/useArmedAfter.js";
import { DialogShell } from "./DialogShell.js";

interface ConfirmDialogProps {
	title: string;
	children: ReactNode;
	/**
	 * Form controls the person fills in. Rendered after the description and outside the region the dialog
	 * is described by, so a screen reader doesn't read the whole form as the description.
	 */
	fields?: ReactNode;
	/** Put `fields` above the description: when the first thing a person must do is choose (a machine), on a phone too. */
	fieldsFirst?: boolean;
	/** Initial focus goes to the first control in `fields` (the choice to make), not to either button. */
	focusFields?: boolean;
	confirmLabel: string;
	cancelLabel?: string;
	/** Red confirm button, and Cancel focused first: the safe default for something that can't be undone. */
	destructive?: boolean;
	/** Cancel is focused first without the red styling: for a change that is deliberate but replaces something. */
	focusCancel?: boolean;
	busy?: boolean;
	/** The confirm button waits (for data the sentence depends on) without freezing Cancel. */
	confirmDisabled?: boolean;
	/** Shown on the confirm button while `busy`. */
	busyLabel?: string;
	/** Confirm taps are ignored, and the button looks disabled, this long after the dialog opens. Off by default. */
	armAfterMs?: number;
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
/**
 * What sits inside the dialog's frame: the heading, the fields and description, the refusal, the two buttons.
 * Exported so the layout (what comes first, where initial focus lands) can be rendered and read without a portal.
 */
export function ConfirmDialogPanel({
	title,
	children,
	fields,
	fieldsFirst = false,
	focusFields = false,
	confirmLabel,
	cancelLabel = "Cancel",
	destructive = false,
	focusCancel = false,
	busy = false,
	busyLabel = "Working…",
	armAfterMs = 0,
	confirmDisabled = false,
	error = null,
	onConfirm,
	onCancel,
	headingId,
	descriptionId,
}: ConfirmDialogProps & { headingId: string; descriptionId: string }) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	const armed = useArmedAfter(armAfterMs);
	const errorRef = useRef<HTMLParagraphElement>(null);
	// On a phone the refusal can land below the fold of a tall sheet: bring it into view.
	useEffect(() => {
		if (error) errorRef.current?.scrollIntoView?.({ block: "nearest" });
	}, [error]);

	return (
		<>
			<div className="flex-1 p-5 md:p-6">
				<h2
					id={headingId}
					className="mb-2 text-base font-semibold text-foreground [overflow-wrap:anywhere]"
				>
					{title}
				</h2>
				{fields && fieldsFirst ? <div className="mb-4 space-y-3">{fields}</div> : null}
				<div id={descriptionId} className="space-y-3 text-sm text-hint">
					{children}
				</div>
				{fields && !fieldsFirst ? <div className="mt-4 space-y-3">{fields}</div> : null}
				{error && (
					<p ref={errorRef} role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">
						{error}
					</p>
				)}
			</div>
			<div className="sticky bottom-0 flex flex-col-reverse gap-2 border-t border-border bg-card p-4 md:static md:flex-row md:justify-end md:px-6">
				<button
					ref={cancelRef}
					type="button"
					data-autofocus={!focusFields && (destructive || focusCancel) ? "" : undefined}
					onClick={onCancel}
					disabled={busy}
					className="min-h-[44px] rounded-md border border-border px-4 py-2 text-sm text-foreground transition-colors [overflow-wrap:anywhere] hover:bg-accent disabled:opacity-50 md:min-h-0"
				>
					{cancelLabel}
				</button>
				<button
					type="button"
					data-autofocus={!focusFields && !(destructive || focusCancel) ? "" : undefined}
					onClick={onConfirm}
					disabled={busy || confirmDisabled || !armed}
					className={`min-h-[44px] rounded-md px-4 py-2 text-sm font-medium transition-colors [overflow-wrap:anywhere] disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0 ${
						destructive
							? "bg-red-700 text-white hover:bg-red-600"
							: "bg-primary text-primary-foreground hover:bg-primary/90"
					}`}
				>
					{busy ? busyLabel : confirmLabel}
				</button>
			</div>
		</>
	);
}

export function ConfirmDialog(props: ConfirmDialogProps) {
	const headingId = useId();
	const descriptionId = useId();
	return (
		<DialogShell
			labelledBy={headingId}
			describedBy={descriptionId}
			role={props.destructive ? "alertdialog" : "dialog"}
			onClose={props.busy ? undefined : props.onCancel}
			fallbackFocusId={props.fallbackFocusId}
		>
			<ConfirmDialogPanel {...props} headingId={headingId} descriptionId={descriptionId} />
		</DialogShell>
	);
}
