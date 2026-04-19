import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { format } from "date-fns";
import type { LaunchRequest } from "../../shared/types.js";
import { api } from "../lib/api.js";

function formatDateTime(value: string | null | undefined) {
	if (!value) return null;
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return format(date, "MMM d, yyyy h:mm:ss a");
}

function KeyValue({
	label,
	value,
	mono = false,
}: {
	label: string;
	value: string | null | undefined;
	mono?: boolean;
}) {
	if (!value) return null;
	return (
		<div>
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className={mono ? "mt-1 break-all font-mono text-xs text-foreground" : "mt-1 text-sm text-foreground"}>
				{value}
			</div>
		</div>
	);
}

export function LaunchDetailPage() {
	const { launchId } = useParams<{ launchId: string }>();
	const navigate = useNavigate();
	const [launch, setLaunch] = useState<LaunchRequest | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!launchId) return;
		async function load() {
			try {
				const data = (await api.getLaunch(launchId!)) as { launchRequest: LaunchRequest };
				setLaunch(data.launchRequest);
			} catch (error) {
				console.error("Failed to load launch request", error);
			} finally {
				setLoading(false);
			}
		}
		load();
	}, [launchId]);

	if (loading) {
		return <div className="p-6 text-sm text-muted-foreground">Loading launch request...</div>;
	}

	if (!launch) {
		return (
			<div className="p-6">
				<div className="text-sm text-muted-foreground">Launch request not found.</div>
				<button onClick={() => navigate("/templates")} className="mt-3 text-sm text-primary hover:underline">
					Back to templates
				</button>
			</div>
		);
	}

	return (
		<div className="p-3 md:p-6">
			<div className="mx-auto max-w-5xl space-y-6">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div>
						<button onClick={() => navigate(-1)} className="text-sm text-muted-foreground hover:text-foreground">
							← Back
						</button>
						<h1 className="mt-2 text-xl font-bold text-foreground">Launch Request</h1>
						<p className="mt-1 text-sm text-muted-foreground">
							{launch.agentType === "claude_code" ? "Claude Code" : "Codex CLI"} · {launch.requestedLaunchMode}
						</p>
					</div>
					<div className="rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground">
						{launch.status}
					</div>
				</div>

				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
					<div className="rounded-lg border border-border bg-card p-4 space-y-3">
						<div className="text-sm font-semibold text-foreground">Summary</div>
						<KeyValue label="Created" value={formatDateTime(launch.createdAt)} />
						<KeyValue label="Updated" value={formatDateTime(launch.updatedAt)} />
						<KeyValue label="Working directory" value={launch.cwd} mono />
						<KeyValue label="Resolved host" value={launch.resolvedSupervisorId} mono />
						<KeyValue label="Requested host" value={launch.requestedSupervisorId} mono />
						<KeyValue label="Launch correlation id" value={launch.launchCorrelationId} mono />
					</div>

					<div className="rounded-lg border border-border bg-card p-4 space-y-3">
						<div className="text-sm font-semibold text-foreground">Dispatch</div>
						<KeyValue label="Started" value={formatDateTime(launch.dispatchStartedAt)} />
						<KeyValue label="Finished" value={formatDateTime(launch.dispatchFinishedAt)} />
						<KeyValue label="Awaiting session deadline" value={formatDateTime(launch.awaitingSessionDeadlineAt)} />
						<KeyValue label="Claimed by supervisor" value={launch.claimedBySupervisorId} mono />
						<KeyValue label="PID" value={launch.pid != null ? String(launch.pid) : null} mono />
						{launch.error && (
							<div>
								<div className="text-xs text-red-300">Error</div>
								<div className="mt-1 text-sm text-red-200">{launch.error}</div>
							</div>
						)}
					</div>

					<div className="rounded-lg border border-border bg-card p-4 space-y-3">
						<div className="text-sm font-semibold text-foreground">Validation</div>
						{launch.validationSummary && <KeyValue label="Summary" value={launch.validationSummary} />}
						{launch.validationWarnings.length > 0 ? (
							<div>
								<div className="text-xs text-amber-300">Warnings</div>
								<ul className="mt-1 space-y-1 text-sm text-amber-200">
									{launch.validationWarnings.map((warning) => (
										<li key={warning}>• {warning}</li>
									))}
								</ul>
							</div>
						) : (
							<div className="text-sm text-muted-foreground">No validation warnings.</div>
						)}
					</div>
				</div>

				{launch.providerLaunchMetadata && (
					<div className="rounded-lg border border-border bg-card p-4">
						<div className="text-sm font-semibold text-foreground">Provider launch metadata</div>
						<pre className="mt-3 overflow-x-auto rounded-md bg-background/60 p-3 text-xs text-foreground">
							{JSON.stringify(launch.providerLaunchMetadata, null, 2)}
						</pre>
					</div>
				)}

				<div className="rounded-lg border border-border bg-card p-4">
					<div className="text-sm font-semibold text-foreground">Launch spec</div>
					<pre className="mt-3 overflow-x-auto rounded-md bg-background/60 p-3 text-xs text-foreground">
						{JSON.stringify(launch.launchSpec, null, 2)}
					</pre>
				</div>
			</div>
		</div>
	);
}
