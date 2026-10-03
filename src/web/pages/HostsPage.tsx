import { useEffect, useState } from "react";
import type { SupervisorRecord } from "../../shared/types.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { HostOwnerDialog } from "../components/HostOwnerDialog.js";
import { useCopyFeedback } from "../hooks/useCopyFeedback.js";
import { useNoteUnknownOwners } from "../hooks/useNoteUnknownOwners.js";
import { useOwnershipUi, useViewerIsAdmin } from "../hooks/useOwnershipUi.js";
import { useSecretLifetime } from "../hooks/useSecretLifetime.js";
import { describeApiError } from "../lib/api-errors.js";
import { ApiError, api } from "../lib/api.js";
import { SECRET_LIFETIME_NOTE } from "../lib/one-time-secret.js";
import { ownerLabel } from "../lib/owner-label.js";
import { assignablePeople } from "../lib/people.js";
import { useDbFingerprintStore } from "../stores/db-fingerprint-store.js";
import { useUserStore } from "../stores/user-store.js";
import { useUsersStore } from "../stores/users-store.js";
import {
	deriveHostAccess,
	deriveHostsViewState,
	enrollmentOwnershipNote,
	hostActionConfirm,
} from "./hosts-view-state.js";

/**
 * "<status> <server message>" for a real HTTP error (e.g. "403
 * insufficient_scope"), or "network error" otherwise — distinguishing an
 * auth/scope problem from a network failure, instead of the generic
 * "Failed to ..." text every action on this page used to show regardless
 * of cause.
 */
function formatApiErrorDetail(err: unknown): string {
	if (err instanceof ApiError) {
		return `${err.status} ${err.message}`;
	}
	return "network error";
}

/** A known refusal reads as a plain sentence; anything else keeps the status-and-message detail. */
function failureText(prefix: string, err: unknown): string {
	return describeApiError(err, "") || `${prefix}: ${formatApiErrorDetail(err)}`;
}

/**
 * Builds the load-failure copy shown in place of the list — distinct from
 * the genuine "no hosts registered" empty state, which is the bug this
 * exists to fix: a failed list request used to render identically to a
 * server with zero registered hosts.
 */
function formatLoadError(err: unknown): string {
	return `Couldn't load hosts: ${formatApiErrorDetail(err)}`;
}

export function HostsPage() {
	const { copy } = useCopyFeedback();
	const ui = useOwnershipUi();
	const viewerUserId = useUserStore((s) => s.userId);
	const isAdmin = useViewerIsAdmin();
	const directory = useUsersStore((s) => s.byId);
	const [ownerDialogHost, setOwnerDialogHost] = useState<SupervisorRecord | null>(null);
	const [supervisors, setSupervisors] = useState<SupervisorRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [enrollName, setEnrollName] = useState("");
	const [enrollExpiresAt, setEnrollExpiresAt] = useState("");
	const [creatingToken, setCreatingToken] = useState(false);
	const [pendingAction, setPendingAction] = useState<{
		kind: "rotate" | "revoke";
		supervisor: SupervisorRecord;
	} | null>(null);
	const [actionBusy, setActionBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	// Refusals sit next to the control that was used: the token form's own, or the host card's.
	const [enrollError, setEnrollError] = useState("");
	const [createdToken, setCreatedToken] = useState<{
		token: string;
		name: string;
		expiresAt: string | null;
		mode: "enroll" | "rotate";
		hostName?: string | null;
	} | null>(null);

	async function loadSupervisors(showInitialLoader = false) {
		if (showInitialLoader) {
			setLoading(true);
		} else {
			setRefreshing(true);
		}
		try {
			const result = (await api.getSupervisors()) as { supervisors: SupervisorRecord[] };
			setSupervisors(result.supervisors ?? []);
			setLoadError(null);
		} catch (err) {
			console.error("Failed to load supervisors:", err);
			setLoadError(formatLoadError(err));
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	}

	useEffect(() => {
		loadSupervisors(true);

		// Record this page's own health sample too — don't wait for App.tsx's
		// next ~60s poll tick to notice a split database (see
		// db-fingerprint-watch.ts).
		api
			.getHealth()
			.then((health) => {
				if (health.instance?.dbFingerprint) {
					useDbFingerprintStore.getState().record(health.instance.dbFingerprint);
				}
			})
			.catch(() => {
				// Best-effort; the periodic App.tsx poll will try again.
			});
	}, []);

	async function handleCreateEnrollmentToken() {
		setCreatingToken(true);
		setEnrollError("");
		try {
			const result = await api.enrollSupervisor({
				name: enrollName.trim() || "supervisor",
				expiresAt: enrollExpiresAt || null,
			});
			setCreatedToken({
				token: result.token,
				name: result.info.name,
				expiresAt: result.info.expiresAt,
				mode: "enroll",
				hostName: null,
			});
			setEnrollName("");
			setEnrollExpiresAt("");
		} catch (err) {
			console.error("Failed to create enrollment token:", err);
			setEnrollError(failureText("Failed to create enrollment token", err));
		} finally {
			setCreatingToken(false);
		}
	}

	async function handleCopyToken() {
		if (!createdToken?.token) return;
		await copy(createdToken.token, "Enrollment token copied");
	}

	async function runPendingAction() {
		if (!pendingAction) return;
		const { kind, supervisor } = pendingAction;
		setActionBusy(true);
		setActionError(null);
		try {
			if (kind === "revoke") {
				await api.revokeSupervisor(supervisor.id);
				await loadSupervisors();
			} else {
				const result = await api.rotateSupervisor(supervisor.id, {});
				setCreatedToken({
					token: result.token,
					name: result.info.name,
					expiresAt: result.info.expiresAt,
					mode: "rotate",
					hostName: supervisor.hostName,
				});
			}
			setPendingAction(null);
		} catch (err) {
			console.error(`Failed to ${kind} supervisor:`, err);
			setActionError(
				failureText(
					kind === "revoke" ? "Failed to revoke host" : "Failed to create re-enrollment token",
					err,
				),
			);
		} finally {
			setActionBusy(false);
		}
	}

	function statusClasses(status: SupervisorRecord["status"]) {
		if (status === "connected") return "bg-emerald-500/10 text-emerald-400";
		if (status === "stale") return "bg-amber-500/10 text-amber-400";
		return "bg-red-500/10 text-red-400";
	}

	function enrollmentClasses(state: SupervisorRecord["enrollmentState"]) {
		if (state === "revoked") return "bg-red-500/10 text-red-400";
		if (state === "pending") return "bg-amber-500/10 text-amber-400";
		return "bg-sky-500/10 text-sky-400";
	}

	const connectedCount = supervisors.filter(
		(supervisor) => supervisor.status === "connected",
	).length;
	const interactiveReadyCount = supervisors.filter(
		(supervisor) => supervisor.capabilities.interactiveTerminalControl?.available,
	).length;
	const revokedCount = supervisors.filter(
		(supervisor) => supervisor.enrollmentState === "revoked",
	).length;

	const viewState = deriveHostsViewState({ loading, loadError, supervisors });
	useNoteUnknownOwners(supervisors.map((supervisor) => supervisor.ownerUserId));
	useSecretLifetime(createdToken !== null, () => setCreatedToken(null));
	const ownerName = (id: string) =>
		ownerLabel(directory[id], id, { selfId: viewerUserId, style: "you" });
	const people = assignablePeople(Object.values(directory), viewerUserId);
	const enrollmentNote = enrollmentOwnershipNote(ui);

	return (
		<div className="p-3 md:p-6">
			<div className="max-w-6xl space-y-6">
				<div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
					<div>
						<h1 id="hosts-heading" className="text-xl md:text-2xl font-bold text-foreground">
							Hosts
						</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							Connected supervisors, their capabilities, and their trusted roots.
						</p>
					</div>
					<button
						type="button"
						onClick={() => loadSupervisors()}
						disabled={refreshing || loading}
						className="inline-flex h-9 items-center justify-center rounded-md border border-border px-3 text-sm text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
					>
						{refreshing ? "Refreshing..." : "Refresh"}
					</button>
				</div>

				<div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
					<div className="rounded-lg border border-border bg-card p-4 md:p-5">
						<div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
							<div>
								<h2 className="text-sm font-semibold text-foreground">Supervisor Enrollment</h2>
								<p className="mt-1 text-xs text-muted-foreground">
									Create a one-time token, start a host with it, then AgentPulse will issue a
									persistent scoped supervisor credential automatically.
								</p>
								{enrollmentNote && <p className="mt-1 text-xs text-hint">{enrollmentNote}</p>}
							</div>
						</div>

						<div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,1fr)_220px_auto]">
							<label className="space-y-1">
								<span className="text-xs text-muted-foreground">Token name</span>
								<input
									value={enrollName}
									onChange={(e) => setEnrollName(e.target.value)}
									placeholder="macbook-pro"
									className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
								/>
							</label>
							<label className="space-y-1">
								<span className="text-xs text-muted-foreground">Expires at</span>
								<input
									type="datetime-local"
									value={enrollExpiresAt}
									onChange={(e) => setEnrollExpiresAt(e.target.value)}
									className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
								/>
							</label>
							<div className="flex items-end">
								<button
									type="button"
									onClick={handleCreateEnrollmentToken}
									disabled={creatingToken}
									className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
								>
									{creatingToken ? "Creating..." : "Create token"}
								</button>
							</div>
						</div>

						{enrollError && (
							<p
								role="alert"
								className="mt-3 rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-300"
							>
								{enrollError}
							</p>
						)}

						{createdToken && (
							<div className="mt-4 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
								<div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
									<div>
										<div className="text-sm font-medium text-foreground">
											{createdToken.mode === "rotate"
												? `Re-enrollment token created${createdToken.hostName ? ` for ${createdToken.hostName}` : ""}`
												: "Enrollment token created"}
										</div>
										<div className="mt-1 text-xs text-muted-foreground">
											This is only shown once. Save it before closing this page.{" "}
											{SECRET_LIFETIME_NOTE}
										</div>
									</div>
									<button
										type="button"
										onClick={handleCopyToken}
										className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs text-foreground transition-colors hover:bg-accent"
									>
										Copy token
									</button>
								</div>
								<code className="mt-3 block break-all rounded-md bg-background px-3 py-2 text-xs text-foreground">
									{createdToken.token}
								</code>
								<div className="mt-3 space-y-1 text-xs text-muted-foreground">
									<div>
										Use with:{" "}
										<code className="text-foreground">
											AGENTPULSE_SUPERVISOR_ENROLLMENT_TOKEN={createdToken.token}
										</code>
									</div>
									<div>
										Then run: <code className="text-foreground">bun run supervisor</code>
									</div>
									{createdToken.mode === "rotate" && (
										<div>
											This token re-enrolls the existing host and replaces its scoped credential.
										</div>
									)}
									<div>
										Name: <span className="text-foreground">{createdToken.name}</span>
										{createdToken.expiresAt ? (
											<>
												{" "}
												· Expires <span className="text-foreground">{createdToken.expiresAt}</span>
											</>
										) : null}
									</div>
								</div>
							</div>
						)}
					</div>

					<div className="rounded-lg border border-border bg-card p-4 md:p-5">
						<h2 className="text-sm font-semibold text-foreground">How it works</h2>
						<div className="mt-3 space-y-3 text-xs text-muted-foreground">
							<p>1. Create a one-time enrollment token here.</p>
							<p>2. Start the supervisor on the target host with that token.</p>
							<p>3. The host registers and receives a persistent scoped credential.</p>
							<p>4. Revoke the host here if you need to stop future supervisor access.</p>
						</div>
					</div>
				</div>

				<div className="grid gap-3 md:grid-cols-3">
					<div className="rounded-lg border border-border bg-card px-4 py-3">
						<div className="text-[11px] uppercase tracking-wide text-muted-foreground">
							Connected
						</div>
						<div className="mt-1 text-2xl font-semibold text-foreground">{connectedCount}</div>
						<div className="mt-1 text-xs text-muted-foreground">Hosts currently heartbeating.</div>
					</div>
					<div className="rounded-lg border border-border bg-card px-4 py-3">
						<div className="text-[11px] uppercase tracking-wide text-muted-foreground">
							Interactive Ready
						</div>
						<div className="mt-1 text-2xl font-semibold text-foreground">
							{interactiveReadyCount}
						</div>
						<div className="mt-1 text-xs text-muted-foreground">
							Hosts that can hand prompts back into live terminals.
						</div>
					</div>
					<div className="rounded-lg border border-border bg-card px-4 py-3">
						<div className="text-[11px] uppercase tracking-wide text-muted-foreground">Revoked</div>
						<div className="mt-1 text-2xl font-semibold text-foreground">{revokedCount}</div>
						<div className="mt-1 text-xs text-muted-foreground">
							Hosts whose scoped credentials have been disabled.
						</div>
					</div>
				</div>

				{viewState.kind === "loading" ? (
					<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
						{Array.from({ length: 3 }).map((_, index) => (
							<div
								key={index}
								className="h-72 animate-pulse rounded-lg border border-border bg-card"
							/>
						))}
					</div>
				) : viewState.kind === "error" ? (
					<div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6">
						<div className="text-sm font-medium text-red-300">{viewState.message}</div>
						<div className="mt-2 max-w-2xl text-sm text-muted-foreground">
							This is different from "no hosts registered" — the request to list hosts itself
							failed, so any hosts that have actually registered may not be shown.
						</div>
						<button
							type="button"
							onClick={() => loadSupervisors()}
							disabled={refreshing}
							className="mt-4 inline-flex h-9 items-center justify-center rounded-md border border-red-500/30 px-3 text-sm text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{refreshing ? "Retrying..." : "Retry"}
						</button>
					</div>
				) : viewState.kind === "empty" ? (
					<div className="rounded-lg border border-dashed border-border p-6">
						<div className="text-sm font-medium text-foreground">No hosts are registered yet.</div>
						<div className="mt-2 max-w-2xl text-sm text-muted-foreground">
							Create an enrollment token above, then start a supervisor on the target machine with
							<code className="mx-1 rounded bg-background px-1.5 py-0.5 text-foreground">
								AGENTPULSE_SUPERVISOR_ENROLLMENT_TOKEN=&lt;token&gt; bun run supervisor
							</code>
							to attach it here.
						</div>
					</div>
				) : (
					<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
						{viewState.supervisors.map((supervisor) => {
							const access = deriveHostAccess(supervisor, {
								ui,
								viewerUserId,
								isAdmin,
								ownerName,
							});
							return (
								<div key={supervisor.id} className="rounded-lg border border-border bg-card p-4">
									<div className="flex items-start justify-between gap-3">
										<div>
											<div className="text-sm font-semibold text-foreground">
												{supervisor.hostName}
											</div>
											<div className="mt-1 text-[11px] text-muted-foreground">
												{supervisor.platform} · {supervisor.arch} · v{supervisor.version}
											</div>
										</div>
										<div className="flex flex-col items-end gap-2">
											<span
												className={`rounded-full px-2 py-1 text-[10px] font-medium ${statusClasses(supervisor.status)}`}
											>
												{supervisor.status}
											</span>
											<span
												className={`rounded-full px-2 py-1 text-[10px] font-medium ${enrollmentClasses(supervisor.enrollmentState)}`}
											>
												{supervisor.enrollmentState ?? "active"}
											</span>
										</div>
									</div>

									<div className="mt-4 space-y-3 text-xs">
										{access.ownerText !== null && (
											<div>
												<div className="text-hint">Owner</div>
												<div className="mt-1 flex flex-wrap items-center gap-2 text-foreground">
													<span>{access.ownerText}</span>
													{access.canChangeOwner && (
														<button
															type="button"
															onClick={() => setOwnerDialogHost(supervisor)}
															aria-label={`Change owner of ${supervisor.hostName}`}
															className="min-h-[44px] rounded-md px-2 text-xs font-medium text-primary underline underline-offset-2 hover:text-foreground md:min-h-0"
														>
															Change owner
														</button>
													)}
												</div>
											</div>
										)}
										<div>
											<div className="text-muted-foreground">Supervisor ID</div>
											<div className="mt-1 break-all text-foreground">{supervisor.id}</div>
										</div>
										<div>
											<div className="text-muted-foreground">Launch modes</div>
											<div className="mt-1 text-foreground">
												{supervisor.capabilities.launchModes.join(", ")}
											</div>
										</div>
										<div>
											<div className="text-muted-foreground">Agent types</div>
											<div className="mt-1 text-foreground">
												{supervisor.capabilities.agentTypes.join(", ")}
											</div>
										</div>
										<div>
											<div className="text-muted-foreground">Features</div>
											<div className="mt-1 text-foreground">
												{supervisor.capabilities.features.join(", ") || "None"}
											</div>
										</div>
										<div>
											<div className="text-muted-foreground">Executables</div>
											<div className="mt-1 text-foreground">
												<div className="break-all">
													Claude:{" "}
													{supervisor.capabilities.executables?.claude?.resolvedPath ? (
														<>
															{supervisor.capabilities.executables.claude.resolvedPath}{" "}
															<span className="text-muted-foreground">
																(
																{supervisor.capabilities.executables.claude.binaryVersion ||
																	"version unknown"}
																)
															</span>
														</>
													) : (
														"Unavailable"
													)}
												</div>
												<div className="break-all">
													Codex:{" "}
													{supervisor.capabilities.executables?.codex?.resolvedPath ? (
														<>
															{supervisor.capabilities.executables.codex.resolvedPath}{" "}
															<span className="text-muted-foreground">
																(
																{supervisor.capabilities.executables.codex.binaryVersion ||
																	"version unknown"}
																)
															</span>
														</>
													) : (
														"Unavailable"
													)}
												</div>
											</div>
										</div>
										<div>
											<div className="text-muted-foreground">Interactive control</div>
											<div className="mt-1 text-foreground">
												<div>
													{supervisor.capabilities.interactiveTerminalControl?.available
														? "Ready"
														: "Launch-only"}
												</div>
												{supervisor.capabilities.interactiveTerminalControl?.reason && (
													<div className="mt-1 text-[11px] text-amber-300">
														{supervisor.capabilities.interactiveTerminalControl.reason}
													</div>
												)}
											</div>
										</div>
										<div>
											<div className="text-muted-foreground">Trusted roots</div>
											<div className="mt-1 break-all text-foreground">
												{supervisor.trustedRoots.join(", ") || "None"}
											</div>
										</div>
										<div>
											<div className="text-muted-foreground">Last heartbeat</div>
											<div className="mt-1 text-foreground">{supervisor.lastHeartbeatAt}</div>
										</div>
									</div>

									<div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
										<div className="text-[11px] text-muted-foreground">
											{supervisor.enrollmentState === "revoked"
												? "Supervisor access revoked"
												: "Scoped credential active"}
										</div>
										<div className="flex items-center gap-2">
											<button
												type="button"
												onClick={() => {
													setActionError(null);
													setPendingAction({ kind: "rotate", supervisor });
												}}
												disabled={supervisor.enrollmentState === "revoked" || !access.canManage}
												aria-describedby={
													access.manageReason ? `host-reason-${supervisor.id}` : undefined
												}
												className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
											>
												Rotate
											</button>
											<button
												type="button"
												onClick={() => {
													setActionError(null);
													setPendingAction({ kind: "revoke", supervisor });
												}}
												disabled={supervisor.enrollmentState === "revoked" || !access.canManage}
												aria-describedby={
													access.manageReason ? `host-reason-${supervisor.id}` : undefined
												}
												className="inline-flex h-8 items-center justify-center rounded-md border border-red-500/30 px-3 text-xs text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
											>
												Revoke
											</button>
										</div>
									</div>
									{access.manageReason && (
										<div
											id={`host-reason-${supervisor.id}`}
											className="mt-2 space-y-0.5 text-xs text-hint"
										>
											<p>{access.manageReason}</p>
											{access.launchNote && <p>{access.launchNote}</p>}
										</div>
									)}
								</div>
							);
						})}
					</div>
				)}
				{pendingAction &&
					(() => {
						const copy = hostActionConfirm(pendingAction.kind, pendingAction.supervisor.hostName);
						return (
							<ConfirmDialog
								title={copy.title}
								confirmLabel={copy.confirmLabel}
								destructive={pendingAction.kind === "revoke"}
								focusCancel
								busy={actionBusy}
								error={actionError}
								fallbackFocusId="hosts-heading"
								onConfirm={() => void runPendingAction()}
								onCancel={() => setPendingAction(null)}
							>
								<p>{copy.body}</p>
							</ConfirmDialog>
						);
					})()}
				{ownerDialogHost && (
					<HostOwnerDialog
						host={ownerDialogHost}
						people={people}
						onClose={() => setOwnerDialogHost(null)}
						onChanged={() => {
							setOwnerDialogHost(null);
							void loadSupervisors();
						}}
					/>
				)}
			</div>
		</div>
	);
}
