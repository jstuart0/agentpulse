import { useEffect, useState } from "react";
import type { SupervisorRecord } from "../../shared/types.js";
import { api } from "../lib/api.js";

export function HostsPage() {
	const [supervisors, setSupervisors] = useState<SupervisorRecord[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		async function load() {
			try {
				const result = (await api.getSupervisors()) as { supervisors: SupervisorRecord[] };
				setSupervisors(result.supervisors ?? []);
			} finally {
				setLoading(false);
			}
		}
		load();
	}, []);

	return (
		<div className="p-3 md:p-6">
			<div className="max-w-6xl space-y-6">
				<div>
					<h1 className="text-xl md:text-2xl font-bold text-foreground">Hosts</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						Connected supervisors, their capabilities, and their trusted roots.
					</p>
				</div>

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
								<div className="flex items-center justify-between gap-3">
									<div>
										<div className="text-sm font-semibold text-foreground">
											{supervisor.hostName}
										</div>
										<div className="mt-1 text-[11px] text-muted-foreground">
											{supervisor.platform} · {supervisor.arch} · v{supervisor.version}
										</div>
									</div>
									<span
										className={`rounded-full px-2 py-1 text-[10px] font-medium ${
											supervisor.status === "connected"
												? "bg-emerald-500/10 text-emerald-400"
												: supervisor.status === "stale"
													? "bg-amber-500/10 text-amber-400"
													: "bg-red-500/10 text-red-400"
										}`}
									>
										{supervisor.status}
									</span>
								</div>

								<div className="mt-4 space-y-3 text-xs">
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
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
