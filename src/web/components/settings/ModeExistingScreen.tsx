import { useId, useMemo, useState } from "react";
import { toast } from "sonner";
import { describeApiError } from "../../lib/api-errors.js";
import { api } from "../../lib/api.js";
import { addToIdSet, browserStorage, readIdSet, userScopedKey } from "../../lib/id-set-storage.js";
import { keyLabel } from "../../lib/owner-label.js";
import {
	type PersonOption,
	assignablePeople,
	directoryEntryFromAdminRow,
} from "../../lib/people.js";
import {
	type ExistingOp,
	type ExistingResult,
	OWNER_CHOICE_PLACEHOLDER,
	type OwnerChoice,
	existingSummaryText,
	leaveUnassignedLabel,
	planExistingItems,
	settleExistingItems,
} from "../../pages/existing-items-plan.js";
import { ownerlessHostsToReview, undecidedOwnerlessKeys } from "../../pages/team-flows.js";
import {
	canSendEvents,
	existingScreenStatus,
	pastSessionsChoice,
} from "../../pages/team-view-state.js";
import { useUserStore } from "../../stores/user-store.js";
import { DialogFooter, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../DialogParts.js";
import { type Loaded, REVIEWED_KEYS_STORAGE_KEY } from "./mode-dialog-data.js";

const LEAVE = "__leave__";
const KEY_HELPER =
	"New sessions from this key will be recorded as theirs. If several people share this key, leave it as a service key.";
const KEY_UNDECIDED_HELPER =
	"Until a key has an owner or is kept as a service key, events it sends for sessions launched from the dashboard are ignored.";
const HOST_HELPER =
	"Owning a host decides who can rotate or revoke it. Anyone can still launch on it. Until a host has an owner, events from its agents for sessions launched from the dashboard are ignored.";

async function runOp(op: ExistingOp): Promise<ExistingResult> {
	try {
		if (op.kind === "claim-sessions") {
			return { op, ok: true, claimed: (await api.claimUnassignedSessions(op.userId)).claimed };
		}
		if (op.kind === "assign-key") await api.patchApiKey(op.keyId, { ownerUserId: op.userId });
		else if (op.kind === "mark-service-key") await api.patchApiKey(op.keyId, { serviceKey: true });
		else await api.setSupervisorOwner(op.hostId, op.userId);
		return { op, ok: true };
	} catch (err) {
		return { op, ok: false, message: describeApiError(err, "Something went wrong. Try again.") };
	}
}

export function ModeExistingScreen({
	headingId,
	headingPrefix,
	data,
	followsSwitch,
	busy,
	setBusy,
	onClose,
	onChanged,
}: {
	headingId: string;
	headingPrefix: string;
	data: Loaded;
	followsSwitch: boolean;
	busy: boolean;
	setBusy: (busy: boolean) => void;
	onClose: () => void;
	onChanged: () => void;
}) {
	const viewerUserId = useUserStore((s) => s.userId);
	const storage = browserStorage();
	const keysStorageKey = userScopedKey(REVIEWED_KEYS_STORAGE_KEY, viewerUserId);
	const recordServiceKeys = data.counts.undecidedServiceKeys !== undefined;
	const reviewedKeys = useMemo(() => readIdSet(keysStorageKey, storage), [keysStorageKey, storage]);
	const people = useMemo(
		() => assignablePeople(data.users.map(directoryEntryFromAdminRow), viewerUserId),
		[data.users, viewerUserId],
	);
	const humans = data.users.filter((user) => !user.disabled).length;
	const sessionsChoice = pastSessionsChoice(data.counts.unassignedSessions, humans);
	const keys = useMemo(
		() => undecidedOwnerlessKeys(data.keys, reviewedKeys),
		[data.keys, reviewedKeys],
	);
	const hosts = useMemo(() => ownerlessHostsToReview(data.hosts), [data.hosts]);

	const [claim, setClaim] = useState(sessionsChoice.defaultChecked);
	const [keyChoices, setKeyChoices] = useState<Record<string, OwnerChoice | undefined>>({});
	const [hostChoices, setHostChoices] = useState<Record<string, OwnerChoice | undefined>>({});
	const [failures, setFailures] = useState<Array<{ label: string; message: string }>>([]);
	const [result, setResult] = useState<string | null>(null);
	const claimHelpId = useId();
	const status = existingScreenStatus({ followsSwitch });

	const nothingToReview = !sessionsChoice.show && keys.length === 0 && hosts.length === 0;

	async function apply() {
		setBusy(true);
		setFailures([]);
		setResult(null);
		const ops = planExistingItems({
			claimSessionsFor: claim && sessionsChoice.show ? viewerUserId : null,
			keys: keyChoices,
			hosts: hostChoices,
			recordServiceKeys,
		});
		const results: ExistingResult[] = [];
		for (const op of ops) results.push(await runOp(op));

		const settled = settleExistingItems({
			results,
			keyChoices,
			hostChoices,
			visibleKeyIds: keys.map((key) => key.id),
			visibleHostIds: hosts.map((host) => host.id),
			names: {
				key: (id) => keys.find((key) => key.id === id)?.name ?? "key",
				host: (id) => hosts.find((host) => host.id === id)?.hostName ?? "host",
			},
			recordServiceKeys,
		});
		addToIdSet(keysStorageKey, settled.reviewedKeyIds, storage);
		if (results.length > 0) onChanged();
		setBusy(false);

		const text = existingSummaryText(settled.summary);
		if (settled.failures.length === 0) {
			if (text === "Nothing changed.") {
				// Nothing was chosen: say so and stay, rather than closing as if it had worked.
				setResult(text);
				return;
			}
			toast.success(text);
			onClose();
			return;
		}
		setKeyChoices(settled.remainingKeyChoices);
		setHostChoices(settled.remainingHostChoices);
		setFailures(settled.failures);
		setResult(text);
	}

	return (
		<>
			<div className="flex-1 space-y-5 p-5 md:p-6">
				<div>
					{status && (
						<output className="mb-1 block text-xs font-medium text-emerald-800 dark:text-emerald-400">
							{status}
						</output>
					)}
					<h2 id={headingId} className="text-base font-semibold text-foreground focus:outline-none">
						<span className="sr-only">{headingPrefix}</span>
						Existing items
					</h2>
					<p className="mt-0.5 text-xs text-hint">
						Everything here was recorded before team mode, so none of it has an owner yet. Each
						choice is separate, and you can come back to this from Settings. Rows you leave on
						"Choose…" aren't touched.
					</p>
				</div>

				{nothingToReview && (
					<p className="rounded-md border border-dashed border-border p-4 text-sm text-hint">
						Nothing is left to review. Every session, key and host already has an owner or a
						decision.
					</p>
				)}

				{sessionsChoice.show && (
					<section aria-label="Past sessions" className="space-y-1.5">
						<h3 className="text-sm font-semibold text-foreground">Past sessions</h3>
						<label className="flex min-h-[44px] cursor-pointer items-start gap-2 text-sm md:min-h-0">
							<input
								type="checkbox"
								checked={claim}
								onChange={(e) => setClaim(e.target.checked)}
								aria-describedby={claimHelpId}
								className="mt-1 rounded border-input accent-primary"
							/>
							<span className="text-foreground">{sessionsChoice.label}</span>
						</label>
						<p id={claimHelpId} className="pl-6 text-xs text-hint">
							{sessionsChoice.help}
						</p>
					</section>
				)}

				{keys.length > 0 && (
					<OwnerList
						title="Keys"
						helper={
							keys.some((key) => canSendEvents(key.scopes))
								? `${KEY_HELPER} ${KEY_UNDECIDED_HELPER}`
								: KEY_HELPER
						}
						noun="key"
						rows={keys.map((key) => ({
							id: key.id,
							name: keyLabel(key.name),
							detail: `${key.keyPrefix}…`,
						}))}
						choices={keyChoices}
						setChoices={setKeyChoices}
						people={people}
					/>
				)}

				{hosts.length > 0 && (
					<OwnerList
						title="Hosts"
						helper={HOST_HELPER}
						noun="host"
						rows={hosts.map((host) => ({
							id: host.id,
							name: host.hostName,
							detail: host.platform,
						}))}
						choices={hostChoices}
						setChoices={setHostChoices}
						people={people}
					/>
				)}

				{failures.length > 0 && (
					<div
						role="alert"
						className="space-y-1 rounded-md border border-red-500/30 bg-red-500/5 p-3"
					>
						<p className="text-sm font-medium text-red-800 dark:text-red-300">
							Some changes didn't go through. The rest are saved.
						</p>
						<ul className="list-disc space-y-0.5 pl-5 text-sm text-red-800 dark:text-red-300">
							{failures.map((failure) => (
								<li key={failure.label}>
									{failure.label}: {failure.message}
								</li>
							))}
						</ul>
					</div>
				)}
				{result && failures.length === 0 && (
					<output className="block text-sm text-foreground">{result}</output>
				)}
			</div>
			<DialogFooter>
				<button type="button" onClick={onClose} disabled={busy} className={SECONDARY_BUTTON}>
					{nothingToReview ? "Close" : "Skip for now"}
				</button>
				{!nothingToReview && (
					<button
						type="button"
						onClick={() => void apply()}
						disabled={busy}
						className={PRIMARY_BUTTON}
					>
						{busy ? "Applying…" : failures.length > 0 ? "Try again" : "Apply"}
					</button>
				)}
			</DialogFooter>
		</>
	);
}

function OwnerList({
	title,
	helper,
	noun,
	rows,
	choices,
	setChoices,
	people,
}: {
	title: string;
	helper: string;
	noun: "key" | "host";
	rows: Array<{ id: string; name: string; detail: string }>;
	choices: Record<string, OwnerChoice | undefined>;
	setChoices: (
		update: (
			prev: Record<string, OwnerChoice | undefined>,
		) => Record<string, OwnerChoice | undefined>,
	) => void;
	people: PersonOption[];
}) {
	const helperId = useId();
	return (
		<section aria-label={title} className="space-y-2">
			<div>
				<h3 className="text-sm font-semibold text-foreground">{title}</h3>
				<p id={helperId} className="mt-0.5 text-xs text-hint">
					{helper}
				</p>
			</div>
			<ul className="space-y-2">
				{rows.map((row) => {
					const choice = choices[row.id];
					const value =
						choice === undefined
							? OWNER_CHOICE_PLACEHOLDER
							: choice.kind === "assign"
								? (choice.userId ?? OWNER_CHOICE_PLACEHOLDER)
								: LEAVE;
					return (
						<li
							key={row.id}
							className="flex flex-col gap-2 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between"
						>
							<div className="min-w-0 break-words">
								<span className="text-sm font-medium text-foreground">{row.name}</span>{" "}
								<span className="text-xs text-hint">{row.detail}</span>
							</div>
							<div>
								<label htmlFor={`owner-${row.id}`} className="sr-only">
									Owner of {noun} {row.name}
								</label>
								<select
									id={`owner-${row.id}`}
									value={value}
									aria-describedby={helperId}
									onChange={(e) =>
										setChoices((prev) => ({
											...prev,
											[row.id]:
												e.target.value === OWNER_CHOICE_PLACEHOLDER
													? undefined
													: e.target.value === LEAVE
														? { kind: "service" }
														: { kind: "assign", userId: e.target.value },
										}))
									}
									className="min-h-[44px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:w-64 md:min-h-0"
								>
									<option value={OWNER_CHOICE_PLACEHOLDER}>Choose…</option>
									<option value={LEAVE}>{leaveUnassignedLabel(noun)}</option>
									{people.map((person) => (
										<option key={person.id} value={person.id}>
											Assign to {person.label}
										</option>
									))}
								</select>
							</div>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
