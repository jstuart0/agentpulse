import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import type { Session } from "../../../shared/types.js";
import { describeApiError } from "../../lib/api-errors.js";
import { api } from "../../lib/api.js";
import type { PersonOption } from "../../lib/people.js";
import { DialogFooter, FIELD_CONTROL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../DialogParts.js";
import { DialogShell } from "../DialogShell.js";

/** An admin hands a session to a person, or clears its owner. The owner (and any admin) can rename, pin, archive or delete it. */
export function SessionOwnerDialog({
	sessionId,
	sessionName,
	currentOwnerId,
	people,
	onClose,
	onChanged,
}: {
	sessionId: string;
	sessionName: string;
	currentOwnerId: string | null;
	people: PersonOption[];
	onClose: () => void;
	onChanged: (session: Session | null) => void;
}) {
	const headingId = useId();
	const selectId = useId();
	const [owner, setOwner] = useState(currentOwnerId ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const unchanged = owner === (currentOwnerId ?? "");

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (unchanged) return;
		setBusy(true);
		setError(null);
		try {
			const result = await api.setSessionOwner(sessionId, owner || null);
			toast.success(
				owner
					? `${sessionName} now belongs to ${people.find((p) => p.id === owner)?.label ?? "them"}.`
					: `${sessionName} is unassigned now.`,
			);
			onChanged(result.session);
		} catch (err) {
			setError(describeApiError(err, "Couldn't change the owner. Try again."));
			setBusy(false);
		}
	}

	return (
		<DialogShell labelledBy={headingId} onClose={busy ? undefined : onClose}>
			<form onSubmit={submit} noValidate className="flex flex-1 flex-col">
				<div className="flex-1 space-y-4 p-5 md:p-6">
					<h2 id={headingId} className="break-words text-base font-semibold text-foreground">
						Change owner of {sessionName}
					</h2>
					<div className="space-y-1">
						<label htmlFor={selectId} className="block text-sm text-foreground">
							Owner
						</label>
						<select
							id={selectId}
							data-autofocus=""
							value={owner}
							onChange={(e) => setOwner(e.target.value)}
							className={FIELD_CONTROL}
						>
							<option value="">Unassigned</option>
							{people.map((person) => (
								<option key={person.id} value={person.id}>
									{person.label}
								</option>
							))}
						</select>
					</div>
					<p className="text-xs text-hint">
						The owner (and any admin) can rename, pin, archive or delete this session.
					</p>
					{error && (
						<p role="alert" className="text-sm text-red-700 dark:text-red-400">
							{error}
						</p>
					)}
				</div>
				<DialogFooter>
					<button type="button" onClick={onClose} disabled={busy} className={SECONDARY_BUTTON}>
						Cancel
					</button>
					<button type="submit" disabled={busy || unchanged} className={PRIMARY_BUTTON}>
						{busy ? "Saving…" : "Save owner"}
					</button>
				</DialogFooter>
			</form>
		</DialogShell>
	);
}
