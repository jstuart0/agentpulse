import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { AskMessageMeta } from "../../shared/ask-meta.js";

// Slice 5d: server-provided gate on the "Scaffold a fresh workspace" CTA.
// False when no connected supervisor advertises the can_scaffold_workarea
// capability flag (ruby §11.5). Re-exported so other modules that import
// ProjectPickerMeta by name keep working without changes.
export type ProjectPickerMeta = Extract<AskMessageMeta, { kind: "project_picker" }>;

interface Props {
	meta: ProjectPickerMeta;
	disabled: boolean;
	onSelect: (reply: string) => void;
}

/**
 * Inline project-picker UI embedded inside an assistant message bubble.
 *
 * Behavior contract: every pick (button, path input, or "new" link) posts
 * a synthetic user message back through the existing Ask composer flow,
 * so the conversation transcript stays linear and the server's
 * disambiguation parser handles the actual resolution.
 */
export function AskProjectPicker({ meta, disabled, onSelect }: Props) {
	const [pathDraft, setPathDraft] = useState("");
	const buttonsRef = useRef<HTMLDivElement>(null);
	const pickerId = useId();

	// Arrow-up/down keyboard navigation between project buttons.
	useEffect(() => {
		const root = buttonsRef.current;
		if (!root) return;
		function handleKey(e: KeyboardEvent) {
			if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
			if (!root) return;
			const buttons = Array.from(
				root.querySelectorAll<HTMLButtonElement>('button[data-picker-choice="true"]'),
			);
			if (buttons.length === 0) return;
			const active = document.activeElement as HTMLElement | null;
			const currentIndex = buttons.findIndex((b) => b === active);
			if (currentIndex === -1) return;
			e.preventDefault();
			const delta = e.key === "ArrowDown" ? 1 : -1;
			const next = (currentIndex + delta + buttons.length) % buttons.length;
			buttons[next].focus();
		}
		root.addEventListener("keydown", handleKey);
		return () => root.removeEventListener("keydown", handleKey);
	}, []);

	if (meta.telegramOrigin) {
		return (
			<div className="mt-2 rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-[11px] text-sky-200">
				<div className="font-medium text-sky-100">Awaiting reply in Telegram</div>
				<div className="mt-1 text-sky-300/80">
					This thread originated in Telegram. Reply with the number of the project you want to use.
				</div>
			</div>
		);
	}

	if (meta.choices.length === 0) {
		return (
			<div className="mt-2 space-y-2">
				{meta.canScaffold && (
					<button
						type="button"
						disabled={disabled}
						onClick={() => onSelect("new")}
						className="inline-flex items-center rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
					>
						Scaffold a fresh workspace
					</button>
				)}
				<form
					onSubmit={(e) => {
						e.preventDefault();
						const v = pathDraft.trim();
						if (!v || disabled) return;
						onSelect(v);
						setPathDraft("");
					}}
					className="flex gap-1.5"
				>
					<input
						type="text"
						value={pathDraft}
						onChange={(e) => setPathDraft(e.target.value)}
						placeholder="…or paste an absolute path (/Users/me/dev/project)"
						disabled={disabled}
						className="flex-1 min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
					/>
					<button
						type="submit"
						disabled={disabled || !pathDraft.trim()}
						className="rounded-md border border-border bg-card px-2 py-1.5 text-[11px] text-foreground hover:bg-muted disabled:opacity-50"
					>
						Use path
					</button>
				</form>
				<Link
					to="/settings"
					className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
				>
					…or add an existing project in Settings
				</Link>
			</div>
		);
	}

	return (
		<div className="mt-2 space-y-2">
			<div id={`${pickerId}-label`} className="sr-only">
				Pick a project for the launch
			</div>
			<div ref={buttonsRef} className="flex flex-col gap-1" aria-labelledby={`${pickerId}-label`}>
				{meta.choices.map((c, i) => (
					<button
						key={c.id}
						type="button"
						data-picker-choice="true"
						disabled={disabled}
						onClick={() => onSelect(`${i + 1}`)}
						className="group flex w-full flex-col items-start rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-left hover:bg-muted disabled:opacity-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					>
						<span className="text-xs text-foreground">
							<span className="text-muted-foreground">{i + 1}.</span> {c.name}
						</span>
						<span className="text-[10px] text-muted-foreground">{c.cwd}</span>
					</button>
				))}
			</div>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					const v = pathDraft.trim();
					if (!v || disabled) return;
					onSelect(v);
					setPathDraft("");
				}}
				className="flex gap-1.5"
			>
				<input
					type="text"
					value={pathDraft}
					onChange={(e) => setPathDraft(e.target.value)}
					placeholder="Paste a different path"
					disabled={disabled}
					className="flex-1 min-w-0 rounded-md border border-input bg-background px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
				/>
				<button
					type="submit"
					disabled={disabled || !pathDraft.trim()}
					className="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-foreground hover:bg-muted disabled:opacity-50"
				>
					Use path
				</button>
			</form>
			{meta.canScaffold && (
				<button
					type="button"
					disabled={disabled}
					onClick={() => onSelect("new")}
					className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 disabled:opacity-50"
				>
					Scaffold a new workspace
				</button>
			)}
		</div>
	);
}

