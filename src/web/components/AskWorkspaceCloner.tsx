import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";

export interface WorkspaceCloneMeta {
	kind: "workspace_clone";
	draftId: string;
	url: string;
	resolvedPath: string;
	branch?: string;
	depth?: number;
	timeoutSeconds: number;
	canClone: boolean;
	suggestedHost?: string;
	telegramOrigin: boolean;
	error?: { code: string; message: string; path?: string };
}

interface Props {
	meta: WorkspaceCloneMeta;
	disabled: boolean;
	onConfirm(): void;
	onCancel(): void;
	onCustomPath(path: string): void;
	onEditOptions(opts: { branch?: string; depth?: number }): void;
}

/**
 * Inline workspace-cloner UI embedded inside an assistant message bubble
 * when the classifier emitted a clone URL. Sibling to AskWorkspaceScaffolder
 * — same fenced-block sentinel pattern, disjoint state shape (ruby §13.2).
 *
 * Triggered exclusively by the classifier (never picker-pickable per
 * ruby §13.1). The user confirms, cancels, edits the path, or adjusts
 * branch/depth via the "More options" disclosure before the supervisor
 * actually runs `git clone`.
 */
export function AskWorkspaceCloner({
	meta,
	disabled,
	onConfirm,
	onCancel,
	onCustomPath,
	onEditOptions,
}: Props) {
	const [pathDraft, setPathDraft] = useState("");
	const [clientError, setClientError] = useState<string | null>(null);
	const [branchDraft, setBranchDraft] = useState(meta.branch ?? "");
	const [depthDraft, setDepthDraft] = useState(meta.depth !== undefined ? String(meta.depth) : "");
	const confirmRef = useRef<HTMLButtonElement>(null);
	const customPathRef = useRef<HTMLInputElement>(null);
	const branchRef = useRef<HTMLInputElement>(null);
	const settingsLinkRef = useRef<HTMLAnchorElement>(null);
	const componentId = useId();

	const errorCode = meta.error?.code ?? null;

	// Focus management on mount: by default Confirm; on error, focus the
	// recovery affordance (ruby §13.9). The "More options" disclosure
	// auto-expands when the error implies a URL/branch/depth fix.
	const [optionsOpen, setOptionsOpen] = useState<boolean>(
		errorCode === "clone_url_invalid" || errorCode === "clone_timeout",
	);
	useEffect(() => {
		if (disabled) return;
		if (errorCode === "clone_url_invalid") {
			branchRef.current?.focus();
			return;
		}
		if (errorCode === "clone_target_exists") {
			customPathRef.current?.focus();
			return;
		}
		if (errorCode === "clone_scheme_disallowed") {
			settingsLinkRef.current?.focus();
			return;
		}
		confirmRef.current?.focus();
	}, [disabled, errorCode]);

	if (meta.telegramOrigin) {
		return (
			<div className="mt-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-[11px] text-sky-200">
				<div className="font-medium text-sky-100">Awaiting reply in Telegram</div>
				<div className="mt-1 text-sky-300/80">
					Reply <code className="font-mono">yes</code> to confirm,{" "}
					<code className="font-mono">cancel</code> to back out, or paste a different absolute path.
				</div>
			</div>
		);
	}

	function handleSubmitCustomPath(e: React.FormEvent) {
		e.preventDefault();
		const v = pathDraft.trim();
		if (!v) return;
		if (!(v.startsWith("/") || v.startsWith("~/"))) {
			setClientError("Use an absolute path (starts with `/` or `~/`).");
			return;
		}
		if (v.split("/").some((seg) => seg === "..")) {
			setClientError("Path can't contain `..` for security.");
			return;
		}
		setClientError(null);
		onCustomPath(v);
		setPathDraft("");
	}

	function handleSubmitBranch(e: React.FormEvent) {
		e.preventDefault();
		const v = branchDraft.trim();
		if (v.length === 0) return;
		onEditOptions({ branch: v });
	}

	function handleSubmitDepth(e: React.FormEvent) {
		e.preventDefault();
		const v = depthDraft.trim();
		if (v.length === 0) return;
		const n = Number.parseInt(v, 10);
		if (!Number.isInteger(n) || n <= 0) {
			setClientError("Depth must be a positive integer.");
			return;
		}
		setClientError(null);
		onEditOptions({ depth: n });
	}

	const showError = clientError ?? meta.error?.message ?? null;
	const errorIsFromServer = clientError === null && Boolean(meta.error);
	const showSettingsLink = errorCode === "clone_scheme_disallowed" || errorCode === "clone_timeout";
	const showSlowCloneHint = meta.depth !== 1;

	return (
		<div className="mt-2 space-y-2" role="group" aria-labelledby={`${componentId}-label`}>
			<div id={`${componentId}-label`} className="sr-only">
				Confirm git clone
			</div>
			<div className="rounded-md border border-border bg-background/40 p-2.5 space-y-2">
				{/* URL row — wrapped in <details> for graceful long-URL handling on small viewports (ruby §13.5). */}
				<div className="flex items-start gap-2 text-[11px]" aria-live="polite">
					<span className="text-muted-foreground shrink-0">URL:</span>
					<details className="flex-1 min-w-0">
						<summary className="cursor-pointer select-none truncate font-mono text-foreground">
							{meta.url}
						</summary>
						<div className="mt-1 font-mono break-all text-foreground">{meta.url}</div>
					</details>
				</div>
				{/* Branch + depth chips on one row, wrapping. */}
				{(meta.branch || meta.depth !== undefined) && (
					<div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
						{meta.branch && (
							<span>
								branch: <span className="text-foreground font-mono">{meta.branch}</span>
							</span>
						)}
						{meta.depth !== undefined && (
							<span>
								{meta.depth === 1
									? "shallow clone (latest commit only)"
									: `shallow: depth ${meta.depth}`}
							</span>
						)}
					</div>
				)}
				{!meta.branch && meta.depth === undefined && (
					<div className="text-[10px] text-muted-foreground">default branch · full clone</div>
				)}
				{/* Path row */}
				<div className="flex items-center gap-2 text-[11px]" aria-live="polite">
					<span className="text-muted-foreground shrink-0">Path:</span>
					<span className="font-mono text-foreground truncate flex-1" title={meta.resolvedPath}>
						{meta.resolvedPath || "(awaiting path)"}
					</span>
				</div>
				{meta.suggestedHost && (
					<div className="text-[10px] text-muted-foreground">
						on <span className="text-foreground">{meta.suggestedHost}</span>
					</div>
				)}
				<div className="text-[10px] text-muted-foreground">
					{meta.timeoutSeconds === 300 ? "5 min timeout" : `${meta.timeoutSeconds}s timeout`}
				</div>
				{showError && (
					<div
						className={`text-[10px] ${errorIsFromServer ? "text-red-300" : "text-red-300/90"}`}
						aria-live={errorIsFromServer ? "assertive" : "polite"}
					>
						{showError}
					</div>
				)}
				{showSettingsLink && (
					<div className="text-[10px] text-muted-foreground">
						<Link
							ref={settingsLinkRef}
							to="/settings#workspaces-git-clone"
							className="text-primary hover:underline"
						>
							Open Settings → Workspaces
						</Link>
					</div>
				)}
				<div className="flex flex-wrap gap-2">
					<button
						ref={confirmRef}
						type="button"
						disabled={disabled || !meta.canClone || Boolean(meta.error)}
						onClick={onConfirm}
						className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
					>
						Confirm
					</button>
					<button
						type="button"
						disabled={disabled}
						onClick={onCancel}
						className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
					>
						Cancel
					</button>
				</div>
				<form onSubmit={handleSubmitCustomPath} className="flex flex-wrap gap-1.5 items-center">
					<label
						htmlFor={`${componentId}-custom-path`}
						className="text-[10px] text-muted-foreground"
					>
						Or use a different path:
					</label>
					<input
						id={`${componentId}-custom-path`}
						ref={customPathRef}
						type="text"
						value={pathDraft}
						onChange={(e) => {
							setPathDraft(e.target.value);
							if (clientError) setClientError(null);
						}}
						placeholder="/Users/me/dev/scratch"
						disabled={disabled}
						aria-describedby={clientError ? `${componentId}-client-error` : undefined}
						className="flex-1 min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
					/>
					<button
						type="submit"
						disabled={disabled || !pathDraft.trim()}
						className="rounded-md border border-border bg-card px-2 py-1.5 text-[11px] text-foreground hover:bg-muted disabled:opacity-50"
					>
						Use this path
					</button>
				</form>
				{clientError && (
					<div id={`${componentId}-client-error`} className="text-[10px] text-red-300/90">
						{clientError}
					</div>
				)}
				{showSlowCloneHint && (
					<div className="text-[10px] text-muted-foreground">
						Clones can take a few minutes for large repos. AgentPulse will launch the agent as soon
						as the clone finishes.
					</div>
				)}
				<details
					className="text-[10px] text-muted-foreground"
					open={optionsOpen}
					onToggle={(e) => setOptionsOpen((e.target as HTMLDetailsElement).open)}
				>
					<summary className="cursor-pointer hover:text-foreground select-none">
						More options
					</summary>
					<div className="mt-1.5 space-y-1.5">
						<div className="text-[10px] text-muted-foreground italic">
							Most users don't need these. The defaults match how you'd clone manually.
						</div>
						<form onSubmit={handleSubmitBranch} className="flex flex-wrap gap-1.5 items-center">
							<label
								htmlFor={`${componentId}-branch`}
								className="text-[10px] text-muted-foreground"
							>
								Branch (override):
							</label>
							<input
								id={`${componentId}-branch`}
								ref={branchRef}
								type="text"
								value={branchDraft}
								onChange={(e) => setBranchDraft(e.target.value)}
								placeholder="default branch"
								disabled={disabled}
								className="flex-1 min-w-0 rounded-md border border-input bg-background px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
							/>
							<button
								type="submit"
								disabled={disabled || !branchDraft.trim()}
								className="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-foreground hover:bg-muted disabled:opacity-50"
							>
								Use this branch
							</button>
						</form>
						<form onSubmit={handleSubmitDepth} className="flex flex-wrap gap-1.5 items-center">
							<label htmlFor={`${componentId}-depth`} className="text-[10px] text-muted-foreground">
								Shallow clone depth:
							</label>
							<input
								id={`${componentId}-depth`}
								type="number"
								min={1}
								value={depthDraft}
								onChange={(e) => setDepthDraft(e.target.value)}
								placeholder="full clone"
								disabled={disabled}
								className="w-20 rounded-md border border-input bg-background px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
							/>
							<button
								type="submit"
								disabled={disabled || !depthDraft.trim()}
								className="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-foreground hover:bg-muted disabled:opacity-50"
							>
								Use this depth
							</button>
						</form>
					</div>
				</details>
				<details className="text-[10px] text-muted-foreground">
					<summary className="cursor-pointer hover:text-foreground select-none">
						Show what will happen
					</summary>
					<ul className="mt-1.5 space-y-0.5 font-mono text-[10px] whitespace-pre-wrap break-all">
						<li>
							{`git clone ${meta.url} ${meta.resolvedPath}`}
							{meta.branch ? ` --branch ${meta.branch}` : ""}
							{meta.depth !== undefined ? ` --depth ${meta.depth}` : ""}
						</li>
						<li>Register scratch project at this path</li>
					</ul>
				</details>
			</div>
		</div>
	);
}

const CLONER_FENCE_RE = /\n*```ask-message-meta\n([\s\S]*?)\n```/;

/**
 * Pure parser — exported so AskPage can detect workspace_clone payloads
 * embedded in assistant message content. Returns null when the content
 * has no sentinel, when the embedded JSON is malformed, or when the
 * kind discriminator is anything other than "workspace_clone".
 */
export function parseClonerMeta(
	content: string,
): { meta: WorkspaceCloneMeta; visibleText: string } | null {
	const match = content.match(CLONER_FENCE_RE);
	if (!match) return null;
	try {
		const parsed = JSON.parse(match[1]);
		if (
			parsed &&
			parsed.kind === "workspace_clone" &&
			typeof parsed.url === "string" &&
			typeof parsed.resolvedPath === "string"
		) {
			return {
				meta: parsed as WorkspaceCloneMeta,
				visibleText: content.replace(CLONER_FENCE_RE, "").trim(),
			};
		}
	} catch {
		return null;
	}
	return null;
}
