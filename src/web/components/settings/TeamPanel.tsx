import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import type { SupervisorRecord } from "../../../shared/types.js";
import { useOwnershipUi } from "../../hooks/useOwnershipUi.js";
import { describeApiError } from "../../lib/api-errors.js";
import { type AdminUserRow, type ApiKeyRow, type InstanceCounts, api } from "../../lib/api.js";
import { addToIdSet, browserStorage, readIdSet, userScopedKey } from "../../lib/id-set-storage.js";
import { assembleChecklist } from "../../pages/team-flows.js";
import {
	type ChecklistItem,
	membersManageKeyCount,
	soloRowState,
	soloSwitchCopy,
	teamRowState,
} from "../../pages/team-view-state.js";
import { useUserStore } from "../../stores/user-store.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { ModeDialog } from "./ModeDialog.js";
import { TeamMembers } from "./TeamMembers.js";
import {
	DISMISSED_CHECKLIST_STORAGE_KEY,
	REVIEWED_KEYS_STORAGE_KEY,
	TEAM_HEADING_ID,
} from "./mode-dialog-data.js";

interface TeamPanelProps {
	apiKeys: ApiKeyRow[];
	supervisors: SupervisorRecord[];
	/** The key or host lists behind the page changed: reload them. */
	onKeysChanged: () => void;
	onSupervisorsChanged: () => void;
}

type DialogState = null | { kind: "mode"; screen: "changes" | "existing" } | { kind: "to-solo" };

/**
 * Settings → Team. In solo mode it is one row that offers team mode; in team
 * mode an admin sees the people, the checklist of what is left to decide, and
 * the way back; a member sees only that team mode is on.
 */
export function TeamPanel({
	apiKeys,
	supervisors,
	onKeysChanged,
	onSupervisorsChanged,
}: TeamPanelProps) {
	const ui = useOwnershipUi();
	const teamOn = ui.showTeamCopy;
	const [dialog, setDialog] = useState<DialogState>(null);

	// The mode dialog lives here, not inside a branch below: the switch flips
	// `teamOn` while the dialog is still open on its second screen.
	return (
		<section
			id="settings-team"
			aria-labelledby={TEAM_HEADING_ID}
			className="mb-6 rounded-lg border border-border bg-card p-5"
		>
			<h2
				id={TEAM_HEADING_ID}
				tabIndex={-1}
				className="mb-3 text-sm font-semibold focus:outline-none"
			>
				Team
			</h2>
			{!teamOn ? (
				<SoloRow onOpen={() => setDialog({ kind: "mode", screen: "changes" })} />
			) : ui.showTeamSection ? (
				<TeamAdmin
					apiKeys={apiKeys}
					supervisors={supervisors}
					dialogOpen={dialog !== null}
					onReviewExisting={() => setDialog({ kind: "mode", screen: "existing" })}
					onSwitchToSolo={() => setDialog({ kind: "to-solo" })}
					onKeysChanged={onKeysChanged}
					onSupervisorsChanged={onSupervisorsChanged}
				/>
			) : (
				<TeamMemberNotice />
			)}

			{dialog?.kind === "mode" && (
				<ModeDialog
					initialScreen={dialog.screen}
					fallbackFocusId={TEAM_HEADING_ID}
					onClose={() => setDialog(null)}
					onChanged={() => {
						onKeysChanged();
						onSupervisorsChanged();
					}}
				/>
			)}
			{dialog?.kind === "to-solo" && (
				<SoloSwitchDialog
					apiKeys={apiKeys}
					onClose={() => setDialog(null)}
					onSwitched={() => {
						setDialog(null);
						onKeysChanged();
					}}
				/>
			)}
		</section>
	);
}

// ── Solo ────────────────────────────────────────────────────────────────────

function SoloRow({ onOpen }: { onOpen: () => void }) {
	const user = useUserStore((s) => s.user);
	const disableAuth = useUserStore((s) => s.disableAuth);
	const modeLockedByEnv = useUserStore((s) => s.modeLockedByEnv);
	const reasonId = useId();
	const state = soloRowState({
		disableAuth,
		modeLockedByEnv,
		viewer: user ? { role: user.role, source: user.source } : null,
	});
	const available = state.kind === "available";

	return (
		<>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<p className="text-sm text-foreground">
						Team mode · <span className="font-medium">Off</span>
					</p>
					<p className="text-xs text-hint">For installs where several people sign in.</p>
				</div>
				<button
					type="button"
					onClick={onOpen}
					disabled={!available}
					aria-describedby={available ? undefined : reasonId}
					className="min-h-[44px] rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
				>
					Set up team mode
				</button>
			</div>
			{!available && (
				<p id={reasonId} className="mt-2 text-xs text-hint">
					{state.reason}
					{state.kind === "not_admin" && state.hint ? ` ${state.hint}` : ""}
				</p>
			)}
		</>
	);
}

// ── Team mode, a member ─────────────────────────────────────────────────────

function TeamMemberNotice() {
	return (
		<div>
			<p className="text-sm text-foreground">
				Team mode · <span className="font-medium">On</span>
			</p>
			<p className="text-xs text-hint">
				Everyone who can sign in sees every session. Owner means whose key reported it. Only admins
				can add people or change roles.
			</p>
		</div>
	);
}

// ── Team mode, an admin ─────────────────────────────────────────────────────

function TeamAdmin({
	apiKeys,
	supervisors,
	dialogOpen,
	onReviewExisting,
	onSwitchToSolo,
	onKeysChanged,
	onSupervisorsChanged,
}: {
	apiKeys: ApiKeyRow[];
	supervisors: SupervisorRecord[];
	dialogOpen: boolean;
	onReviewExisting: () => void;
	onSwitchToSolo: () => void;
	onKeysChanged: () => void;
	onSupervisorsChanged: () => void;
}) {
	const viewerUserId = useUserStore((s) => s.userId);
	const modeLockedByEnv = useUserStore((s) => s.modeLockedByEnv);
	const [users, setUsers] = useState<AdminUserRow[] | null>(null);
	const [counts, setCounts] = useState<InstanceCounts | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [addUserOpen, setAddUserOpen] = useState(false);
	const storage = browserStorage();
	const dismissedKey = userScopedKey(DISMISSED_CHECKLIST_STORAGE_KEY, viewerUserId);
	const [dismissed, setDismissed] = useState(() => readIdSet(dismissedKey, storage));
	const row = teamRowState({ modeLockedByEnv });
	const switchReasonId = useId();

	const reload = useCallback(async () => {
		try {
			const [people, instance] = await Promise.all([api.getUsers(), api.getInstance()]);
			setUsers(people.users);
			setCounts(instance.counts);
			setLoadError(null);
		} catch (err) {
			setLoadError(describeApiError(err, "Couldn't load the team."));
		}
	}, []);

	// The counts come from the server, so they are asked for again whenever
	// anything they count may have changed: the dialog closing, or the key or
	// host lists on this page being reloaded after an action on a row.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the lists and dialogOpen are the triggers
	useEffect(() => {
		void reload();
	}, [reload, dialogOpen, apiKeys, supervisors]);

	// "No one else has signed in yet" is the box under the list, with its one
	// Add user button, so the checklist doesn't say it a second time.
	const checklist: ChecklistItem[] = useMemo(() => {
		if (!users || !counts) return [];
		return assembleChecklist({
			counts,
			keys: apiKeys,
			hosts: supervisors,
			users,
			viewerUserId,
			reviewedKeys: readIdSet(userScopedKey(REVIEWED_KEYS_STORAGE_KEY, viewerUserId), storage),
			dismissed,
		}).filter((item) => item.id !== "people");
	}, [users, counts, apiKeys, supervisors, dismissed, viewerUserId, storage]);

	function changed() {
		void reload();
		onKeysChanged();
		onSupervisorsChanged();
	}

	const othersExist = (users ?? []).some((user) => user.id !== viewerUserId);

	return (
		<>
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<p className="text-sm text-foreground">
						Team mode · <span className="font-medium">On</span>
					</p>
					<p className="text-xs text-hint">
						Everyone who can sign in sees every session. Owner means whose key reported it.
					</p>
				</div>
				<button
					type="button"
					onClick={onSwitchToSolo}
					disabled={!row.canSwitchBack}
					aria-describedby={row.reason ? switchReasonId : undefined}
					className="min-h-[44px] rounded-md border border-border px-3 py-2 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
				>
					Switch back to solo mode
				</button>
			</div>
			{row.reason && (
				<p id={switchReasonId} className="mt-2 text-xs text-hint">
					{row.reason}
				</p>
			)}

			{checklist.length > 0 && (
				<Checklist
					items={checklist}
					onReview={onReviewExisting}
					onDismiss={(id) => {
						setDismissed(addToIdSet(dismissedKey, [id], storage));
						// The item's button is about to leave: keep focus in this section.
						const nextId = checklist.length > 1 ? CHECKLIST_HEADING_ID : TEAM_HEADING_ID;
						requestAnimationFrame(() => document.getElementById(nextId)?.focus());
					}}
				/>
			)}

			<div className="mb-3 mt-5 flex items-center justify-between gap-3">
				<h3 className="text-sm font-semibold text-foreground">People</h3>
				<button
					type="button"
					onClick={() => setAddUserOpen(true)}
					className="min-h-[44px] rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 md:min-h-0"
				>
					Add user
				</button>
			</div>

			{loadError && (
				<p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-400">
					{loadError}{" "}
					<button
						type="button"
						onClick={() => void reload()}
						className="min-h-[44px] font-medium underline md:min-h-0"
					>
						Retry
					</button>
				</p>
			)}
			{!users && !loadError && (
				<div className="space-y-2" aria-busy="true">
					{[1, 2].map((n) => (
						<div key={n} className="h-16 animate-pulse rounded bg-muted" />
					))}
				</div>
			)}
			{users && (
				<TeamMembers
					users={users}
					viewerUserId={viewerUserId}
					supervisors={supervisors}
					onChanged={changed}
					addUserOpen={addUserOpen}
					onAddUserClose={() => setAddUserOpen(false)}
				/>
			)}
			{users && !othersExist && (
				<p className="mt-3 rounded-md border border-dashed border-border p-4 text-sm text-hint">
					No one else has signed in yet. Share this address:{" "}
					<code className="break-all font-mono text-foreground">{window.location.origin}</code>.
					People appear here as members after their first sign-in.
				</p>
			)}
		</>
	);
}

function Checklist({
	items,
	onReview,
	onDismiss,
}: {
	items: ChecklistItem[];
	onReview: () => void;
	onDismiss: (id: ChecklistItem["id"]) => void;
}) {
	return (
		<section
			aria-labelledby={CHECKLIST_HEADING_ID}
			className="mt-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3"
		>
			<h3
				id={CHECKLIST_HEADING_ID}
				tabIndex={-1}
				className="mb-1.5 text-sm font-medium text-foreground focus:outline-none"
			>
				Still to do
			</h3>
			<ul className="space-y-1.5">
				{items.map((item) => (
					<li key={item.id} className="flex items-start gap-2 text-sm">
						<div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5">
							<span className="text-foreground">{item.text}</span>
							{item.id === "manage-keys" ? (
								<a href="#settings-api-keys" className={ACTION_LINK}>
									Review keys
								</a>
							) : item.id === "hosts" ? (
								<Link to="/hosts" className={ACTION_LINK}>
									Review hosts
								</Link>
							) : (
								<button type="button" onClick={onReview} className={ACTION_LINK}>
									Review
								</button>
							)}
							{item.detail && <p className="basis-full text-xs text-hint">{item.detail}</p>}
						</div>
						<button
							type="button"
							onClick={() => onDismiss(item.id)}
							aria-label={`Hide: ${item.text}`}
							className="min-h-[44px] min-w-[44px] shrink-0 px-2 text-xs text-hint hover:text-foreground md:min-h-0"
						>
							Hide
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}

const CHECKLIST_HEADING_ID = "settings-team-checklist-heading";

const ACTION_LINK =
	"inline-flex min-h-[44px] min-w-[44px] items-center text-xs font-medium text-primary underline underline-offset-2 hover:text-foreground md:min-h-0";

// ── Back to solo ────────────────────────────────────────────────────────────

function SoloSwitchDialog({
	apiKeys,
	onClose,
	onSwitched,
}: {
	apiKeys: ApiKeyRow[];
	onClose: () => void;
	onSwitched: () => void;
}) {
	const [users, setUsers] = useState<AdminUserRow[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		api
			.getUsers()
			.then((res) => {
				if (!cancelled) setUsers(res.users);
			})
			.catch((err) => {
				if (!cancelled)
					setError(describeApiError(err, "Couldn't load the people on this install."));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const copy = soloSwitchCopy({
		people: (users ?? []).filter((user) => !user.disabled).length,
		memberManageKeys: users ? membersManageKeyCount(apiKeys, users) : 0,
	});

	async function confirm() {
		setBusy(true);
		setError(null);
		try {
			await api.setInstanceMode("solo", []);
			useUserStore.setState({ mode: "solo" });
			void useUserStore.getState().load();
			toast.success("Back to solo mode. Owner labels are hidden, not deleted.");
			onSwitched();
		} catch (err) {
			setError(describeApiError(err, "Couldn't switch back to solo mode. Try again."));
			setBusy(false);
		}
	}

	return (
		<ConfirmDialog
			title={copy.title}
			confirmLabel={copy.confirmLabel}
			destructive
			busy={busy}
			confirmDisabled={users === null}
			error={error}
			fallbackFocusId={TEAM_HEADING_ID}
			onConfirm={() => void confirm()}
			onCancel={onClose}
		>
			<p>
				{copy.segments.map((segment) =>
					segment.strong ? (
						<strong key={segment.text} className="font-semibold text-foreground">
							{segment.text}
						</strong>
					) : (
						<span key={segment.text}>{segment.text}</span>
					),
				)}
			</p>
		</ConfirmDialog>
	);
}
