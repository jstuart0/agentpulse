import { MoreHorizontal } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { SupervisorRecord } from "../../../shared/types.js";
import { useDropdownClose } from "../../hooks/useDropdownClose.js";
import { describeApiError } from "../../lib/api-errors.js";
import { type AdminUserRow, api } from "../../lib/api.js";
import { disambiguateInitials } from "../../lib/owner-label.js";
import { directoryEntryFromAdminRow } from "../../lib/people.js";
import { UNDO_WINDOW_MS } from "../../pages/dashboard-view-state.js";
import { demotionFollowUp, roleChangeAction } from "../../pages/team-flows.js";
import {
	type MemberRow,
	credentialsCopyText,
	demotionToast,
	memberRows,
} from "../../pages/team-view-state.js";
import { useUserStore } from "../../stores/user-store.js";
import { OneTimeSecret } from "./OneTimeSecret.js";
import {
	AddUserDialog,
	DisableUserDialog,
	PromoteDialog,
	ResetPasswordDialog,
	SelfDemoteDialog,
} from "./TeamDialogs.js";

interface SecretState {
	title: string;
	username: string;
	password: string;
}

interface TeamMembersProps {
	users: AdminUserRow[];
	viewerUserId: string | null;
	supervisors: readonly SupervisorRecord[];
	/** Something about the people (or what they own) changed: reload. */
	onChanged: () => void;
	addUserOpen: boolean;
	onAddUserClose: () => void;
}

/** The people on this install: role, disable/enable, reset password, and the one-time password panel. */
export function TeamMembers({
	users,
	viewerUserId,
	supervisors,
	onChanged,
	addUserOpen,
	onAddUserClose,
}: TeamMembersProps) {
	const rows = useMemo(() => memberRows(users, viewerUserId, Date.now()), [users, viewerUserId]);
	const byId = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);
	const initials = useMemo(
		() =>
			disambiguateInitials(
				users.map((user) => ({ id: user.id, entry: directoryEntryFromAdminRow(user) })),
			),
		[users],
	);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [promote, setPromote] = useState<MemberRow | null>(null);
	const [selfDemote, setSelfDemote] = useState<MemberRow | null>(null);
	const [disable, setDisable] = useState<MemberRow | null>(null);
	const [reset, setReset] = useState<MemberRow | null>(null);
	const [secret, setSecret] = useState<SecretState | null>(null);

	async function setRole(row: MemberRow, role: "user" | "admin") {
		setBusyId(row.id);
		try {
			await api.setUserRole(row.id, role);
			onChanged();
			if (role === "user") {
				const followUp = demotionFollowUp(row);
				// Your own role just changed under you: ask who you are again.
				if (followUp.reloadUser) void useUserStore.getState().load();
				toast.success(
					demotionToast(row),
					followUp.offerUndo
						? {
								action: { label: "Undo", onClick: () => void undoDemotion(row) },
								duration: UNDO_WINDOW_MS,
							}
						: undefined,
				);
			}
		} catch (err) {
			toast.error(describeApiError(err, "Couldn't change the role."));
		} finally {
			setBusyId(null);
		}
	}

	async function undoDemotion(row: MemberRow) {
		try {
			await api.setUserRole(row.id, "admin");
			onChanged();
		} catch (err) {
			toast.error(describeApiError(err, "Couldn't undo that."));
		}
	}

	function handleRoleChange(row: MemberRow, next: "admin" | "member") {
		const action = roleChangeAction(row, next);
		if (action === "confirm_promote") setPromote(row);
		else if (action === "confirm_self_demote") setSelfDemote(row);
		else if (action === "demote") void setRole(row, "user");
	}

	async function enable(row: MemberRow) {
		setBusyId(row.id);
		try {
			await api.enableUser(row.id);
			onChanged();
			toast.success(`${row.name} can sign in again. Their keys and hosts weren't restored.`);
		} catch (err) {
			toast.error(describeApiError(err, "Couldn't enable that account."));
		} finally {
			setBusyId(null);
		}
	}

	const showSecret = (title: string, username: string, password: string) =>
		setSecret({ title, username, password });

	return (
		<>
			{secret && (
				<OneTimeSecret
					title={secret.title}
					rows={[
						{ label: "Sign-in address", value: window.location.origin },
						{ label: "Username", value: secret.username },
						{ label: "Password", value: secret.password, secret: true },
					]}
					copyText={credentialsCopyText({
						signInAddress: window.location.origin,
						username: secret.username,
						password: secret.password,
					})}
					copyLabel="Sign-in details copied"
					note="Shown once. They'll be asked to choose a new password."
					onDismiss={() => setSecret(null)}
				/>
			)}

			<ul className="space-y-2">
				{rows.map((row) => (
					<MemberItem
						key={row.id}
						row={row}
						initials={initials.get(row.id) ?? ""}
						busy={busyId === row.id}
						onRoleChange={(next) => handleRoleChange(row, next)}
						onDisable={() => setDisable(row)}
						onEnable={() => void enable(row)}
						onReset={() => setReset(row)}
					/>
				))}
			</ul>

			{addUserOpen && (
				<AddUserDialog
					onClose={onAddUserClose}
					onCreated={(created) => {
						onAddUserClose();
						onChanged();
						showSecret(`${created.username} can sign in`, created.username, created.password);
					}}
				/>
			)}
			{promote && (
				<PromoteDialog
					row={promote}
					onClose={() => setPromote(null)}
					onPromoted={() => {
						setPromote(null);
						onChanged();
					}}
				/>
			)}
			{selfDemote && (
				<SelfDemoteDialog
					row={selfDemote}
					onClose={() => setSelfDemote(null)}
					onDemoted={() => {
						const demoted = selfDemote;
						setSelfDemote(null);
						void setRole(demoted, "user");
					}}
				/>
			)}
			{disable && (
				<DisableUserDialog
					row={{
						...disable,
						keyCount: byId.get(disable.id)?.keyCount ?? 0,
						hostCount: byId.get(disable.id)?.hostCount ?? 0,
					}}
					hosts={supervisors.filter(
						(host) => host.ownerUserId === disable.id && host.enrollmentState !== "revoked",
					)}
					onClose={() => setDisable(null)}
					onDisabled={() => {
						toast.success(`${disable.name} is disabled.`);
						setDisable(null);
						onChanged();
					}}
				/>
			)}
			{reset && (
				<ResetPasswordDialog
					row={reset}
					onClose={() => setReset(null)}
					onReset={(password) => {
						showSecret(
							`New password for ${reset.name}`,
							byId.get(reset.id)?.username ?? reset.name,
							password,
						);
						setReset(null);
						onChanged();
					}}
				/>
			)}
		</>
	);
}

function MemberItem({
	row,
	initials,
	busy,
	onRoleChange,
	onDisable,
	onEnable,
	onReset,
}: {
	row: MemberRow;
	initials: string;
	busy: boolean;
	onRoleChange: (next: "admin" | "member") => void;
	onDisable: () => void;
	onEnable: () => void;
	onReset: () => void;
}) {
	const reasonId = useId();
	const helperId = useId();
	const reasons = [row.roleControl.reason, row.disableControl.reason].filter(
		(reason, index, all): reason is string => Boolean(reason) && all.indexOf(reason) === index,
	);

	return (
		<li
			className={`rounded-md border px-4 py-3 ${
				row.disabled ? "border-border/50 bg-muted/30" : "border-border bg-background"
			}`}
		>
			<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
				<div className="flex min-w-0 flex-1 basis-56 items-start gap-3">
					<span
						aria-hidden="true"
						className="mt-0.5 inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-foreground"
					>
						{initials}
					</span>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span
								className={`min-w-0 break-words text-sm font-medium ${row.disabled ? "text-hint" : "text-foreground"}`}
							>
								{row.name}
							</span>
							{row.isSelf && <span className="text-xs text-hint">you</span>}
							{row.disabled && <Badge tone="red">Disabled</Badge>}
							{row.mustChangePassword && !row.disabled && (
								<Badge tone="amber">Must choose a password</Badge>
							)}
							{row.identifiedByUsername && <Badge tone="neutral">Identified by username</Badge>}
						</div>
						<p className="mt-0.5 break-words text-xs text-hint">{row.meta}</p>
						{row.identifiedByUsername && (
							<p id={helperId} className="mt-0.5 text-xs text-hint">
								Matched by username: the identity provider didn't send a stable id.
							</p>
						)}
					</div>
				</div>

				<div className="flex items-center gap-2">
					<select
						value={row.role}
						disabled={!row.roleControl.enabled || busy}
						aria-label={row.roleAriaLabel}
						aria-describedby={row.roleControl.reason ? reasonId : undefined}
						onChange={(e) => onRoleChange(e.target.value as "admin" | "member")}
						className="min-h-[44px] rounded-md border border-input bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 md:min-h-0"
					>
						<option value="admin">Admin</option>
						<option value="member">Member</option>
					</select>
					{(row.canResetPassword || row.canEnable || row.disableControl.enabled) && (
						<MoreMenu
							row={row}
							busy={busy}
							describedBy={row.disableControl.reason ? reasonId : undefined}
							onReset={onReset}
							onDisable={onDisable}
							onEnable={onEnable}
						/>
					)}
				</div>
			</div>
			{reasons.length > 0 && (
				<div id={reasonId} className="mt-2 space-y-0.5 pl-11">
					{reasons.map((reason) => (
						<p key={reason} className="text-xs text-hint">
							{reason}
						</p>
					))}
				</div>
			)}
		</li>
	);
}

/** Reset password and Disable / Enable, out of the way until wanted. Focus returns to the button before a dialog opens, so closing the dialog lands back here. */
function MoreMenu({
	row,
	busy,
	describedBy,
	onReset,
	onDisable,
	onEnable,
}: {
	row: MemberRow;
	busy: boolean;
	describedBy: string | undefined;
	onReset: () => void;
	onDisable: () => void;
	onEnable: () => void;
}) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const containerRef = useDropdownClose(() => setOpen(false));
	const menuId = useId();

	useEffect(() => {
		if (open) menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
	}, [open]);

	function choose(action: () => void) {
		setOpen(false);
		triggerRef.current?.focus();
		action();
	}

	function onKeyDown(e: React.KeyboardEvent) {
		const items = Array.from(
			menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [],
		);
		const index = items.indexOf(document.activeElement as HTMLElement);
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
			triggerRef.current?.focus();
		} else if (e.key === "ArrowDown") {
			e.preventDefault();
			items[(index + 1) % items.length]?.focus();
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			items[(index - 1 + items.length) % items.length]?.focus();
		} else if (e.key === "Home") {
			e.preventDefault();
			items[0]?.focus();
		} else if (e.key === "End") {
			e.preventDefault();
			items[items.length - 1]?.focus();
		} else if (e.key === "Tab") {
			setOpen(false);
		}
	}

	const itemClass =
		"flex min-h-[44px] w-full items-center px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus:bg-accent focus:outline-none aria-disabled:cursor-not-allowed aria-disabled:opacity-50 md:min-h-0";

	return (
		<div ref={containerRef} className="relative">
			<button
				ref={triggerRef}
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				aria-label={row.moreActionsLabel}
				aria-busy={busy || undefined}
				onClick={() => !busy && setOpen((v) => !v)}
				className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-accent disabled:opacity-60 md:min-h-0 md:min-w-0 md:p-2"
			>
				<MoreHorizontal className="h-4 w-4" aria-hidden="true" />
			</button>
			{open && (
				<div
					ref={menuRef}
					id={menuId}
					role="menu"
					aria-label={row.moreActionsLabel}
					onKeyDown={onKeyDown}
					className="absolute right-0 z-20 mt-1 min-w-[11rem] overflow-hidden rounded-md border border-border bg-card py-1 shadow-lg"
				>
					{row.canResetPassword && (
						<button
							type="button"
							role="menuitem"
							onClick={() => choose(onReset)}
							className={`${itemClass} text-foreground`}
						>
							Reset password
						</button>
					)}
					{row.canEnable ? (
						<button
							type="button"
							role="menuitem"
							onClick={() => choose(onEnable)}
							className={`${itemClass} text-foreground`}
						>
							Enable
						</button>
					) : (
						<button
							type="button"
							role="menuitem"
							aria-disabled={row.disableControl.enabled ? undefined : true}
							aria-describedby={describedBy}
							onClick={() => {
								if (row.disableControl.enabled) choose(onDisable);
							}}
							className={`${itemClass} text-red-700 dark:text-red-400`}
						>
							Disable
						</button>
					)}
				</div>
			)}
		</div>
	);
}

const BADGE_TONES = {
	neutral: "bg-muted text-hint",
	teal: "bg-teal-500/10 text-teal-800 dark:text-teal-300",
	amber: "bg-amber-500/10 text-amber-900 dark:text-amber-300",
	red: "bg-red-500/10 text-red-800 dark:text-red-300",
} as const;

export function Badge({
	tone,
	title,
	children,
}: {
	tone: keyof typeof BADGE_TONES;
	title?: string;
	children: React.ReactNode;
}) {
	return (
		<span
			title={title}
			className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${BADGE_TONES[tone]}`}
		>
			{children}
		</span>
	);
}
