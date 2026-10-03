import { useSyncExternalStore } from "react";

/**
 * How many modal dialogs are open. A toast that lands while a bottom sheet is
 * open would cover the sheet's own buttons on a phone, so the toaster moves to
 * the top of the screen for as long as one is.
 */
let open = 0;
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

/** Marks a dialog as open; returns the function that marks it closed. */
export function registerOpenDialog(): () => void {
	open += 1;
	emit();
	let closed = false;
	return () => {
		if (closed) return;
		closed = true;
		open -= 1;
		emit();
	};
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useAnyDialogOpen(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => open > 0,
		() => false,
	);
}

const PHONE_QUERY = "(max-width: 767px)";

function subscribePhone(listener: () => void): () => void {
	if (typeof window === "undefined" || !window.matchMedia) return () => {};
	const media = window.matchMedia(PHONE_QUERY);
	media.addEventListener("change", listener);
	return () => media.removeEventListener("change", listener);
}

/** Below the md breakpoint, where dialogs are bottom sheets. */
export function usePhoneWidth(): boolean {
	return useSyncExternalStore(
		subscribePhone,
		() =>
			typeof window !== "undefined" &&
			!!window.matchMedia &&
			window.matchMedia(PHONE_QUERY).matches,
		() => false,
	);
}

/** Where toasts go: the top while a bottom sheet is open on a phone, so they don't sit on its buttons. */
export function useToastPosition(): "top-center" | "bottom-right" {
	// Both hooks run on every render: a short-circuit would change the hook count when a dialog opens.
	const dialogOpen = useAnyDialogOpen();
	const phone = usePhoneWidth();
	return dialogOpen && phone ? "top-center" : "bottom-right";
}
