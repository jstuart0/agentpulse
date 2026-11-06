import type { Session } from "../../../shared/types.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { stopConfirmCopy } from "./stop-view.js";

/** The header's id: it exists at every width, so focus has somewhere to land when the Stop button that opened this is gone or disabled. */
export const STOP_FALLBACK_FOCUS_ID = "session-header";

interface StopConfirmDialogProps {
	session: Pick<Session, "agentType"> & Partial<Pick<Session, "isWorking">>;
	busy: boolean;
	error: string | null;
	onConfirm: () => void;
	onCancel: () => void;
}

/** The confirmation behind every Stop control: red confirm, Cancel focused first, nothing sent until confirm. */
export function StopConfirmDialog({
	session,
	busy,
	error,
	onConfirm,
	onCancel,
}: StopConfirmDialogProps) {
	const copy = stopConfirmCopy(session);
	return (
		<ConfirmDialog
			title={copy.title}
			confirmLabel={copy.confirmLabel}
			destructive
			busy={busy}
			busyLabel="Stopping…"
			error={error}
			fallbackFocusId={STOP_FALLBACK_FOCUS_ID}
			onConfirm={onConfirm}
			onCancel={onCancel}
		>
			<p>{copy.body}</p>
		</ConfirmDialog>
	);
}
