import { useEffect, useId, useRef, useState } from "react";
import type { Project } from "../../shared/types.js";
import { api } from "../lib/api.js";

interface CleanupWorkareaModalProps {
	project: Project;
	onClose: () => void;
	onCleanedUp: () => void;
}

const CONFIRM_PHRASE = "delete";

/**
 * Destructive-action modal for scratch workspace cleanup.
 *
 * Behaviour matches the rest of the project's destructive UI discipline:
 * - role="alertdialog" with focus trap + Esc dismiss
 * - type-to-confirm gate ("delete", case-insensitive trim)
 * - confirm button stays disabled until the input matches and the request
 *   isn't already in flight
 * - error state surfaces inline; the user can retry or cancel
 *
 * On success the modal stays open just long enough to call onCleanedUp,
 * which reloads the project list. The actual rm -rf happens on the
 * supervisor — the modal is the consent gate, not the executor.
 */
export function CleanupWorkareaModal({ project, onClose, onCleanedUp }: CleanupWorkareaModalProps) {
	const [confirmText, setConfirmText] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sessionCount, setSessionCount] = useState<number | null>(null);
	const dialogRef = useRef<HTMLDivElement | null>(null);
	const cancelRef = useRef<HTMLButtonElement | null>(null);
	const headingId = useId();
	const descriptionId = useId();

	useEffect(() => {
		// Probe session count so we can show "delete N sessions" in the body.
		// This is best-effort; the real count is the server's at submit time.
		let cancelled = false;
		(async () => {
			try {
				const result = await api.getProjectSessions(project.id);
				if (cancelled) return;
				setSessionCount(result.total);
			} catch {
				if (cancelled) return;
				setSessionCount(null);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [project.id]);

	useEffect(() => {
		cancelRef.current?.focus();
	}, []);

	useEffect(() => {
		function handleKey(e: KeyboardEvent) {
			if (e.key === "Escape" && !submitting) {
				e.preventDefault();
				onClose();
			}
			if (e.key === "Tab" && dialogRef.current) {
				const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
					"input, button:not([disabled]), [tabindex]:not([tabindex='-1'])",
				);
				if (focusable.length === 0) return;
				const first = focusable[0];
				const last = focusable[focusable.length - 1];
				if (e.shiftKey && document.activeElement === first) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && document.activeElement === last) {
					e.preventDefault();
					first.focus();
				}
			}
		}
		document.addEventListener("keydown", handleKey);
		return () => document.removeEventListener("keydown", handleKey);
	}, [onClose, submitting]);

	const canConfirm = !submitting && confirmText.trim().toLowerCase() === CONFIRM_PHRASE;

	async function handleConfirm() {
		if (!canConfirm) return;
		setSubmitting(true);
		setError(null);
		try {
			await api.cleanupWorkarea(project.id);
			onCleanedUp();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Cleanup request failed");
			setSubmitting(false);
		}
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
			onClick={(e) => {
				if (!submitting && e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={dialogRef}
				role="alertdialog"
				aria-modal="true"
				aria-labelledby={headingId}
				aria-describedby={descriptionId}
				className="rounded-lg border border-border bg-card p-6 w-full max-w-md mx-4 shadow-xl"
			>
				<h3 id={headingId} className="text-sm font-semibold text-foreground mb-2">
					Delete scratch workspace?
				</h3>
				<div id={descriptionId} className="space-y-3 text-sm text-muted-foreground">
					<p>
						AgentPulse will run <code className="font-mono text-foreground">rm -rf</code> on the
						workspace below, remove the project, and delete{" "}
						{sessionCount === null
							? "any sessions still attached to it"
							: `${sessionCount} attached session${sessionCount === 1 ? "" : "s"}`}
						.
					</p>
					<div className="rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground break-all">
						{project.cwd}
					</div>
					<p className="text-xs text-amber-300">This cannot be undone.</p>
				</div>

				<div className="mt-4 space-y-1">
					<label className="text-xs text-muted-foreground" htmlFor="cleanup-confirm-input">
						Type <span className="font-mono text-foreground">{CONFIRM_PHRASE}</span> to confirm
					</label>
					<input
						id="cleanup-confirm-input"
						type="text"
						autoComplete="off"
						value={confirmText}
						onChange={(e) => setConfirmText(e.target.value)}
						disabled={submitting}
						className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
						placeholder={CONFIRM_PHRASE}
					/>
				</div>

				{error && (
					<p className="mt-3 text-xs text-red-400" role="alert">
						{error}
					</p>
				)}

				<div className="mt-5 flex justify-end gap-2">
					<button
						ref={cancelRef}
						type="button"
						onClick={onClose}
						disabled={submitting}
						className="rounded border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 disabled:opacity-50 transition-colors"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleConfirm}
						disabled={!canConfirm}
						className="inline-flex items-center gap-2 rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						{submitting && (
							<span
								className="h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin"
								aria-hidden="true"
							/>
						)}
						{submitting ? "Cleaning up…" : "Delete workspace"}
					</button>
				</div>
			</div>
		</div>
	);
}
