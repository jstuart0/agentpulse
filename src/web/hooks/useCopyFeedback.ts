import { toast } from "sonner";

/**
 * Centralised clipboard-copy with sonner toast feedback.
 *
 * Replaces per-component `navigator.clipboard.writeText` call sites that had
 * inline `useState` "copied" toggles or were silently swallowing errors.
 * All copy actions now surface in the same bottom-right toast region.
 */
export function useCopyFeedback() {
	const copy = async (text: string, label = "Copied") => {
		try {
			await navigator.clipboard.writeText(text);
			toast.success(label);
		} catch {
			toast.error("Copy failed");
		}
	};
	return { copy };
}
