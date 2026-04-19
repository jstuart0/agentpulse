import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { format } from "date-fns";
import type { LaunchMode, LaunchRequest, LaunchRequestStatus, Session } from "../../shared/types.js";
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

const launchModeLabels: Record<LaunchMode, string> = {
	headless: "Headless task",
	interactive_terminal: "Interactive terminal",
	managed_codex: "Managed Codex",
};

const activeStatuses = new Set<LaunchRequestStatus>([
	"validated",
	"queued",
	"launching",
	"awaiting_session",
	"running",
]);

function formatActivityKind(value: string) {
	return value.replace(/_/g, " ");
}

export function LaunchDetailPage() {
	const { launchId } = useParams<{ launchId: string }>();
	const navigate = useNavigate();
	const [launch, setLaunch] = useState<LaunchRequest | null>(null);
	const [linkedSession, setLinkedSession] = useState<Session | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);

	useEffect(() => {
		if (!launchId) return;
		async function load() {
			try {
				const data = (await api.getLaunch(launchId!)) as {
					launchRequest: LaunchRequest;
					session?: Session | null;
				};
				setLaunch(data.launchRequest);
				setLinkedSession((data.session as Session | null) ?? null);
			} catch (error) {
				console.error("Failed to load launch request", error);
			} finally {
				setLoading(false);
			}
		}
		load();
	}, [launchId]);

	useEffect(() => {
		if (!launchId || !launch || !activeStatuses.has(launch.status)) return;
		const interval = setInterval(async () => {
			try {
				setRefreshing(true);
				const data = (await api.getLaunch(launchId)) as {
					launchRequest: LaunchRequest;
					session?: Session | null;
				};
				setLaunch(data.launchRequest);
				setLinkedSession((data.session as Session | null) ?? null);
			} catch (error) {
				console.error("Failed to refresh launch request", error);
			} finally {
				setRefreshing(false);
			}
		}, 1500);
		return () => clearInterval(interval);
	}, [launchId, launch]);

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

	const providerMetadata = launch.providerLaunchMetadata ?? null;
	const headlessOutput =
		providerMetadata &&
		typeof providerMetadata === "object" &&
		typeof providerMetadata.mode === "string" &&
		providerMetadata.mode === "headless"
			? ((providerMetadata.output as {
					assistantPreview?: string;
					stderrPreview?: string;
					rawEventCount?: number;
					activity?: Array<{ kind: string; text: string; timestamp: string }>;
			  }) ?? null)
			: null;
	const nextStepMessage =
		launch.requestedLaunchMode === "headless"
			? linkedSession
				? "The workspace is live. Watch Activity for streamed output and send follow-up prompts from the session workspace."
				: "Waiting for the session workspace to attach. Headless output will continue streaming here."
			: launch.requestedLaunchMode === "interactive_terminal"
				? linkedSession
					? "The host terminal owns control. AgentPulse mirrors the session and links you into the workspace for observability."
					: "The terminal session launched on the host. Waiting for the linked workspace to attach."
				: linkedSession
					? "Managed Codex control is active. Open the workspace to observe the session and its thread sync state."
					: "Managed Codex is launching. Waiting for the linked workspace to attach.";

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
							{launch.agentType === "claude_code" ? "Claude Code" : "Codex CLI"} · {launchModeLabels[launch.requestedLaunchMode]}
						</p>
					</div>
					<div className="flex items-center gap-2">
						{activeStatuses.has(launch.status) && (
							<span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10px] font-medium text-amber-300">
								{refreshing ? "Refreshing…" : "Live"}
							</span>
						)}
						<div className="rounded-full border border-border px-3 py-1 text-xs font-medium text-foreground">
							{launch.status}
						</div>
					</div>
				</div>

				<div className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
					<div className="text-sm font-medium text-foreground">What happens next</div>
					<div className="mt-1 text-sm text-muted-foreground">{nextStepMessage}</div>
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
						{providerMetadata && typeof providerMetadata.executionState === "string" && (
							<KeyValue label="Execution state" value={String(providerMetadata.executionState)} />
						)}
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

				<div className="rounded-lg border border-border bg-card p-4">
					<div className="flex flex-wrap items-start justify-between gap-3">
						<div>
							<div className="text-sm font-semibold text-foreground">Session workspace</div>
							<div className="mt-1 text-xs text-muted-foreground">
								{launch.requestedLaunchMode === "headless"
									? "Headless launches stream progress here and into the linked session timeline."
									: "Interactive launches open on the selected host terminal and mirror into the linked session as observability data arrives."}
							</div>
						</div>
						{linkedSession ? (
							<Link
								to={`/sessions/${linkedSession.sessionId}?tab=launch`}
								className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent transition-colors"
							>
								Open workspace
							</Link>
						) : null}
					</div>
						<div className="mt-3 rounded-md bg-background/60 p-3 text-xs">
						{linkedSession ? (
							<div className="space-y-1.5">
								<div className="font-medium text-foreground">
									{linkedSession.displayName || linkedSession.sessionId.slice(0, 8)}
								</div>
								<div className="text-muted-foreground">
									{linkedSession.status} · {linkedSession.cwd || "No working directory"}
								</div>
								{launch.requestedLaunchMode === "interactive_terminal" && (
									<div className="text-muted-foreground">
										Control this session in the opened host terminal. AgentPulse is the observability surface for it.
									</div>
								)}
							</div>
						) : (
							<div className="text-muted-foreground">
								Waiting for the linked session workspace to materialize.
							</div>
						)}
					</div>
				</div>

				{headlessOutput && (
					<div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
						<div className="rounded-lg border border-border bg-card p-4">
							<div className="flex items-center justify-between gap-3">
								<div>
									<div className="text-sm font-semibold text-foreground">Headless output</div>
									<div className="mt-1 text-xs text-muted-foreground">
										Visible Claude output captured from the running task.
									</div>
								</div>
								{typeof headlessOutput.rawEventCount === "number" && (
									<div className="text-xs text-muted-foreground">
										{headlessOutput.rawEventCount} stream events
									</div>
								)}
							</div>
							<pre className="mt-3 min-h-40 overflow-x-auto rounded-md bg-background/60 p-3 text-xs text-foreground whitespace-pre-wrap break-words">
								{headlessOutput.assistantPreview?.trim() || "Waiting for visible Claude output…"}
							</pre>
							{headlessOutput.stderrPreview?.trim() && (
								<div className="mt-4">
									<div className="text-xs text-red-300">stderr</div>
									<pre className="mt-2 overflow-x-auto rounded-md bg-red-500/5 p-3 text-xs text-red-200 whitespace-pre-wrap break-words">
										{headlessOutput.stderrPreview}
									</pre>
								</div>
							)}
						</div>

						<div className="rounded-lg border border-border bg-card p-4">
							<div className="text-sm font-semibold text-foreground">Activity stream</div>
							<div className="mt-3 space-y-2">
								{headlessOutput.activity?.length ? (
									headlessOutput.activity.map((entry, index) => (
										<div key={`${entry.timestamp}-${index}`} className="rounded-md bg-background/60 p-3">
											<div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
												<span>{formatActivityKind(entry.kind)}</span>
												<span>{formatDateTime(entry.timestamp)}</span>
											</div>
											<div className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground">
												{entry.text}
											</div>
										</div>
									))
								) : (
									<div className="text-sm text-muted-foreground">No activity captured yet.</div>
								)}
							</div>
						</div>
					</div>
				)}

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
