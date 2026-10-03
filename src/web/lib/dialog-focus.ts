/**
 * The focus decisions a modal dialog makes, as pure functions so each branch
 * is tested; useDialogFocusTrap only gathers the facts and acts on the answer.
 */

/** Where focus goes when a dialog opens. */
export type InitialFocus = "keep" | "preferred" | "heading" | "panel";

export function initialFocusTarget(input: {
	panelHasFocus: boolean;
	hasHeading: boolean;
	/** A control inside is marked as where focus should start (the safe button of a confirmation). */
	hasPreferred?: boolean;
}): InitialFocus {
	if (input.panelHasFocus) return "keep";
	if (input.hasPreferred) return "preferred";
	return input.hasHeading ? "heading" : "panel";
}

export type TabAction = "native" | "first" | "last" | "block";

/** What Tab or Shift+Tab does inside the dialog. */
export function tabAction(input: {
	focusableCount: number;
	activeInside: boolean;
	shift: boolean;
	onFirst: boolean;
	onLast: boolean;
}): TabAction {
	if (input.focusableCount === 0) return "block";
	if (!input.activeInside) return input.shift ? "last" : "first";
	if (input.shift && input.onFirst) return "last";
	if (!input.shift && input.onLast) return "first";
	return "native";
}

export type ReturnFocus = "opener" | "fallback";

/** Where focus goes when the dialog closes: back to what opened it, else the section's heading. */
export function returnFocusTarget(input: {
	hadOpener: boolean;
	openerConnected: boolean;
	openerDisabled: boolean;
}): ReturnFocus {
	return input.hadOpener && input.openerConnected && !input.openerDisabled ? "opener" : "fallback";
}
