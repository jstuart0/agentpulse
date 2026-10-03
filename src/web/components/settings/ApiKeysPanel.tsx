import { type Dispatch, type SetStateAction, useMemo, useState } from "react";
import { toast } from "sonner";
import { useCopyFeedback } from "../../hooks/useCopyFeedback.js";
import { useNoteUnknownOwners } from "../../hooks/useNoteUnknownOwners.js";
import { useOwnershipUi, useViewerIsAdmin } from "../../hooks/useOwnershipUi.js";
import { useSecretLifetime } from "../../hooks/useSecretLifetime.js";
import {
	describeApiError,
	keyCreationErrorMessage,
	revokeKeyFailure,
} from "../../lib/api-errors.js";
import { type ApiKeyRow, api } from "../../lib/api.js";
import { RELAY_KEY_HINT, relayKeyHint } from "../../lib/onboarding.js";
import { SECRET_LIFETIME_NOTE } from "../../lib/one-time-secret.js";
import { keyLabel, ownerLabel } from "../../lib/owner-label.js";
import { assignablePeople } from "../../lib/people.js";
import { type FetchStatus, sectionLoad } from "../../pages/settings-view-state.js";
import {
	SERVICE_KEY_CHECKBOX_LABEL,
	SERVICE_KEY_HELPER,
	canCreateServiceKey,
	createKeyRequest,
} from "../../pages/team-flows.js";
import { type KeyRowModel, keyListIntro, keyRowModel } from "../../pages/team-view-state.js";
import { useUserStore } from "../../stores/user-store.js";
import { useUsersStore } from "../../stores/users-store.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { AssignKeyDialog } from "./AssignKeyDialog.js";
import { Badge } from "./TeamMembers.js";

interface ApiKeysPanelProps {
	apiKeys: ApiKeyRow[];
	/** Whether the key list loaded. A list that failed to load is not an empty one. */
	status: FetchStatus;
	setApiKeys: Dispatch<SetStateAction<ApiKeyRow[]>>;
	reloadKeys: () => Promise<void>;
}

type PendingAction =
	| { kind: "revoke"; key: ApiKeyRow; confirm: NonNullable<KeyRowModel["revokeConfirm"]> }
	| { kind: "keep"; key: ApiKeyRow }
	| { kind: "assign"; key: ApiKeyRow };

/**
 * Settings → API Keys. In solo mode this is the list as it has always been;
 * in team mode each row also says whose key it is, and an admin can hand keys
 * to people, keep a service key as an admin key, or mint a service key.
 */
export function ApiKeysPanel({ apiKeys, status, setApiKeys, reloadKeys }: ApiKeysPanelProps) {
	const ui = useOwnershipUi();
	const viewerUserId = useUserStore((s) => s.userId);
	const isAdmin = useViewerIsAdmin();
	const directory = useUsersStore((s) => s.byId);
	const { copy } = useCopyFeedback();
	const load = sectionLoad(status, "API keys");

	const [newKeyName, setNewKeyName] = useState("");
	const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
	// Scope picker: ingest is on by default; manage and observe are opt-in.
	const [newKeyScopeIngest, setNewKeyScopeIngest] = useState(true);
	const [newKeyScopeManage, setNewKeyScopeManage] = useState(false);
	const [newKeyScopeObserve, setNewKeyScopeObserve] = useState(false);
	const [newKeyService, setNewKeyService] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [pending, setPending] = useState<PendingAction | null>(null);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

	useSecretLifetime(newKeyValue !== null, () => setNewKeyValue(null));
	useNoteUnknownOwners(apiKeys.map((key) => key.ownerUserId));

	const ownerName = (id: string) =>
		ownerLabel(directory[id], id, { selfId: viewerUserId, style: "you" });
	const people = useMemo(
		() => assignablePeople(Object.values(directory), viewerUserId),
		[directory, viewerUserId],
	);
	const recordServiceKeys = apiKeys.some((key) => key.serviceKey !== undefined);
	const intro = keyListIntro(ui, isAdmin);
	const allowService = canCreateServiceKey(ui, isAdmin);

	async function handleCreateKey() {
		if (!newKeyName.trim() || !load.canSave) return;
		setCreateError(null);
		const request = createKeyRequest({
			name: newKeyName,
			ingest: newKeyScopeIngest,
			manage: newKeyScopeManage,
			observe: newKeyScopeObserve,
			service: newKeyService,
			allowService,
		});

		try {
			const data = await api.createApiKey(
				request.name,
				request.scopes,
				request.service ? { service: true } : undefined,
			);

			if (data.key) {
				setNewKeyValue(data.key);
				setNewKeyName("");
				setNewKeyScopeIngest(true);
				setNewKeyScopeManage(false);
				setNewKeyScopeObserve(false);
				setNewKeyService(false);
				await reloadKeys();
			}
		} catch (err) {
			setCreateError(keyCreationErrorMessage(err));
		}
	}

	// Revoke without a question: solo mode, as it has always been.
	async function revokeNow(id: string) {
		setRowError(null);
		try {
			await api.revokeApiKey(id);
			setApiKeys((prev) => prev.map((k) => (k.id === id ? { ...k, isActive: false } : k)));
		} catch (err) {
			const failure = revokeKeyFailure(err);
			if (failure.stale) refreshAfterStaleRevoke(failure.message);
			else setRowError({ id, message: failure.message });
		}
	}

	// A row action often removes the button that was used; focus the row so the
	// keyboard stays where the action happened rather than dropping to the page.
	function focusRow(keyId: string) {
		requestAnimationFrame(() => document.getElementById(keyRowId(keyId))?.focus());
	}

	// This tab's list was out of date: say so, drop any dialog, and show what is true now.
	function refreshAfterStaleRevoke(message: string) {
		setPending(null);
		setActionError(null);
		toast.error(message);
		void reloadKeys();
		void useUserStore.getState().load();
	}

	async function markService(key: ApiKeyRow) {
		setRowError(null);
		try {
			await api.patchApiKey(key.id, { serviceKey: true });
			await reloadKeys();
			toast.success(`${keyLabel(key.name)} is kept as a service key.`);
			focusRow(key.id);
		} catch (err) {
			setRowError({
				id: key.id,
				message: describeApiError(err, "Couldn't keep that key as a service key. Try again."),
			});
		}
	}

	async function confirmPending() {
		if (!pending) return;
		setBusy(true);
		setActionError(null);
		try {
			if (pending.kind === "revoke") {
				await api.revokeApiKey(pending.key.id);
				setApiKeys((prev) =>
					prev.map((k) => (k.id === pending.key.id ? { ...k, isActive: false } : k)),
				);
				toast.success(`${keyLabel(pending.key.name)} is revoked.`);
				focusRow(pending.key.id);
			} else if (pending.kind === "keep") {
				await api.patchApiKey(pending.key.id, { adminService: true });
				await reloadKeys();
				toast.success(`${keyLabel(pending.key.name)} is kept as an admin service key.`);
				focusRow(pending.key.id);
			}
			setPending(null);
		} catch (err) {
			if (pending.kind === "revoke") {
				const failure = revokeKeyFailure(err);
				if (failure.stale) refreshAfterStaleRevoke(failure.message);
				else setActionError(failure.message);
			} else {
				setActionError(describeApiError(err, "Couldn't do that. Try again."));
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<section id="settings-api-keys" className="border border-border bg-card rounded-lg p-5 mb-6">
			<h2
				id="api-keys-heading"
				tabIndex={-1}
				className="text-sm font-semibold mb-1 focus:outline-none"
			>
				API Keys
			</h2>
			<p className="text-xs text-muted-foreground mb-4">
				API keys authenticate hook events from Claude Code, Codex CLI, and Copilot CLI, and the
				relay that forwards them from other machines.
			</p>
			{intro.intro && <p className="-mt-2 mb-4 text-xs text-hint">{intro.intro}</p>}

			{/* New key creation */}
			{newKeyValue && (
				<div className="mb-4 rounded-md border border-emerald-500/30 bg-emerald-500/5 p-4">
					<p className="text-sm font-medium text-emerald-700 dark:text-emerald-400 mb-1">
						New API key created
					</p>
					<p className="text-xs text-muted-foreground mb-2">
						Copy this key now -- it will not be shown again. {SECRET_LIFETIME_NOTE}
					</p>
					<div className="flex items-center gap-2">
						<code className="flex-1 rounded bg-background px-3 py-2 text-sm font-mono text-foreground border border-border">
							{newKeyValue}
						</code>
						<button
							type="button"
							onClick={() => copy(newKeyValue, "API key copied")}
							className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
						>
							Copy
						</button>
					</div>
					<button
						type="button"
						onClick={() => setNewKeyValue(null)}
						className="mt-2 text-xs text-muted-foreground hover:text-foreground"
					>
						Dismiss
					</button>
				</div>
			)}

			<fieldset disabled={load.inputsDisabled} className="m-0 min-w-0 border-0 p-0">
				<div className="flex flex-col gap-2 mb-4">
					<div className="flex flex-col sm:flex-row gap-2">
						<input
							type="text"
							value={newKeyName}
							onChange={(e) => {
								setNewKeyName(e.target.value);
								setCreateError(null);
							}}
							placeholder="Key name (e.g. macbook-hooks)"
							aria-label="Key name"
							onKeyDown={(e) => e.key === "Enter" && handleCreateKey()}
							className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
						/>
						<button
							type="button"
							onClick={handleCreateKey}
							disabled={!newKeyName.trim()}
							className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
						>
							Create Key
						</button>
					</div>
					<div className="flex items-center gap-4 text-xs text-muted-foreground">
						<span className="font-medium text-foreground">Scopes:</span>
						<label className="flex items-center gap-1.5 cursor-pointer">
							<input
								type="checkbox"
								checked={newKeyScopeIngest}
								onChange={(e) => setNewKeyScopeIngest(e.target.checked)}
								className="rounded border-input"
							/>
							<span>Hook ingest</span>
							<span className="text-muted-foreground/60">(hook events)</span>
						</label>
						<label className="flex items-center gap-1.5 cursor-pointer">
							<input
								type="checkbox"
								checked={newKeyScopeManage}
								onChange={(e) => setNewKeyScopeManage(e.target.checked)}
								className="rounded border-input"
							/>
							<span>Manage</span>
							<span className="text-muted-foreground/60">(supervisors, API keys)</span>
						</label>
						<label className="flex items-center gap-1.5 cursor-pointer">
							<input
								type="checkbox"
								checked={newKeyScopeObserve}
								onChange={(e) => setNewKeyScopeObserve(e.target.checked)}
								className="rounded border-input"
							/>
							<span>Observe (read-only)</span>
							<span className="text-muted-foreground/60">(sessions, search, AI reads)</span>
						</label>
					</div>
					{allowService && (
						<div className="space-y-0.5">
							<label className="flex min-h-[44px] cursor-pointer items-center gap-1.5 text-xs text-foreground md:min-h-0">
								<input
									type="checkbox"
									checked={newKeyService}
									onChange={(e) => setNewKeyService(e.target.checked)}
									aria-describedby="service-key-helper"
									className="rounded border-input"
								/>
								<span>{SERVICE_KEY_CHECKBOX_LABEL}</span>
							</label>
							<p id="service-key-helper" className="pl-5 text-xs text-hint">
								{SERVICE_KEY_HELPER}
							</p>
						</div>
					)}
					{createError && (
						<p role="alert" className="text-xs text-red-700 dark:text-red-400">
							{createError}
						</p>
					)}
				</div>
			</fieldset>

			{/* Key list */}
			{status === "loading" ? (
				<div className="space-y-2">
					{[1, 2].map((i) => (
						<div key={i} className="h-12 bg-muted rounded animate-pulse" />
					))}
				</div>
			) : load.showError ? (
				<p role="alert" className="py-4 text-center text-sm text-red-700 dark:text-red-400">
					{load.message}{" "}
					<button
						type="button"
						onClick={() => void reloadKeys()}
						className="min-h-[44px] font-medium underline md:min-h-0"
					>
						Retry
					</button>
				</p>
			) : apiKeys.length === 0 ? (
				<p className="text-sm text-muted-foreground py-4 text-center">
					No API keys yet. Create one above.
				</p>
			) : (
				<div className="space-y-2">
					{apiKeys.map((key) => {
						const model = keyRowModel(key, { ui, viewerUserId, isAdmin, ownerName });
						const hasActions =
							model.canAssign || model.canKeepAsAdmin || model.canMarkService || model.canRevoke;
						return (
							<div
								key={key.id}
								id={keyRowId(key.id)}
								tabIndex={-1}
								className={`flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between rounded-md border px-4 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
									key.isActive
										? "border-border bg-background"
										: `border-border/50 bg-muted/30 ${ui.showKeyOwner ? "" : "opacity-60"}`
								}`}
							>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-sm font-medium text-foreground">
											{keyLabel(key.name)}
										</span>
										{!key.isActive && (
											<span
												className={`text-[10px] rounded bg-red-500/10 px-1.5 py-0.5 ${
													ui.showKeyOwner
														? "text-red-700 dark:text-red-300"
														: "text-red-600 dark:text-red-400"
												}`}
											>
												revoked
											</span>
										)}
										{model.badges.map((badge) => (
											<Badge key={badge.text} tone={badge.tone === "amber" ? "amber" : "neutral"}>
												{badge.text}
											</Badge>
										))}
									</div>
									<div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-0.5">
										<code className="text-xs text-muted-foreground font-mono">
											{key.keyPrefix}...
										</code>
										{model.ownerText && (
											<span className="text-xs text-foreground">{model.ownerText}</span>
										)}
										<span className="text-xs text-muted-foreground">
											Created {new Date(key.createdAt).toLocaleDateString()}
										</span>
										{key.lastUsedAt && (
											<span className="text-xs text-muted-foreground">
												Last used {new Date(key.lastUsedAt).toLocaleDateString()}
											</span>
										)}
										{key.scopes && key.scopes.length > 0 && (
											<span className="text-xs font-mono text-muted-foreground border border-border rounded px-1.5 py-0.5">
												{key.scopes.join(", ")}
											</span>
										)}
									</div>
									{model.note && <p className="mt-1 text-xs text-hint">{model.note}</p>}
									{key.isActive && key.scopes && relayKeyHint(key.scopes) && (
										<p className="mt-1 text-xs text-muted-foreground">{RELAY_KEY_HINT}</p>
									)}
									{rowError?.id === key.id && (
										<p role="alert" className="mt-1 text-xs text-red-700 dark:text-red-400">
											{rowError.message}
										</p>
									)}
								</div>
								{hasActions && (
									<div className="flex flex-wrap items-center gap-1">
										{model.canAssign && (
											<button
												type="button"
												onClick={() => setPending({ kind: "assign", key })}
												aria-label={`${key.ownerUserId ? "Change owner of" : "Assign an owner to"} ${keyLabel(key.name)}`}
												className={ROW_BUTTON}
											>
												{key.ownerUserId ? "Change owner" : "Assign…"}
											</button>
										)}
										{model.canMarkService && (
											<button
												type="button"
												onClick={() => void markService(key)}
												className={ROW_BUTTON}
											>
												Keep as service key
											</button>
										)}
										{model.canKeepAsAdmin && (
											<button
												type="button"
												onClick={() => setPending({ kind: "keep", key })}
												className={ROW_BUTTON}
											>
												Keep as admin key
											</button>
										)}
										{model.canRevoke && (
											<button
												type="button"
												onClick={() =>
													model.revokeConfirm
														? setPending({ kind: "revoke", key, confirm: model.revokeConfirm })
														: void revokeNow(key.id)
												}
												className={`rounded-md px-3 py-1.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors ${ui.showKeyOwner ? "min-h-[44px] sm:min-h-0" : ""}`}
											>
												Revoke
											</button>
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}

			{pending?.kind === "revoke" && (
				<ConfirmDialog
					title={pending.confirm.title}
					confirmLabel="Revoke key"
					destructive
					fallbackFocusId="api-keys-heading"
					busy={busy}
					error={actionError}
					onConfirm={() => void confirmPending()}
					onCancel={() => {
						setPending(null);
						setActionError(null);
					}}
				>
					<p>{pending.confirm.body}</p>
				</ConfirmDialog>
			)}
			{pending?.kind === "keep" && (
				<ConfirmDialog
					title={`Keep ${keyLabel(pending.key.name)} as an admin service key?`}
					confirmLabel="Keep as admin key"
					fallbackFocusId="api-keys-heading"
					busy={busy}
					error={actionError}
					onConfirm={() => void confirmPending()}
					onCancel={() => {
						setPending(null);
						setActionError(null);
					}}
				>
					<p>
						Anyone holding this key has full admin access, except for managing people and the mode.
						This choice is recorded and you can change it later.
					</p>
				</ConfirmDialog>
			)}
			{pending?.kind === "assign" && (
				<AssignKeyDialog
					fallbackFocusId="api-keys-heading"
					keyInfo={pending.key}
					people={people}
					recordServiceKeys={recordServiceKeys}
					onClose={() => setPending(null)}
					onAssigned={() => {
						setPending(null);
						void reloadKeys();
						focusRow(pending.key.id);
					}}
				/>
			)}
		</section>
	);
}

const keyRowId = (keyId: string) => `key-row-${keyId}`;

const ROW_BUTTON =
	"min-h-[44px] rounded-md px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent sm:min-h-0";
