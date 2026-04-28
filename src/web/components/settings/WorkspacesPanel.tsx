import { useEffect, useState } from "react";
import { api } from "../../lib/api.js";

type WorkspaceFields = {
	defaultRoot: string;
	templateClaudeMd: string;
	gitInit: boolean;
};

type GitCloneFields = {
	allowSshUrls: boolean;
	allowLocalUrls: boolean;
	defaultDepth: number | null;
	defaultDepthInput: string;
	timeoutSeconds: number;
	timeoutSecondsInput: string;
};

type SavedSettings = {
	workspace: WorkspaceFields;
	gitClone: {
		allowSshUrls: boolean;
		allowLocalUrls: boolean;
		defaultDepth: number | null;
		timeoutSeconds: number;
	};
};

const ROOT_PATTERN = /^(?:\/|~\/)/;
const TIMEOUT_MIN = 30;
const TIMEOUT_MAX = 3600;

function isValidRoot(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.length > 0 && ROOT_PATTERN.test(trimmed);
}

function parseDepthInput(raw: string): { ok: true; value: number | null } | { ok: false } {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { ok: true, value: null };
	if (!/^\d+$/.test(trimmed)) return { ok: false };
	const n = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(n) || n <= 0) return { ok: false };
	return { ok: true, value: n };
}

function parseTimeoutInput(raw: string): { ok: true; value: number } | { ok: false } {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { ok: false };
	if (!/^\d+$/.test(trimmed)) return { ok: false };
	const n = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(n) || n < TIMEOUT_MIN || n > TIMEOUT_MAX) return { ok: false };
	return { ok: true, value: n };
}

export function WorkspacesPanel() {
	const [saved, setSaved] = useState<SavedSettings | null>(null);
	const [draftWorkspace, setDraftWorkspace] = useState<WorkspaceFields | null>(null);
	const [draftGitClone, setDraftGitClone] = useState<GitCloneFields | null>(null);
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
				setDraftWorkspace(ws.workspace);
				setDraftGitClone({
					allowSshUrls: ws.gitClone.allowSshUrls,
					allowLocalUrls: ws.gitClone.allowLocalUrls,
					defaultDepth: ws.gitClone.defaultDepth,
					defaultDepthInput:
						ws.gitClone.defaultDepth === null ? "" : String(ws.gitClone.defaultDepth),
					timeoutSeconds: ws.gitClone.timeoutSeconds,
					timeoutSecondsInput: String(ws.gitClone.timeoutSeconds),
				});
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

	if (!draftWorkspace || !draftGitClone || !saved) {
		return <div className="text-sm text-red-400">Failed to load workspace settings.</div>;
	}

	const depthParsed = parseDepthInput(draftGitClone.defaultDepthInput);
	const timeoutParsed = parseTimeoutInput(draftGitClone.timeoutSecondsInput);
	const depthError = !depthParsed.ok
		? "Depth must be a positive integer or empty for full clone."
		: null;
	const timeoutError = !timeoutParsed.ok
		? `Timeout must be an integer between ${TIMEOUT_MIN} and ${TIMEOUT_MAX} seconds.`
		: null;

	const dirtyWorkspace =
		draftWorkspace.defaultRoot !== saved.workspace.defaultRoot ||
		draftWorkspace.templateClaudeMd !== saved.workspace.templateClaudeMd ||
		draftWorkspace.gitInit !== saved.workspace.gitInit;
	const dirtyGitClone =
		draftGitClone.allowSshUrls !== saved.gitClone.allowSshUrls ||
		draftGitClone.allowLocalUrls !== saved.gitClone.allowLocalUrls ||
		(depthParsed.ok && depthParsed.value !== saved.gitClone.defaultDepth) ||
		(timeoutParsed.ok && timeoutParsed.value !== saved.gitClone.timeoutSeconds);
	const dirty = dirtyWorkspace || dirtyGitClone;
	const canSave =
		dirty &&
		!submitting &&
		isValidRoot(draftWorkspace.defaultRoot) &&
		depthParsed.ok &&
		timeoutParsed.ok;

	async function handleSave() {
		if (!draftWorkspace || !draftGitClone || !saved) return;
		if (!isValidRoot(draftWorkspace.defaultRoot)) {
			setRootError("Path must start with / or ~/");
			return;
		}
		if (!depthParsed.ok || !timeoutParsed.ok) {
			return;
		}

		setSubmitting(true);
		setBanner(null);
		setConfirmation(null);
		try {
			const next = await api.saveWorkspaceSettings({
				workspace: {
					defaultRoot: draftWorkspace.defaultRoot.trim(),
					templateClaudeMd: draftWorkspace.templateClaudeMd,
					gitInit: draftWorkspace.gitInit,
				},
				gitClone: {
					allowSshUrls: draftGitClone.allowSshUrls,
					allowLocalUrls: draftGitClone.allowLocalUrls,
					defaultDepth: depthParsed.value,
					timeoutSeconds: timeoutParsed.value,
				},
			});
			setSaved(next);
			setDraftWorkspace(next.workspace);
			setDraftGitClone({
				allowSshUrls: next.gitClone.allowSshUrls,
				allowLocalUrls: next.gitClone.allowLocalUrls,
				defaultDepth: next.gitClone.defaultDepth,
				defaultDepthInput:
					next.gitClone.defaultDepth === null ? "" : String(next.gitClone.defaultDepth),
				timeoutSeconds: next.gitClone.timeoutSeconds,
				timeoutSecondsInput: String(next.gitClone.timeoutSeconds),
			});
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
		if (!draftWorkspace) return;
		if (draftWorkspace.defaultRoot.trim().length === 0) {
			setRootError("Path is required");
			return;
		}
		setRootError(isValidRoot(draftWorkspace.defaultRoot) ? null : "Path must start with / or ~/");
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
						value={draftWorkspace.defaultRoot}
						onChange={(e) => {
							setDraftWorkspace({ ...draftWorkspace, defaultRoot: e.target.value });
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
						value={draftWorkspace.templateClaudeMd}
						onChange={(e) =>
							setDraftWorkspace({ ...draftWorkspace, templateClaudeMd: e.target.value })
						}
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
						aria-checked={draftWorkspace.gitInit}
						onClick={() =>
							setDraftWorkspace({ ...draftWorkspace, gitInit: !draftWorkspace.gitInit })
						}
						className="relative inline-flex h-6 min-h-[24px] w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
						style={{
							backgroundColor: draftWorkspace.gitInit ? "hsl(var(--primary))" : "hsl(var(--muted))",
						}}
					>
						<span
							className="inline-block h-4 w-4 rounded-full bg-card border border-border transition-transform"
							style={{
								transform: draftWorkspace.gitInit ? "translateX(24px)" : "translateX(4px)",
							}}
						/>
					</button>
				</div>

				<div
					id="git-clone"
					tabIndex={-1}
					className="border-t border-border pt-4 space-y-4 focus:outline-none"
				>
					<h3 className="text-sm font-semibold text-foreground">Git clone defaults</h3>
					<p className="text-xs text-muted-foreground">
						Applied when AgentPulse runs <code className="font-mono">git clone</code> on your behalf
						for AI-initiated launches.
					</p>

					<div className="flex items-start justify-between gap-4">
						<div className="flex-1 min-w-0">
							<label
								htmlFor="git-clone-allow-ssh"
								className="text-sm font-medium text-foreground block mb-1"
							>
								Allow SSH URLs (<code className="font-mono">git@…</code>)
							</label>
							<p className="text-xs text-muted-foreground">
								Permit <code className="font-mono">ssh://</code> and{" "}
								<code className="font-mono">git@host:repo</code> URLs in clone actions. Off by
								default.
							</p>
							{draftGitClone.allowSshUrls && (
								<p className="mt-1 text-[11px] text-amber-300/90">
									SSH URLs require an SSH agent and credentials on the supervisor host. Cloning
									private repos may prompt for keys.
								</p>
							)}
						</div>
						<button
							id="git-clone-allow-ssh"
							type="button"
							role="switch"
							aria-checked={draftGitClone.allowSshUrls}
							onClick={() =>
								setDraftGitClone({
									...draftGitClone,
									allowSshUrls: !draftGitClone.allowSshUrls,
								})
							}
							className="relative inline-flex h-6 min-h-[24px] w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
							style={{
								backgroundColor: draftGitClone.allowSshUrls
									? "hsl(var(--primary))"
									: "hsl(var(--muted))",
							}}
						>
							<span
								className="inline-block h-4 w-4 rounded-full bg-card border border-border transition-transform"
								style={{
									transform: draftGitClone.allowSshUrls ? "translateX(24px)" : "translateX(4px)",
								}}
							/>
						</button>
					</div>

					<div className="flex items-start justify-between gap-4">
						<div className="flex-1 min-w-0">
							<label
								htmlFor="git-clone-allow-local"
								className="text-sm font-medium text-foreground block mb-1"
							>
								Allow local <code className="font-mono">file://</code> URLs
							</label>
							<p className="text-xs text-muted-foreground">
								Allows cloning from a path on the supervisor host. Mostly useful for testing; off by
								default.
							</p>
						</div>
						<button
							id="git-clone-allow-local"
							type="button"
							role="switch"
							aria-checked={draftGitClone.allowLocalUrls}
							onClick={() =>
								setDraftGitClone({
									...draftGitClone,
									allowLocalUrls: !draftGitClone.allowLocalUrls,
								})
							}
							className="relative inline-flex h-6 min-h-[24px] w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
							style={{
								backgroundColor: draftGitClone.allowLocalUrls
									? "hsl(var(--primary))"
									: "hsl(var(--muted))",
							}}
						>
							<span
								className="inline-block h-4 w-4 rounded-full bg-card border border-border transition-transform"
								style={{
									transform: draftGitClone.allowLocalUrls ? "translateX(24px)" : "translateX(4px)",
								}}
							/>
						</button>
					</div>

					<div>
						<label
							htmlFor="git-clone-default-depth"
							className="text-sm font-medium text-foreground block mb-1"
						>
							Default clone depth
						</label>
						<input
							id="git-clone-default-depth"
							type="number"
							min={1}
							inputMode="numeric"
							placeholder="empty"
							value={draftGitClone.defaultDepthInput}
							onChange={(e) =>
								setDraftGitClone({ ...draftGitClone, defaultDepthInput: e.target.value })
							}
							aria-invalid={depthError ? "true" : undefined}
							aria-describedby={
								depthError ? "git-clone-default-depth-error" : "git-clone-default-depth-help"
							}
							className="w-full min-h-[44px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
						/>
						<p id="git-clone-default-depth-help" className="mt-1 text-xs text-muted-foreground">
							Shallow clone with this depth. Leave empty for a full clone.
						</p>
						{depthError && (
							<p
								id="git-clone-default-depth-error"
								className="mt-1 text-[11px] text-red-600 dark:text-red-300"
							>
								{depthError}
							</p>
						)}
					</div>

					<div>
						<label
							htmlFor="git-clone-timeout"
							className="text-sm font-medium text-foreground block mb-1"
						>
							Clone timeout (seconds)
						</label>
						<input
							id="git-clone-timeout"
							type="number"
							min={TIMEOUT_MIN}
							max={TIMEOUT_MAX}
							inputMode="numeric"
							value={draftGitClone.timeoutSecondsInput}
							onChange={(e) =>
								setDraftGitClone({ ...draftGitClone, timeoutSecondsInput: e.target.value })
							}
							aria-invalid={timeoutError ? "true" : undefined}
							aria-describedby={timeoutError ? "git-clone-timeout-error" : "git-clone-timeout-help"}
							className="w-full min-h-[44px] rounded-md border border-input bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
						/>
						<p id="git-clone-timeout-help" className="mt-1 text-xs text-muted-foreground">
							Abort the clone if it exceeds this many seconds.
						</p>
						{timeoutError && (
							<p
								id="git-clone-timeout-error"
								className="mt-1 text-[11px] text-red-600 dark:text-red-300"
							>
								{timeoutError}
							</p>
						)}
					</div>
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
