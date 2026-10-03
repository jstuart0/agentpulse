import { useEffect, useId, useMemo, useState } from "react";
import { apiErrorCode, describeApiError } from "../../lib/api-errors.js";
import { ApiError, api } from "../../lib/api.js";
import {
	type PersonOption,
	assignablePeople,
	directoryEntryFromAdminRow,
} from "../../lib/people.js";
import {
	keyChoiceNote,
	modeSwitchBlockedReason,
	modeSwitchFailure,
} from "../../pages/team-flows.js";
import {
	type KeyChoice,
	type ServiceKeyItem,
	buildServiceKeyDecisions,
	decisionsComplete,
	initialKeyChoices,
	lastUsedText,
	ownerlessManageKeys,
	peopleSummary,
} from "../../pages/team-view-state.js";
import { useUserStore } from "../../stores/user-store.js";
import { ChoiceGroup } from "../ChoiceGroup.js";
import { DialogFooter, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../DialogParts.js";
import type { Loaded } from "./mode-dialog-data.js";

export function ModeChangesScreen({
	headingId,
	headingPrefix,
	data,
	busy,
	setBusy,
	onCancel,
	onCommitted,
}: {
	headingId: string;
	headingPrefix: string;
	data: Loaded;
	busy: boolean;
	setBusy: (busy: boolean) => void;
	onCancel: () => void;
	onCommitted: () => Promise<void>;
}) {
	const viewerUserId = useUserStore((s) => s.userId);
	const [users, setUsers] = useState(data.users);
	const [items, setItems] = useState<ServiceKeyItem[]>(() => ownerlessManageKeys(data.keys));
	const [choices, setChoices] = useState<Record<string, KeyChoice | undefined>>(() =>
		initialKeyChoices(data.keys),
	);
	const [notice, setNotice] = useState<string | null>(null);
	const [focusKeyId, setFocusKeyId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const reasonId = useId();
	const summary = useMemo(() => peopleSummary(users, viewerUserId), [users, viewerUserId]);
	const people = useMemo(
		() => assignablePeople(users.map(directoryEntryFromAdminRow), viewerUserId),
		[users, viewerUserId],
	);
	const complete = decisionsComplete(items, choices);
	const blockedReason = modeSwitchBlockedReason(items, choices);

	// A key that arrived while the dialog was open is brought into view and focused.
	useEffect(() => {
		if (!focusKeyId) return;
		const row = document.getElementById(`key-decision-${focusKeyId}`);
		// Centred, not "nearest": a row scrolled to the bottom edge sits under the sticky footer.
		row?.scrollIntoView({ block: "center" });
		row?.querySelector<HTMLElement>("input[type=radio], select")?.focus({ preventScroll: true });
		setFocusKeyId(null);
	}, [focusKeyId]);

	async function turnOn() {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await api.setInstanceMode("team", buildServiceKeyDecisions(items, choices));
		} catch (err) {
			setBusy(false);
			const failure = modeSwitchFailure({
				code: apiErrorCode(err),
				body: err instanceof ApiError ? err.body : null,
				items,
				choices,
				people,
				fallback: describeApiError(err, "Couldn't turn on team mode. Try again."),
			});
			setItems(failure.items);
			if (failure.clearChoiceFor) {
				const stale = failure.clearChoiceFor;
				setChoices((prev) => ({ ...prev, [stale]: { kind: "assign", userId: null } }));
			}
			if (failure.kind === "added" || failure.kind === "already_listed") setNotice(failure.message);
			else setError(failure.message);
			setFocusKeyId(failure.focusKeyId);
			// Relist from the server and keep the choices already made.
			try {
				if (failure.refresh === "keys")
					setItems(ownerlessManageKeys((await api.getApiKeys()).keys));
				if (failure.refresh === "people") setUsers((await api.getUsers()).users);
			} catch {
				// The message already tells them to check the list; the next open refetches.
			}
			return;
		}
		// The response is the truth: no refetch of /instance, which could still answer solo.
		useUserStore.setState({ mode: "team" });
		void useUserStore.getState().load();
		await onCommitted();
		setBusy(false);
	}

	return (
		<>
			<div className="flex-1 space-y-5 p-5 md:p-6">
				<div>
					<p className="mb-1 text-xs text-hint">Step 1 of 2</p>
					<h2 id={headingId} className="text-base font-semibold text-foreground focus:outline-none">
						<span className="sr-only">{headingPrefix}</span>
						What changes
					</h2>
				</div>

				<p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm font-semibold text-foreground">
					Nothing becomes private. Everyone who can sign in still sees every session.
				</p>

				<ul className="space-y-2 text-sm text-hint">
					<li>{summary.text}</li>
					<li>Session cards show who owns them. Owner means whose key reported the session.</li>
				</ul>

				{notice && (
					<p
						role="alert"
						className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-900 dark:text-amber-200"
					>
						{notice}
					</p>
				)}

				{items.length > 0 && (
					<section aria-label="Keys that can manage" className="space-y-3">
						<div>
							<h3 className="text-sm font-semibold text-foreground">Keys that can manage</h3>
							<p className="mt-0.5 text-xs text-hint">
								Anyone holding a kept key has full admin access. This choice is recorded and you can
								change it later.
							</p>
						</div>
						<ul className="space-y-3">
							{items.map((item) => (
								<li
									key={item.id}
									id={`key-decision-${item.id}`}
									className="rounded-md border border-border p-3"
								>
									<KeyDecisionRow
										item={item}
										choice={choices[item.id]}
										people={people}
										onChange={(choice) => setChoices((prev) => ({ ...prev, [item.id]: choice }))}
									/>
								</li>
							))}
						</ul>
					</section>
				)}

				{error && (
					<p role="alert" className="text-sm text-red-700 dark:text-red-400">
						{error}
					</p>
				)}
			</div>
			<DialogFooter
				note={
					!complete && blockedReason ? (
						<p id={reasonId} className="text-xs text-hint md:mr-auto">
							{blockedReason}
						</p>
					) : undefined
				}
			>
				<button type="button" onClick={onCancel} disabled={busy} className={SECONDARY_BUTTON}>
					Cancel
				</button>
				<button
					type="button"
					onClick={() => void turnOn()}
					disabled={!complete || busy}
					aria-describedby={complete ? undefined : reasonId}
					className={PRIMARY_BUTTON}
				>
					{busy ? "Turning on…" : "Turn on team mode"}
				</button>
			</DialogFooter>
		</>
	);
}

type DecisionKind = "keep" | "assign" | "revoke";

function KeyDecisionRow({
	item,
	choice,
	people,
	onChange,
}: {
	item: ServiceKeyItem;
	choice: KeyChoice | undefined;
	people: PersonOption[];
	onChange: (choice: KeyChoice) => void;
}) {
	const selectId = useId();
	const picked: DecisionKind | null = choice?.kind ?? null;
	const note = keyChoiceNote(choice);
	return (
		<div className="space-y-2.5">
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
				<span className="text-sm font-medium text-foreground">{item.name}</span>
				<code className="text-xs text-hint">{item.keyPrefix}…</code>
				<span className="text-xs text-hint">{lastUsedText(item.lastUsedAt, Date.now())}</span>
			</div>
			<ChoiceGroup<DecisionKind>
				legend={`What should happen to ${item.name}?`}
				legendHidden
				value={picked}
				onChange={(kind) =>
					onChange(
						kind === "assign"
							? { kind: "assign", userId: choice?.kind === "assign" ? choice.userId : null }
							: { kind },
					)
				}
				options={[
					{ value: "keep", label: "Keep as an admin service key" },
					{ value: "assign", label: "Assign to…" },
					{ value: "revoke", label: "Revoke" },
				]}
			/>
			{note && <p className="text-xs text-hint">{note}</p>}
			{choice?.kind === "assign" && (
				<div className="space-y-1">
					<label htmlFor={selectId} className="block text-xs text-hint">
						Assign {item.name} to
					</label>
					<select
						id={selectId}
						value={choice.userId ?? ""}
						onChange={(e) => onChange({ kind: "assign", userId: e.target.value || null })}
						className="min-h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:w-64 md:min-h-0"
					>
						<option value="">Choose a person…</option>
						{people.map((person) => (
							<option key={person.id} value={person.id}>
								{person.label}
							</option>
						))}
					</select>
				</div>
			)}
		</div>
	);
}
