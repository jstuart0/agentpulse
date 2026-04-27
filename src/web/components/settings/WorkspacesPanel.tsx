import { useEffect, useState } from "react";
import { api } from "../../lib/api.js";

type WorkspaceSettings = {
	defaultRoot: string;
	templateClaudeMd: string;
	gitInit: boolean;
};

const ROOT_PATTERN = /^(?:\/|~\/)/;

function isValidRoot(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.length > 0 && ROOT_PATTERN.test(trimmed);
}

export function WorkspacesPanel() {
	const [saved, setSaved] = useState<WorkspaceSettings | null>(null);
	const [draft, setDraft] = useState<WorkspaceSettings | null>(null);
	const [loading, setLoading] = useState(true);
	const [submitting, setSubmitting] = useState(false);
	const [confirmation, setConfirmation] = useState<string | null>(null);
	const [banner, setBanner] = useState<{ kind: "info" | "error"; text: string } | null>(null);
	const [rootError, setRootError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const ws = await api.getWorkspaceSettings();
				if (cancelled) return;
				setSaved(ws);
				setDraft(ws);
			} catch (err) {
				if (cancelled) return;
				setBanner({
					kind: "error",
					text: `Failed to load workspace settings: ${err instanceof Error ? err.message : String(err)}`,
				});
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	if (loading) {
		return <div className="text-sm text-muted-foreground">Loading workspace settings…</div>;
	}

	if (!draft || !saved) {
		return <div className="text-sm text-red-400">Failed to load workspace settings.</div>;
	}

	const dirty =
		draft.defaultRoot !== saved.defaultRoot ||
		draft.templateClaudeMd !== saved.templateClaudeMd ||
		draft.gitInit !== saved.gitInit;
	const canSave = dirty && !submitting && isValidRoot(draft.defaultRoot);

	async function handleSave() {
		if (!draft) return;
		if (!isValidRoot(draft.defaultRoot)) {
			setRootError("Path must start with / or ~/");
			return;
		}
		setSubmitting(true);
		setBanner(null);
		setConfirmation(null);
		try {
			const next = await api.saveWorkspaceSettings({
				defaultRoot: draft.defaultRoot.trim(),
				templateClaudeMd: draft.templateClaudeMd,
				gitInit: draft.gitInit,
			});
			setSaved(next);
			setDraft(next);
			setConfirmation("Saved");
			window.setTimeout(() => setConfirmation(null), 2000);
		} catch (err) {
			setBanner({
				kind: "error",
				text: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setSubmitting(false);
		}
	}

	function handleRootBlur() {
		if (!draft) return;
		if (draft.defaultRoot.trim().length === 0) {
			setRootError("Path is required");
			return;
		}
		setRootError(isValidRoot(draft.defaultRoot) ? null : "Path must start with / or ~/");
	}

	return (
		<div className="space-y-4">
			{banner && (
				<div
					className={`rounded-md border p-3 text-xs ${
						banner.kind === "error"
							? "border-red-500/30 bg-red-500/10 text-red-300"
							: "border-primary/30 bg-primary/10 text-primary"
					}`}
				>
					{banner.text}
				</div>
			)}

			<div className="rounded-lg border border-border bg-card/30 p-4 space-y-4">
				<div>
					<label
						htmlFor="workspace-default-root"
						className="text-sm font-semibold text-foreground block mb-1"
					>
						Default workspace root
					</label>
					<p className="text-xs text-muted-foreground mb-2">
						AgentPulse creates new scratch workspaces under this path. The supervisor expands
						<code className="mx-1 rounded bg-muted px-1 py-0.5 text-[11px]">~</code> against its own
						home so the same setting works across hosts.
					</p>
					<input
						id="workspace-default-root"
						type="text"
						value={draft.defaultRoot}
						onChange={(e) => {
							setDraft({ ...draft, defaultRoot: e.target.value });
							if (rootError) setRootError(null);
						}}
						onBlur={handleRootBlur}
						placeholder="~/agentpulse-work"
						aria-invalid={rootError ? "true" : undefined}
						aria-describedby={rootError ? "workspace-default-root-error" : undefined}
						className="w-full min-h-[44px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
					/>
					{rootError && (
						<p
							id="workspace-default-root-error"
							className="mt-1 text-[11px] text-red-600 dark:text-red-300"
						>
							{rootError}
						</p>
					)}
				</div>

				<div className="border-t border-border pt-4">
					<label
						htmlFor="workspace-template-claude-md"
						className="text-sm font-semibold text-foreground block mb-1"
					>
						New-workspace CLAUDE.md template
					</label>
					<p className="text-xs text-muted-foreground mb-2">
						Written into each scaffolded workspace. Tokens{" "}
						<code className="rounded bg-muted px-1 py-0.5 text-[11px]">{"{{taskSummary}}"}</code>{" "}
						and <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{"{{taskSlug}}"}</code>{" "}
						are substituted server-side at scaffold time. Leave blank to skip CLAUDE.md creation.
					</p>
					<textarea
						id="workspace-template-claude-md"
						value={draft.templateClaudeMd}
						onChange={(e) => setDraft({ ...draft, templateClaudeMd: e.target.value })}
						rows={4}
						className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
					/>
				</div>

				<div className="border-t border-border pt-4 flex items-start justify-between gap-4">
					<div className="flex-1 min-w-0">
						<label
							htmlFor="workspace-git-init"
							className="text-sm font-semibold text-foreground block mb-1"
						>
							Run git init on new workspaces
						</label>
						<p className="text-xs text-muted-foreground">
							When enabled, AgentPulse runs <code className="font-mono">git init</code> in each new
							workspace. Hosts without git installed will fail with a recoverable error.
						</p>
					</div>
					<button
						id="workspace-git-init"
						type="button"
						role="switch"
						aria-checked={draft.gitInit}
						onClick={() => setDraft({ ...draft, gitInit: !draft.gitInit })}
						className="relative inline-flex h-6 min-h-[24px] w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
						style={{
							backgroundColor: draft.gitInit ? "hsl(var(--primary))" : "hsl(var(--muted))",
						}}
					>
						<span
							className="inline-block h-4 w-4 rounded-full bg-card border border-border transition-transform"
							style={{ transform: draft.gitInit ? "translateX(24px)" : "translateX(4px)" }}
						/>
					</button>
				</div>

				<div className="border-t border-border pt-4 flex items-center justify-end gap-3">
					{confirmation && (
						<span className="text-xs text-muted-foreground" aria-live="polite">
							{confirmation}
						</span>
					)}
					<button
						type="button"
						onClick={() => void handleSave()}
						disabled={!canSave}
						className="min-h-[44px] rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
					>
						{submitting ? "Saving…" : "Save"}
					</button>
				</div>
			</div>
		</div>
	);
}
