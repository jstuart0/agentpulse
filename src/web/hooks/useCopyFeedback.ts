import { toast } from "sonner";

/**
 * Centralised clipboard-copy with sonner toast feedback.
 *
 * Replaces per-component `navigator.clipboard.writeText` call sites that had
 * inline `useState` "copied" toggles or were silently swallowing errors.
 * All copy actions now surface in the same bottom-right toast region.
 */
export function useCopyFeedback() {
	/** Copies and says so in a toast; resolves true when the clipboard took it. */
	const copyWithResult = async (text: string, label = "Copied", failureLabel = "Copy failed") => {
		try {
			await navigator.clipboard.writeText(text);
			toast.success(label);
			return true;
		} catch {
			toast.error(failureLabel);
			return false;
		}
	};
	const copy = async (text: string, label = "Copied", failureLabel = "Copy failed") => {
		await copyWithResult(text, label, failureLabel);
	};
	return { copy, copyWithResult };
}
