import { useEffect, useId, useRef, useState } from "react";

export interface WorkspaceScaffoldAction {
	kind: string;
	path: string;
	gitInit?: boolean;
	seedClaudeMdPath?: string;
	seedClaudeMdBytes?: number;
}

export interface WorkspaceScaffoldMeta {
	kind: "workspace_scaffold";
	draftId: string;
	resolvedPath: string;
	taskSlug: string;
	actions: WorkspaceScaffoldAction[];
	canScaffold: boolean;
	suggestedHost?: string;
	telegramOrigin: boolean;
	error?: { code: string; message: string; path?: string };
}

interface Props {
	meta: WorkspaceScaffoldMeta;
	disabled: boolean;
	onConfirm(): void;
	onCancel(): void;
	onCustomPath(path: string): void;
}

/**
 * Inline workspace-scaffolder UI embedded inside an assistant message
 * bubble. Sibling to AskProjectPicker — same sentinel pattern, disjoint
 * state shape (ruby §11.6).
 *
 * Behavior contract:
 * - Confirm posts the synthetic user message "yes".
 * - Cancel posts the synthetic user message "cancel".
 * - Custom path posts the typed absolute / tilde path verbatim.
 *
 * Validation errors from the server come back via `meta.error` and
 * render inline. Path-edit validation also runs client-side as a cheap
 * pre-check so obvious typos don't cost a roundtrip.
 */
export function AskWorkspaceScaffolder({
	meta,
	disabled,
	onConfirm,
	onCancel,
	onCustomPath,
}: Props) {
	const [pathDraft, setPathDraft] = useState("");
	const [clientError, setClientError] = useState<string | null>(null);
	const confirmRef = useRef<HTMLButtonElement>(null);
	const componentId = useId();

	// Auto-focus Confirm on mount so keyboard users land on the
	// actionable element first (ruby §11.9).
	useEffect(() => {
		if (!disabled && confirmRef.current) confirmRef.current.focus();
	}, [disabled]);

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

	const showError = clientError ?? meta.error?.message ?? null;
	const errorIsFromServer = clientError === null && Boolean(meta.error);

	return (
		<fieldset className="mt-2 space-y-2 border-0 p-0 m-0">
			<legend className="sr-only">Confirm new workspace path</legend>
			<div className="rounded-md border border-border bg-background/40 p-2.5 space-y-2">
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
				{showError && (
					<div
						className={`text-[10px] ${errorIsFromServer ? "text-red-300" : "text-red-300/90"}`}
						aria-live={errorIsFromServer ? "assertive" : "polite"}
					>
						{showError}
					</div>
				)}
				<div className="flex flex-wrap gap-2">
					<button
						ref={confirmRef}
						type="button"
						disabled={disabled || !meta.canScaffold || Boolean(meta.error)}
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
				<details className="text-[10px] text-muted-foreground">
					<summary className="cursor-pointer hover:text-foreground select-none">
						Show what this will create
					</summary>
					<ul className="mt-1.5 space-y-0.5 font-mono text-[10px] whitespace-pre-wrap break-all">
						{meta.actions.length === 0 && <li>(no actions yet)</li>}
						{meta.actions.flatMap((a, idx) => {
							const lines: { key: string; text: string }[] = [];
							lines.push({
								key: `${idx}-mkdir`,
								text: `mkdir -p ${a.path}`,
							});
							if (a.gitInit) {
								lines.push({ key: `${idx}-git`, text: "git init --quiet" });
							}
							if (a.seedClaudeMdPath) {
								const sizeStr = a.seedClaudeMdBytes ? ` (${a.seedClaudeMdBytes} bytes)` : "";
								lines.push({
									key: `${idx}-claude`,
									text: `Write ${a.seedClaudeMdPath}${sizeStr}`,
								});
							}
							lines.push({
								key: `${idx}-register`,
								text: `Register scratch project: ${meta.taskSlug}`,
							});
							return lines.map((l) => <li key={l.key}>{l.text}</li>);
						})}
					</ul>
				</details>
			</div>
		</fieldset>
	);
}

const SCAFFOLDER_FENCE_RE = /\n*```ask-message-meta\n([\s\S]*?)\n```/;

/**
 * Pure parser — exported so AskPage can detect workspace_scaffold
 * payloads embedded in assistant message content. Returns null when the
 * content has no sentinel, when the embedded JSON is malformed, or when
 * the kind discriminator is anything other than "workspace_scaffold".
 */
export function parseScaffolderMeta(
	content: string,
): { meta: WorkspaceScaffoldMeta; visibleText: string } | null {
	const match = content.match(SCAFFOLDER_FENCE_RE);
	if (!match) return null;
	try {
		const parsed = JSON.parse(match[1]);
		if (
			parsed &&
			parsed.kind === "workspace_scaffold" &&
			typeof parsed.resolvedPath === "string" &&
			Array.isArray(parsed.actions)
		) {
			return {
				meta: parsed as WorkspaceScaffoldMeta,
				visibleText: content.replace(SCAFFOLDER_FENCE_RE, "").trim(),
			};
		}
	} catch {
		return null;
	}
	return null;
}
