import { useEffect, useState } from "react";
import type { SupervisorRecord } from "../../shared/types.js";
import { api } from "../lib/api.js";

export function HostsPage() {
	const [supervisors, setSupervisors] = useState<SupervisorRecord[]>([]);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [enrollName, setEnrollName] = useState("");
	const [enrollExpiresAt, setEnrollExpiresAt] = useState("");
	const [creatingToken, setCreatingToken] = useState(false);
	const [revokingId, setRevokingId] = useState<string | null>(null);
	const [rotatingId, setRotatingId] = useState<string | null>(null);
	const [error, setError] = useState("");
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
			setError("");
			const result = (await api.getSupervisors()) as { supervisors: SupervisorRecord[] };
			setSupervisors(result.supervisors ?? []);
		} catch (err) {
			console.error("Failed to load supervisors:", err);
			setError("Failed to load hosts.");
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	}

	useEffect(() => {
		loadSupervisors(true);
	}, []);

	async function handleCreateEnrollmentToken() {
		setCreatingToken(true);
		setError("");
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
			setError("Failed to create enrollment token.");
		} finally {
			setCreatingToken(false);
		}
	}

	async function handleCopyToken() {
		if (!createdToken?.token) return;
		try {
			await navigator.clipboard.writeText(createdToken.token);
		} catch (err) {
			console.error("Failed to copy token:", err);
			setError("Failed to copy token to clipboard.");
		}
	}

	async function handleRevokeSupervisor(id: string) {
		setRevokingId(id);
		setError("");
		try {
			await api.revokeSupervisor(id);
			await loadSupervisors();
		} catch (err) {
			console.error("Failed to revoke supervisor:", err);
			setError("Failed to revoke host.");
		} finally {
			setRevokingId(null);
		}
	}

	async function handleRotateSupervisor(supervisor: SupervisorRecord) {
		setRotatingId(supervisor.id);
		setError("");
		try {
			const result = await api.rotateSupervisor(supervisor.id, {});
			setCreatedToken({
				token: result.token,
				name: result.info.name,
				expiresAt: result.info.expiresAt,
				mode: "rotate",
				hostName: supervisor.hostName,
			});
		} catch (err) {
			console.error("Failed to rotate supervisor credential:", err);
			setError("Failed to create re-enrollment token.");
		} finally {
			setRotatingId(null);
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

	return (
		<div className="p-3 md:p-6">
			<div className="max-w-6xl space-y-6">
				<div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
					<div>
						<h1 className="text-xl md:text-2xl font-bold text-foreground">Hosts</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							Connected supervisors, their capabilities, and their trusted roots.
						</p>
					</div>
					<button
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
									onClick={handleCreateEnrollmentToken}
									disabled={creatingToken}
									className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
								>
									{creatingToken ? "Creating..." : "Create token"}
								</button>
							</div>
						</div>

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
											This is only shown once. Save it before closing this page.
										</div>
									</div>
									<button
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
										Use with:
										{" "}
										<code className="text-foreground">
											AGENTPULSE_SUPERVISOR_ENROLLMENT_TOKEN={createdToken.token}
										</code>
									</div>
									<div>
										Then run:
										{" "}
										<code className="text-foreground">bun run supervisor</code>
									</div>
									{createdToken.mode === "rotate" && (
										<div>
											This token re-enrolls the existing host and replaces its scoped credential.
										</div>
									)}
									<div>
										Name:
										{" "}
										<span className="text-foreground">{createdToken.name}</span>
										{createdToken.expiresAt ? (
											<>
												{" "}
												· Expires
												{" "}
												<span className="text-foreground">{createdToken.expiresAt}</span>
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

				{error && (
					<div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-300">
						{error}
					</div>
				)}

				{loading ? (
					<div className="text-sm text-muted-foreground">Loading hosts...</div>
				) : supervisors.length === 0 ? (
					<div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
						No supervisors are registered.
					</div>
				) : (
					<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
						{supervisors.map((supervisor) => (
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
										<span className={`rounded-full px-2 py-1 text-[10px] font-medium ${statusClasses(supervisor.status)}`}>
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
											onClick={() => handleRotateSupervisor(supervisor)}
											disabled={supervisor.enrollmentState === "revoked" || rotatingId === supervisor.id}
											className="inline-flex h-8 items-center justify-center rounded-md border border-border px-3 text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
										>
											{rotatingId === supervisor.id ? "Rotating..." : "Rotate"}
										</button>
										<button
											onClick={() => handleRevokeSupervisor(supervisor.id)}
											disabled={supervisor.enrollmentState === "revoked" || revokingId === supervisor.id}
											className="inline-flex h-8 items-center justify-center rounded-md border border-red-500/30 px-3 text-xs text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
										>
											{revokingId === supervisor.id ? "Revoking..." : "Revoke"}
										</button>
									</div>
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
