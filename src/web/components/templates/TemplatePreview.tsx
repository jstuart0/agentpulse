import type { LaunchRequest, SupervisorRecord, TemplatePreview } from "../../../shared/types.js";
import { RecentLaunchesPanel } from "./RecentLaunchesPanel.js";

export function TemplatePreviewPanel({
	preview,
	previewError,
	connectedSupervisor,
	selectedSupervisor,
	effectiveLaunchSpec,
	recentLaunches,
}: {
	preview: TemplatePreview | null;
	previewError: string;
	connectedSupervisor: SupervisorRecord | undefined;
	selectedSupervisor: SupervisorRecord | null;
	effectiveLaunchSpec: Record<string, unknown> | null;
	recentLaunches: LaunchRequest[];
}) {
	return (
		<section className="rounded-lg border border-border bg-card p-4 space-y-4">
			<div>
				<h2 className="text-sm font-semibold text-foreground">Launch Preview</h2>
				<p className="text-xs text-muted-foreground mt-1">
					This is the normalized launch contract AgentPulse hands to the supervisor. The preview
					itself does not start anything.
				</p>
			</div>

			<div className="rounded-md border border-border bg-background/60 p-3 text-xs">
				<div className="font-medium text-foreground">
					{connectedSupervisor
						? `Validated against ${selectedSupervisor?.hostName ?? connectedSupervisor.hostName}`
						: "No connected supervisor"}
				</div>
				<div className="mt-1 text-muted-foreground">
					{selectedSupervisor
						? `Trusted roots: ${selectedSupervisor.trustedRoots.join(", ") || "none"}`
						: "Start the local supervisor before creating launch requests."}
				</div>
			</div>

			{previewError ? (
				<div className="rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-300">
					{previewError}
				</div>
			) : preview ? (
				<div className="space-y-4">
					<div className="rounded-md border border-border bg-background/60 p-3">
						<div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
							Recommended command
						</div>
						<code className="block whitespace-pre-wrap break-all text-xs text-foreground">
							{preview.launchSpec.agentType === "claude_code"
								? preview.guidance.claudeCode.command
								: preview.guidance.codexCli.command}
						</code>
					</div>

					<div className="grid gap-3">
						{[preview.guidance.claudeCode, preview.guidance.codexCli].map((item) => (
							<div key={item.label} className="rounded-md border border-border p-3">
								<div className="flex items-center justify-between gap-2">
									<div className="text-sm font-medium text-foreground">{item.label}</div>
									{item.recommended && (
										<span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
											Recommended
										</span>
									)}
								</div>
								<code className="mt-2 block whitespace-pre-wrap break-all text-xs text-foreground">
									{item.command}
								</code>
								<ul className="mt-2 space-y-1 text-xs text-muted-foreground">
									{item.notes.map((note) => (
										<li key={note}>- {note}</li>
									))}
								</ul>
							</div>
						))}
					</div>

					{preview.warnings.length > 0 && (
						<div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
							<div className="text-xs uppercase tracking-wide text-amber-400 mb-2">Warnings</div>
							<ul className="space-y-1 text-xs text-amber-200">
								{preview.warnings.map((warning) => (
									<li key={warning}>- {warning}</li>
								))}
							</ul>
						</div>
					)}

					<div className="rounded-md border border-border bg-background/60 p-3">
						<div className="flex items-center justify-between gap-3 mb-2">
							<div className="text-xs uppercase tracking-wide text-muted-foreground">
								Normalized launch spec JSON
							</div>
							<button
								onClick={() =>
									navigator.clipboard.writeText(JSON.stringify(effectiveLaunchSpec, null, 2))
								}
								className="rounded-md bg-muted px-2.5 py-1 text-[11px] text-foreground hover:bg-accent transition-colors"
							>
								Copy JSON
							</button>
						</div>
						<pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-foreground">
							{JSON.stringify(effectiveLaunchSpec, null, 2)}
						</pre>
					</div>

					<RecentLaunchesPanel recentLaunches={recentLaunches} />
				</div>
			) : (
				<div className="text-sm text-muted-foreground">
					Preview will appear as you edit the template.
				</div>
			)}
		</section>
	);
}
