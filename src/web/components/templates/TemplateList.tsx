import type { SessionTemplate } from "../../../shared/types.js";
import type { AgentFilter } from "./utils.js";

/**
 * Left-rail template list + agent-type filter chips. Pure presentation
 * around callbacks from the parent page.
 */
export function TemplateListPanel({
	loading,
	templates,
	agentFilter,
	selectedId,
	onFilterChange,
	onSelectTemplate,
}: {
	loading: boolean;
	templates: SessionTemplate[];
	agentFilter: AgentFilter;
	selectedId: string | null;
	onFilterChange: (value: AgentFilter) => void;
	onSelectTemplate: (template: SessionTemplate) => void;
}) {
	return (
		<section className="rounded-lg border border-border bg-card p-4 space-y-4">
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-sm font-semibold text-foreground">Templates</h2>
				<div className="flex gap-1 overflow-x-auto">
					{(["all", "claude_code", "codex_cli"] as AgentFilter[]).map((value) => (
						<button
							key={value}
							type="button"
							onClick={() => onFilterChange(value)}
							className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
								agentFilter === value
									? "bg-primary text-primary-foreground"
									: "bg-muted text-muted-foreground hover:text-foreground"
							}`}
						>
							{value === "all" ? "All" : value === "claude_code" ? "Claude" : "Codex"}
						</button>
					))}
				</div>
			</div>

			<div className="space-y-2">
				{loading ? (
					<div className="text-sm text-muted-foreground">Loading templates...</div>
				) : templates.length === 0 ? (
					<div className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
						No templates yet. Save one from the editor to start building reusable session setups.
					</div>
				) : (
					templates.map((template) => (
						<button
							key={template.id}
							type="button"
							onClick={() => onSelectTemplate(template)}
							className={`w-full rounded-md border p-3 text-left transition-colors ${
								selectedId === template.id
									? "border-primary bg-primary/5"
									: "border-border hover:bg-accent"
							}`}
						>
							<div className="flex items-center justify-between gap-2">
								<div className="min-w-0">
									<div className="truncate text-sm font-medium text-foreground">
										{template.name}
									</div>
									<div className="mt-1 text-[11px] text-muted-foreground">
										{template.agentType === "claude_code" ? "Claude Code" : "Codex CLI"}
									</div>
								</div>
								{template.isFavorite && (
									<span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-400">
										Favorite
									</span>
								)}
							</div>
							<div className="mt-2 truncate text-[11px] text-muted-foreground">{template.cwd}</div>
						</button>
					))
				)}
			</div>
		</section>
	);
}
