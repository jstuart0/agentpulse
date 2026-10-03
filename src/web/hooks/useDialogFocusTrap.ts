import { type RefObject, useEffect, useState } from "react";
import { initialFocusTarget, returnFocusTarget, tabAction } from "../lib/dialog-focus.js";

const FOCUSABLE =
	"a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

function visibleFocusables(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
		(el) => el.getClientRects().length > 0,
	);
}

function focusProgrammatically(el: HTMLElement) {
	if (el.tabIndex < 0 && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
	el.focus({ preventScroll: true });
}

export interface DialogFocusOptions {
	/** Where focus goes on close when the opener has gone: a heading's id. Defaults to the page's h1. */
	fallbackFocusId?: string;
}

/**
 * Keeps keyboard focus inside a modal. The opener is captured on the first
 * render, before any child (an autoFocus field) can take focus; when nothing
 * inside takes focus the heading does, so a screen reader announces the
 * dialog; Tab and Shift+Tab wrap, and are held (not allowed to escape behind
 * the dialog) while there is nothing to tab to. On close focus goes back to
 * the opener, or to the fallback heading when the opener is gone. The
 * decisions themselves live in lib/dialog-focus.ts.
 */
export function useDialogFocusTrap(
	containerRef: RefObject<HTMLElement | null>,
	onEscape: (() => void) | undefined,
	options: DialogFocusOptions = {},
) {
	const [opener] = useState<HTMLElement | null>(() =>
		document.activeElement instanceof HTMLElement && document.activeElement !== document.body
			? document.activeElement
			: null,
	);
	const { fallbackFocusId } = options;

	useEffect(() => {
		const panel = containerRef.current;
		if (!panel) return;
		const heading = panel.querySelector<HTMLElement>("h2, h1, [role='heading']");
		const preferred = panel.querySelector<HTMLElement>("[data-autofocus]");
		const target = initialFocusTarget({
			panelHasFocus: panel.contains(document.activeElement) && document.activeElement !== panel,
			hasHeading: heading !== null,
			hasPreferred: preferred !== null,
		});
		if (target === "preferred" && preferred) preferred.focus({ preventScroll: true });
		else if (target === "heading" && heading) focusProgrammatically(heading);
		else if (target === "panel") focusProgrammatically(panel);
	}, [containerRef]);

	useEffect(() => {
		return () => {
			const decision = returnFocusTarget({
				hadOpener: opener !== null,
				openerConnected: opener !== null && document.contains(opener),
				openerDisabled: opener !== null && (opener as HTMLButtonElement).disabled === true,
			});
			if (decision === "opener" && opener) {
				opener.focus();
				return;
			}
			const fallback =
				(fallbackFocusId ? document.getElementById(fallbackFocusId) : null) ??
				document.querySelector<HTMLElement>("main h1, h1");
			if (fallback) focusProgrammatically(fallback);
		};
	}, [opener, fallbackFocusId]);

	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape" && onEscape) {
				e.preventDefault();
				onEscape();
				return;
			}
			const panel = containerRef.current;
			if (e.key !== "Tab" || !panel) return;
			const focusable = visibleFocusables(panel);
			const active = document.activeElement;
			const action = tabAction({
				focusableCount: focusable.length,
				activeInside: panel.contains(active),
				shift: e.shiftKey,
				onFirst: active === focusable[0],
				onLast: active === focusable[focusable.length - 1],
			});
			if (action === "native") return;
			e.preventDefault();
			if (action === "first") focusable[0]?.focus();
			else if (action === "last") focusable[focusable.length - 1]?.focus();
			else focusProgrammatically(panel);
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [containerRef, onEscape]);
}
