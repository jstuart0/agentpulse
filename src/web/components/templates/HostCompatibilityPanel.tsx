import type {
	AgentType,
	SupervisorRecord,
	TemplateHostCompatibility,
} from "../../../shared/types.js";

/**
 * Renders the backend-computed host-compatibility list. Does not
 * compute any rules — those live in the backend template-preview
 * service and are surfaced here via TemplateHostCompatibility rows.
 * Enforces the WS6 validation-unification boundary visually.
 */
export function HostCompatibilityPanel({
	compatibleHosts,
	agentType,
}: {
	compatibleHosts: Array<{
		supervisor: SupervisorRecord;
		compatibility: TemplateHostCompatibility;
	}>;
	agentType: AgentType;
}) {
	return (
		<div className="rounded-md border border-border bg-background/40 p-3">
			<div className="text-xs font-medium text-foreground">Host compatibility</div>
			<div className="mt-2 space-y-2">
				{compatibleHosts.map(({ supervisor, compatibility }) => (
					<div key={supervisor.id} className="rounded-md border border-border/70 px-3 py-2 text-xs">
						<div className="flex items-center justify-between gap-2">
							<span className="font-medium text-foreground">{supervisor.hostName}</span>
							<span
								className={
									compatibility.ok
										? "rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-400"
										: "rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] text-red-400"
								}
							>
								{compatibility.ok ? "compatible" : "blocked"}
							</span>
						</div>
						<div className="mt-1 text-muted-foreground">
							{supervisor.status} · {supervisor.platform} · {supervisor.arch}
						</div>
						<div className="mt-1 text-muted-foreground">
							{agentType === "claude_code"
								? `Claude: ${supervisor.capabilities.executables?.claude?.resolvedPath || "Unavailable"}`
								: `Codex: ${supervisor.capabilities.executables?.codex?.resolvedPath || "Unavailable"}`}
						</div>
						{compatibility.errors.length > 0 && (
							<div className="mt-2 space-y-1 text-red-300">
								{compatibility.errors.map((error) => (
									<div key={error}>{error}</div>
								))}
							</div>
						)}
						{compatibility.errors.length === 0 && compatibility.warnings.length > 0 && (
							<div className="mt-2 space-y-1 text-amber-300">
								{compatibility.warnings.map((warning) => (
									<div key={warning}>{warning}</div>
								))}
							</div>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
