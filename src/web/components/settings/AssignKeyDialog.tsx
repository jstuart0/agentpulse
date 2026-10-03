import { type FormEvent, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { describeApiError } from "../../lib/api-errors.js";
import { type ApiKeyRow, api } from "../../lib/api.js";
import { keyLabel } from "../../lib/owner-label.js";
import type { PersonOption } from "../../lib/people.js";
import {
	SERVICE_OWNER_CHOICE,
	assignKeyPlan,
	initialKeyOwnerChoice,
} from "../../pages/team-flows.js";
import { assignDialogCopy } from "../../pages/team-view-state.js";
import { DialogFooter, FIELD_CONTROL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../DialogParts.js";
import { DialogShell } from "../DialogShell.js";

/**
 * Hand a key to a person, or back to no one (a service key). New sessions from
 * it are recorded as theirs, and the admin can also hand over the sessions it
 * already reported while it had no owner (the count is fetched when the dialog
 * opens; if it can't be, the checkbox stays and says it couldn't count).
 */
export function AssignKeyDialog({
	keyInfo,
	people,
	recordServiceKeys,
	fallbackFocusId,
	onClose,
	onAssigned,
}: {
	keyInfo: ApiKeyRow;
	people: PersonOption[];
	/** The server records service-key decisions, so "No one" can be written down. */
	recordServiceKeys: boolean;
	fallbackFocusId?: string;
	onClose: () => void;
	onAssigned: () => void;
}) {
	const headingId = useId();
	const selectId = useId();
	const checkboxId = useId();
	const [owner, setOwner] = useState(initialKeyOwnerChoice(keyInfo));
	const [reported, setReported] = useState<number | null | "loading">("loading");
	const [alsoSessions, setAlsoSessions] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		api
			.getApiKey(keyInfo.id)
			.then((res) => {
				if (!cancelled) setReported(res.serviceSessionCount);
			})
			.catch(() => {
				if (!cancelled) setReported(null);
			});
		return () => {
			cancelled = true;
		};
	}, [keyInfo.id]);

	const copy = assignDialogCopy({
		keyName: keyLabel(keyInfo.name),
		reportedSessions: reported === "loading" ? 0 : reported,
	});
	const toService = owner === SERVICE_OWNER_CHOICE;

	async function submit(e: FormEvent) {
		e.preventDefault();
		const plan = assignKeyPlan({
			keyHadOwner: Boolean(keyInfo.ownerUserId),
			choice: owner,
			recordServiceKeys,
			currentOwnerId: keyInfo.ownerUserId ?? null,
			attributeSessions: copy.sessionsCheckbox !== null && alsoSessions,
			currentIsService: keyInfo.serviceKey === true,
		});
		if (plan.error) {
			setError(plan.error);
			return;
		}
		if (plan.unchanged) {
			toast(`${keyLabel(keyInfo.name)} already belongs to that owner. Nothing to change.`);
			onClose();
			return;
		}
		setBusy(true);
		setError(null);
		try {
			let attributed = 0;
			for (const op of plan.ops) {
				if (op.kind === "set-owner") {
					// attributeSessions is only valid together with a person.
					const result = await api.patchApiKey(keyInfo.id, {
						ownerUserId: op.userId,
						...(op.userId
							? { attributeSessions: copy.sessionsCheckbox !== null && alsoSessions }
							: {}),
					});
					attributed = result.attributedSessions;
				} else {
					await api.patchApiKey(keyInfo.id, { serviceKey: true });
				}
			}
			const who = toService
				? null
				: (people.find((person) => person.id === owner)?.label ?? "them");
			toast.success(
				who === null
					? `${keyLabel(keyInfo.name)} is a service key now. It belongs to no one.`
					: attributed > 0
						? `${keyLabel(keyInfo.name)} now belongs to ${who}, with ${attributed} of its sessions.`
						: `${keyLabel(keyInfo.name)} now belongs to ${who}.`,
			);
			onAssigned();
		} catch (err) {
			setError(describeApiError(err, "Couldn't assign that key. Try again."));
			setBusy(false);
		}
	}

	return (
		<DialogShell
			labelledBy={headingId}
			onClose={busy ? undefined : onClose}
			fallbackFocusId={fallbackFocusId}
		>
			<form onSubmit={submit} noValidate className="flex flex-1 flex-col">
				<div className="flex-1 space-y-4 p-5 md:p-6">
					<h2 id={headingId} className="text-base font-semibold text-foreground">
						{copy.title}
					</h2>
					<div className="space-y-1">
						<label htmlFor={selectId} className="block text-sm text-foreground">
							Person
						</label>
						<select
							id={selectId}
							value={owner}
							onChange={(e) => {
								setOwner(e.target.value);
								setError(null);
							}}
							className={FIELD_CONTROL}
						>
							<option value="">Choose a person…</option>
							{people.map((person) => (
								<option key={person.id} value={person.id}>
									{person.label}
								</option>
							))}
							<option value={SERVICE_OWNER_CHOICE}>{copy.serviceOption}</option>
						</select>
					</div>
					{copy.sessionsCheckbox && reported !== "loading" && !toService && (
						<label
							htmlFor={checkboxId}
							className="flex min-h-[44px] cursor-pointer items-start gap-2 text-sm md:min-h-0"
						>
							<input
								id={checkboxId}
								type="checkbox"
								checked={alsoSessions}
								onChange={(e) => setAlsoSessions(e.target.checked)}
								className="mt-1 rounded border-input accent-primary"
							/>
							<span className="text-foreground">{copy.sessionsCheckbox}</span>
						</label>
					)}
					<p className="text-xs text-hint">{copy.note}</p>
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
						{busy ? "Assigning…" : "Assign"}
					</button>
				</DialogFooter>
			</form>
		</DialogShell>
	);
}
