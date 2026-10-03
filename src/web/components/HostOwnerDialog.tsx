import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import type { SupervisorRecord } from "../../shared/types.js";
import { describeApiError } from "../lib/api-errors.js";
import { api } from "../lib/api.js";
import type { PersonOption } from "../lib/people.js";
import { hostOwnerDialogNote, hostOwnerUnchanged } from "../pages/hosts-view-state.js";
import { DialogFooter, FIELD_CONTROL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./DialogParts.js";
import { DialogShell } from "./DialogShell.js";

/** An admin hands a host to a person, or takes its owner away. Owning a host only decides who can rotate or revoke it. */
export function HostOwnerDialog({
	host,
	people,
	onClose,
	onChanged,
}: {
	host: SupervisorRecord;
	people: PersonOption[];
	onClose: () => void;
	onChanged: () => void;
}) {
	const headingId = useId();
	const selectId = useId();
	const [owner, setOwner] = useState(host.ownerUserId ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(e: FormEvent) {
		e.preventDefault();
		if (hostOwnerUnchanged(host.ownerUserId, owner)) {
			toast(`${host.hostName} already has that owner.`);
			onClose();
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await api.setSupervisorOwner(host.id, owner || null);
			toast.success(
				owner
					? `${host.hostName} now belongs to ${people.find((p) => p.id === owner)?.label ?? "them"}.`
					: `${host.hostName} has no owner now.`,
			);
			onChanged();
		} catch (err) {
			setError(describeApiError(err, "Couldn't change the owner. Try again."));
			setBusy(false);
		}
	}

	return (
		<DialogShell labelledBy={headingId} onClose={busy ? undefined : onClose}>
			<form onSubmit={submit} noValidate className="flex flex-1 flex-col">
				<div className="flex-1 space-y-4 p-5 md:p-6">
					<h2 id={headingId} className="text-base font-semibold text-foreground">
						Change owner of {host.hostName}
					</h2>
					<div className="space-y-1">
						<label htmlFor={selectId} className="block text-sm text-foreground">
							Owner
						</label>
						<select
							id={selectId}
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
					<p className="text-xs text-hint">{hostOwnerDialogNote(host)}</p>
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
					<button type="submit" disabled={busy} className={PRIMARY_BUTTON}>
						{busy ? "Saving…" : "Save owner"}
					</button>
				</DialogFooter>
			</form>
		</DialogShell>
	);
}
