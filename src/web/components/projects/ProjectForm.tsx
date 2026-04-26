import { useEffect, useState } from "react";
import type { AgentType, LaunchMode, Project, ProjectInput } from "../../../shared/types.js";

interface ProjectFormProps {
	initial?: Project | null;
	onSave: (input: ProjectInput) => Promise<void>;
	onCancel: () => void;
	saving: boolean;
	error: string;
}

export function ProjectForm({ initial, onSave, onCancel, saving, error }: ProjectFormProps) {
	const [name, setName] = useState(initial?.name ?? "");
	const [cwd, setCwd] = useState(initial?.cwd ?? "");
	const [githubRepoUrl, setGithubRepoUrl] = useState(initial?.githubRepoUrl ?? "");
	const [defaultAgentType, setDefaultAgentType] = useState<AgentType | "">(
		initial?.defaultAgentType ?? "",
	);
	const [defaultModel, setDefaultModel] = useState(initial?.defaultModel ?? "");
	const [defaultLaunchMode, setDefaultLaunchMode] = useState<LaunchMode | "">(
		initial?.defaultLaunchMode ?? "",
	);
	const [notes, setNotes] = useState(initial?.notes ?? "");
	const [isFavorite, setIsFavorite] = useState(initial?.isFavorite ?? false);

	useEffect(() => {
		setName(initial?.name ?? "");
		setCwd(initial?.cwd ?? "");
		setGithubRepoUrl(initial?.githubRepoUrl ?? "");
		setDefaultAgentType(initial?.defaultAgentType ?? "");
		setDefaultModel(initial?.defaultModel ?? "");
		setDefaultLaunchMode(initial?.defaultLaunchMode ?? "");
		setNotes(initial?.notes ?? "");
		setIsFavorite(initial?.isFavorite ?? false);
	}, [initial]);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		await onSave({
			name: name.trim(),
			cwd: cwd.trim(),
			githubRepoUrl: githubRepoUrl.trim() || null,
			defaultAgentType: defaultAgentType || null,
			defaultModel: defaultModel.trim() || null,
			defaultLaunchMode: defaultLaunchMode || null,
			notes: notes.trim() || null,
			isFavorite,
		});
	}

	const fieldClass =
		"w-full rounded border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50";

	const labelClass = "block text-xs font-medium text-muted-foreground mb-1";

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<div>
				<label htmlFor="proj-name" className={labelClass}>
					Name <span className="text-red-400">*</span>
				</label>
				<input
					id="proj-name"
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="my-project"
					maxLength={80}
					required
					className={fieldClass}
				/>
			</div>

			<div>
				<label htmlFor="proj-cwd" className={labelClass}>
					Root directory <span className="text-red-400">*</span>
				</label>
				<input
					id="proj-cwd"
					type="text"
					value={cwd}
					onChange={(e) => setCwd(e.target.value)}
					placeholder="/home/user/projects/my-project"
					required
					className={fieldClass}
				/>
				<p className="text-[11px] text-muted-foreground mt-1">
					Absolute path. Sessions whose cwd starts with this path will be grouped under this
					project.
				</p>
			</div>

			<div>
				<label htmlFor="proj-github" className={labelClass}>
					GitHub URL
				</label>
				<input
					id="proj-github"
					type="url"
					value={githubRepoUrl}
					onChange={(e) => setGithubRepoUrl(e.target.value)}
					placeholder="https://github.com/owner/repo"
					className={fieldClass}
				/>
			</div>

			<div className="grid grid-cols-2 gap-3">
				<div>
					<label htmlFor="proj-agent" className={labelClass}>
						Default agent
					</label>
					<select
						id="proj-agent"
						value={defaultAgentType}
						onChange={(e) => setDefaultAgentType(e.target.value as AgentType | "")}
						className={fieldClass}
					>
						<option value="">— none —</option>
						<option value="claude_code">Claude Code</option>
						<option value="codex_cli">Codex CLI</option>
					</select>
				</div>

				<div>
					<label htmlFor="proj-launch-mode" className={labelClass}>
						Default launch mode
					</label>
					<select
						id="proj-launch-mode"
						value={defaultLaunchMode}
						onChange={(e) => setDefaultLaunchMode(e.target.value as LaunchMode | "")}
						className={fieldClass}
					>
						<option value="">— none —</option>
						<option value="interactive_terminal">Interactive terminal</option>
						<option value="headless">Headless</option>
						<option value="managed_codex">Managed Codex</option>
					</select>
				</div>
			</div>

			<div>
				<label htmlFor="proj-model" className={labelClass}>
					Default model
				</label>
				<input
					id="proj-model"
					type="text"
					value={defaultModel}
					onChange={(e) => setDefaultModel(e.target.value)}
					placeholder="claude-opus-4-5"
					className={fieldClass}
				/>
			</div>

			<div>
				<label htmlFor="proj-notes" className={labelClass}>
					Notes
				</label>
				<textarea
					id="proj-notes"
					value={notes}
					onChange={(e) => setNotes(e.target.value)}
					rows={3}
					placeholder="Brief description of this project..."
					className={`${fieldClass} resize-none`}
				/>
			</div>

			<div className="flex items-center gap-2">
				<input
					id="proj-favorite"
					type="checkbox"
					checked={isFavorite}
					onChange={(e) => setIsFavorite(e.target.checked)}
					className="w-4 h-4 rounded border-border accent-primary"
				/>
				<label htmlFor="proj-favorite" className="text-sm text-foreground cursor-pointer">
					Mark as favorite
				</label>
			</div>

			{error && <p className="text-xs text-red-400 bg-red-500/10 rounded px-3 py-2">{error}</p>}

			<div className="flex gap-2 pt-1">
				<button
					type="submit"
					disabled={saving}
					className="flex-1 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
				>
					{saving ? "Saving…" : initial ? "Save changes" : "Create project"}
				</button>
				<button
					type="button"
					onClick={onCancel}
					disabled={saving}
					className="rounded border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
				>
					Cancel
				</button>
			</div>
		</form>
	);
}
