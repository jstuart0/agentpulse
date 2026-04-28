import type { Project } from "../../../shared/types.js";

interface ProjectCardProps {
	project: Project;
	sessionCount?: number;
	onEdit: (project: Project) => void;
	onDelete: (project: Project) => void;
	onCleanupWorkarea?: (project: Project) => void;
}

export function ProjectCard({
	project,
	sessionCount,
	onEdit,
	onDelete,
	onCleanupWorkarea,
}: ProjectCardProps) {
	const tags = project.tags ?? [];
	const isScratch = tags.includes("scratch");
	const isAiInitiated = tags.includes("ai-initiated");
	const canCleanup = isScratch && isAiInitiated && Boolean(onCleanupWorkarea);
	return (
		<div
			className={`rounded-lg border bg-card p-4 flex flex-col gap-3 ${
				isScratch ? "border-dashed border-amber-500/30" : "border-border"
			}`}
		>
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2 flex-wrap">
						<h3 className="text-sm font-semibold text-foreground truncate">{project.name}</h3>
						{project.isFavorite && (
							<span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-medium">
								Favorite
							</span>
						)}
						{isScratch && (
							<span className="text-[10px] px-1.5 py-0.5 rounded text-amber-300 bg-amber-500/10 border border-amber-500/20 font-medium">
								scratch
							</span>
						)}
					</div>
					<p className="text-xs text-muted-foreground mt-0.5 truncate" title={project.cwd}>
						{project.cwd}
					</p>
				</div>
				<div className="flex items-center gap-1 flex-shrink-0">
					{canCleanup && (
						<button
							type="button"
							onClick={() => onCleanupWorkarea?.(project)}
							className="text-muted-foreground hover:text-amber-300 p-1.5 rounded hover:bg-amber-500/10 transition-colors"
							title="Clean up scratch workspace (rm -rf the directory)"
						>
							<svg
								className="w-3.5 h-3.5"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
								strokeWidth={1.5}
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									d="M3 6h18M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2m2 0v14a2 2 0 01-2 2H8a2 2 0 01-2-2V6h12z"
								/>
							</svg>
						</button>
					)}
					<button
						type="button"
						onClick={() => onEdit(project)}
						className="text-muted-foreground hover:text-foreground p-1.5 rounded hover:bg-accent/50 transition-colors"
						title="Edit project"
					>
						<svg
							className="w-3.5 h-3.5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							strokeWidth={1.5}
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"
							/>
						</svg>
					</button>
					<button
						type="button"
						onClick={() => onDelete(project)}
						className="text-muted-foreground hover:text-red-400 p-1.5 rounded hover:bg-red-500/10 transition-colors"
						title="Delete project"
					>
						<svg
							className="w-3.5 h-3.5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							strokeWidth={1.5}
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0"
							/>
						</svg>
					</button>
				</div>
			</div>

			<div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
				{sessionCount !== undefined && (
					<span className="flex items-center gap-1">
						<svg
							className="w-3.5 h-3.5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							strokeWidth={1.5}
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								d="M4 6h16M4 10h16M4 14h16M4 18h16"
							/>
						</svg>
						{sessionCount} session{sessionCount !== 1 ? "s" : ""}
					</span>
				)}
				{project.defaultAgentType && (
					<span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary/80 font-mono text-[10px]">
						{project.defaultAgentType === "claude_code" ? "Claude" : "Codex"}
					</span>
				)}
				{project.githubRepoUrl && (
					<a
						href={project.githubRepoUrl}
						target="_blank"
						rel="noreferrer"
						className="flex items-center gap-1 hover:text-foreground transition-colors"
						onClick={(e) => e.stopPropagation()}
					>
						<svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
							<path
								fillRule="evenodd"
								d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
								clipRule="evenodd"
							/>
						</svg>
						GitHub
					</a>
				)}
			</div>

			{project.notes && (
				<p className="text-xs text-muted-foreground line-clamp-2">{project.notes}</p>
			)}
		</div>
	);
}
