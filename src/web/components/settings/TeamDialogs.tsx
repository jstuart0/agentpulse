import { type FormEvent, useId, useRef, useState } from "react";
import type { SupervisorRecord } from "../../../shared/types.js";
import { describeApiError } from "../../lib/api-errors.js";
import { api } from "../../lib/api.js";
import { disableRequestBody, selfDemoteConfirm } from "../../pages/team-flows.js";
import {
	type MemberRow,
	disableDialogCopy,
	promoteConfirm,
	usernameProblem,
} from "../../pages/team-view-state.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { DialogFooter, FIELD_CONTROL, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../DialogParts.js";
import { DialogShell } from "../DialogShell.js";
import { TEAM_HEADING_ID } from "./mode-dialog-data.js";

// ── Add user ────────────────────────────────────────────────────────────────

export interface CreatedUser {
	username: string;
	password: string;
}

export function AddUserDialog({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: (created: CreatedUser) => void;
}) {
	const headingId = useId();
	const usernameId = useId();
	const roleId = useId();
	const hintId = useId();
	const [username, setUsername] = useState("");
	const [role, setRole] = useState<"user" | "admin">("user");
	const [problem, setProblem] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const usernameRef = useRef<HTMLInputElement>(null);

	async function submit(e: FormEvent) {
		e.preventDefault();
		const trimmed = username.trim();
		const found = usernameProblem(trimmed);
		setProblem(found);
		setError(null);
		if (found) {
			usernameRef.current?.focus();
			return;
		}
		setBusy(true);
		try {
			const created = await api.createUser({ username: trimmed, role });
			onCreated({ username: created.user.username, password: created.password });
		} catch (err) {
			setError(describeApiError(err, "Couldn't add that user. Try again."));
			setBusy(false);
		}
	}

	return (
		<DialogShell
			labelledBy={headingId}
			onClose={busy ? undefined : onClose}
			fallbackFocusId={TEAM_HEADING_ID}
		>
			<form onSubmit={submit} noValidate className="flex flex-1 flex-col">
				<div className="flex-1 space-y-4 p-5 md:p-6">
					<h2 id={headingId} className="text-base font-semibold text-foreground">
						Add user
					</h2>
					<p className="text-sm text-hint">
						Creates a local account with a one-time password. Nothing is sent to them: you hand over
						the sign-in details yourself.
					</p>
					<div className="space-y-1">
						<label htmlFor={usernameId} className="block text-sm text-foreground">
							Username
						</label>
						<input
							ref={usernameRef}
							id={usernameId}
							type="text"
							data-autofocus=""
							autoComplete="off"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							aria-invalid={problem ? true : undefined}
							aria-describedby={hintId}
							className={`${FIELD_CONTROL} aria-[invalid=true]:border-red-500`}
						/>
						<p
							id={hintId}
							className={`text-xs ${problem ? "text-red-700 dark:text-red-400" : "text-hint"}`}
							role={problem ? "alert" : undefined}
						>
							{problem ?? "2 to 64 characters: letters, digits, _ - and ."}
						</p>
					</div>
					<div className="space-y-1">
						<label htmlFor={roleId} className="block text-sm text-foreground">
							Role
						</label>
						<select
							id={roleId}
							value={role}
							onChange={(e) => setRole(e.target.value as "user" | "admin")}
							className={`${FIELD_CONTROL} sm:w-48`}
						>
							<option value="user">Member</option>
							<option value="admin">Admin</option>
						</select>
					</div>
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
						{busy ? "Adding…" : "Add user"}
					</button>
				</DialogFooter>
			</form>
		</DialogShell>
	);
}

// ── Disable ─────────────────────────────────────────────────────────────────

export function DisableUserDialog({
	row,
	hosts,
	onClose,
	onDisabled,
}: {
	row: MemberRow & { keyCount: number; hostCount: number };
	hosts: readonly SupervisorRecord[];
	onClose: () => void;
	onDisabled: () => void;
}) {
	const copy = disableDialogCopy({
		name: row.name,
		keyCount: row.keyCount,
		hostCount: row.hostCount,
		hostNames: hosts.map((host) => host.hostName),
	});
	const [revokeHosts, setRevokeHosts] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const checkboxId = useId();

	async function confirm() {
		setBusy(true);
		setError(null);
		try {
			await api.disableUser(
				row.id,
				disableRequestBody({ hasHostCheckbox: copy.hostCheckbox !== null, revokeHosts }),
			);
			onDisabled();
		} catch (err) {
			setError(describeApiError(err, "Couldn't disable that account. Try again."));
			setBusy(false);
		}
	}

	return (
		<ConfirmDialog
			fallbackFocusId={TEAM_HEADING_ID}
			title={copy.title}
			confirmLabel={copy.confirmLabel}
			destructive
			busy={busy}
			error={error}
			onConfirm={() => void confirm()}
			onCancel={onClose}
		>
			<p>{copy.body}</p>
			{copy.hostCheckbox && (
				<label
					htmlFor={checkboxId}
					className="flex min-h-[44px] cursor-pointer items-start gap-2 text-foreground md:min-h-0"
				>
					<input
						id={checkboxId}
						type="checkbox"
						checked={revokeHosts}
						onChange={(e) => setRevokeHosts(e.target.checked)}
						className="mt-1 rounded border-input accent-primary"
					/>
					<span>{copy.hostCheckbox.label}</span>
				</label>
			)}
		</ConfirmDialog>
	);
}

// ── Reset password, promote ─────────────────────────────────────────────────

export function ResetPasswordDialog({
	row,
	onClose,
	onReset,
}: {
	row: MemberRow;
	onClose: () => void;
	onReset: (password: string) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function confirm() {
		setBusy(true);
		setError(null);
		try {
			onReset((await api.resetUserPassword(row.id)).password);
		} catch (err) {
			setError(describeApiError(err, "Couldn't reset the password. Try again."));
			setBusy(false);
		}
	}

	return (
		<ConfirmDialog
			fallbackFocusId={TEAM_HEADING_ID}
			title={`Reset ${row.name}'s password?`}
			confirmLabel="Reset password"
			destructive
			busy={busy}
			error={error}
			onConfirm={() => void confirm()}
			onCancel={onClose}
		>
			<p>
				{row.name} is signed out everywhere and their current password stops working. You'll get a
				new one-time password to hand over, and they'll be asked to choose their own.
			</p>
		</ConfirmDialog>
	);
}

export function PromoteDialog({
	row,
	onClose,
	onPromoted,
}: {
	row: MemberRow;
	onClose: () => void;
	onPromoted: () => void;
}) {
	const copy = promoteConfirm(row);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function confirm() {
		setBusy(true);
		setError(null);
		try {
			await api.setUserRole(row.id, "admin");
			onPromoted();
		} catch (err) {
			setError(describeApiError(err, "Couldn't change the role. Try again."));
			setBusy(false);
		}
	}

	return (
		<ConfirmDialog
			fallbackFocusId={TEAM_HEADING_ID}
			title={copy.title}
			confirmLabel={copy.confirmLabel}
			busy={busy}
			error={error}
			onConfirm={() => void confirm()}
			onCancel={onClose}
		>
			<p>{copy.body}</p>
			{copy.extra && (
				<p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-900 dark:text-amber-200">
					{copy.extra}
				</p>
			)}
		</ConfirmDialog>
	);
}

/** You are about to give up your own admin role: say what that costs before doing it. */
export function SelfDemoteDialog({
	row: _row,
	onClose,
	onDemoted,
}: {
	row: MemberRow;
	onClose: () => void;
	onDemoted: () => void;
}) {
	const copy = selfDemoteConfirm();
	return (
		<ConfirmDialog
			fallbackFocusId={TEAM_HEADING_ID}
			title={copy.title}
			confirmLabel={copy.confirmLabel}
			destructive
			onConfirm={onDemoted}
			onCancel={onClose}
		>
			<p>{copy.body}</p>
		</ConfirmDialog>
	);
}
