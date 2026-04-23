import { useState } from "react";
import type { SessionEvent } from "../../../shared/types.js";

const MAX_INLINE_LINES = 20;
const MAX_INLINE_CHARS = 1200;

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function truncatePath(path: string): string {
	if (path.length <= 60) return path;
	return `…${path.slice(-57)}`;
}

function summarizeInput(toolName: string, input: Record<string, unknown> | null): string {
	if (!input) return "";
	const filePath = asString(input.file_path);
	switch (toolName) {
		case "Edit":
		case "MultiEdit":
		case "Write":
		case "NotebookEdit":
			return filePath ? truncatePath(filePath) : "";
		case "Read":
			if (filePath) {
				const offset = typeof input.offset === "number" ? input.offset : undefined;
				const limit = typeof input.limit === "number" ? input.limit : undefined;
				if (offset !== undefined || limit !== undefined) {
					return `${truncatePath(filePath)}${offset !== undefined ? `:${offset}` : ""}${limit !== undefined ? `+${limit}` : ""}`;
				}
				return truncatePath(filePath);
			}
			return "";
		case "Bash": {
			const command = asString(input.command) ?? "";
			const firstLine = command.split("\n")[0] ?? "";
			return firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine;
		}
		case "Grep":
			return asString(input.pattern) ?? "";
		case "Glob":
			return asString(input.pattern) ?? "";
		case "Task": {
			const description = asString(input.description);
			const subagent = asString(input.subagent_type);
			if (description && subagent) return `${subagent}: ${description}`;
			return description ?? subagent ?? "";
		}
		case "TodoWrite": {
			const todos = Array.isArray(input.todos) ? input.todos : null;
			return todos ? `${todos.length} todo${todos.length === 1 ? "" : "s"}` : "";
		}
		case "WebFetch":
		case "WebSearch":
			return asString(input.url) ?? asString(input.query) ?? "";
		default:
			return "";
	}
}

function headerLabel(toolName: string): string {
	if (
		toolName === "Edit" ||
		toolName === "MultiEdit" ||
		toolName === "Write" ||
		toolName === "NotebookEdit"
	) {
		return "Update";
	}
	return toolName;
}

function renderDiff(
	oldStr: string,
	newStr: string,
): {
	added: number;
	removed: number;
	lines: Array<{ kind: "add" | "remove" | "context"; text: string }>;
} {
	// Minimal line-level diff — good enough for quick visual, not a full LCS diff.
	// For common Edit use case (replacing a small contiguous block), this shows
	// all old lines as removed followed by all new lines as added.
	const oldLines = oldStr.split("\n");
	const newLines = newStr.split("\n");
	const lines: Array<{ kind: "add" | "remove" | "context"; text: string }> = [];
	let shared = 0;
	while (
		shared < oldLines.length &&
		shared < newLines.length &&
		oldLines[shared] === newLines[shared]
	)
		shared++;
	for (let i = 0; i < shared; i++) lines.push({ kind: "context", text: oldLines[i] });
	for (let i = shared; i < oldLines.length; i++) lines.push({ kind: "remove", text: oldLines[i] });
	for (let i = shared; i < newLines.length; i++) lines.push({ kind: "add", text: newLines[i] });
	const added = lines.filter((l) => l.kind === "add").length;
	const removed = lines.filter((l) => l.kind === "remove").length;
	return { added, removed, lines };
}

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
	const [expanded, setExpanded] = useState(false);
	const { added, removed, lines } = renderDiff(oldStr, newStr);
	const shouldCollapse = !expanded && lines.length > MAX_INLINE_LINES;
	const displayed = shouldCollapse ? lines.slice(0, MAX_INLINE_LINES) : lines;
	const summary =
		[
			added > 0 ? `Added ${added} line${added === 1 ? "" : "s"}` : null,
			removed > 0 ? `Removed ${removed} line${removed === 1 ? "" : "s"}` : null,
		]
			.filter(Boolean)
			.join(", ") || "No changes";

	return (
		<div className="font-mono text-[12px] leading-5">
			<div className="text-muted-foreground">
				<span className="mr-1">⎿</span>
				{summary}
			</div>
			<div className="mt-1 pl-4 border-l border-border/50">
				{displayed.map((line, idx) => (
					<div
						key={idx}
						className={
							line.kind === "add"
								? "text-emerald-400"
								: line.kind === "remove"
									? "text-red-400"
									: "text-muted-foreground"
						}
					>
						<span className="inline-block w-4 text-center select-none opacity-60">
							{line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
						</span>
						<span className="whitespace-pre-wrap break-all">{line.text}</span>
					</div>
				))}
				{shouldCollapse && (
					<button
						type="button"
						onClick={() => setExpanded(true)}
						className="text-xs text-primary hover:underline mt-1"
					>
						Show {lines.length - MAX_INLINE_LINES} more line
						{lines.length - MAX_INLINE_LINES === 1 ? "" : "s"}
					</button>
				)}
			</div>
		</div>
	);
}

function ResponseBody({ text }: { text: string }) {
	const [expanded, setExpanded] = useState(false);
	const trimmed = text.replace(/\s+$/, "");
	if (!trimmed) return null;
	const tooLong =
		!expanded &&
		(trimmed.length > MAX_INLINE_CHARS || trimmed.split("\n").length > MAX_INLINE_LINES);
	const display = tooLong
		? trimmed.split("\n").slice(0, MAX_INLINE_LINES).join("\n").slice(0, MAX_INLINE_CHARS)
		: trimmed;
	return (
		<div className="font-mono text-[12px] leading-5 text-muted-foreground pl-4 border-l border-border/50">
			<pre className="whitespace-pre-wrap break-all m-0 text-muted-foreground">{display}</pre>
			{tooLong && (
				<button
					type="button"
					onClick={() => setExpanded(true)}
					className="text-xs text-primary hover:underline mt-1"
				>
					Show full output ({trimmed.length.toLocaleString()} chars)
				</button>
			)}
		</div>
	);
}

function flattenResponse(response: unknown): string {
	if (response == null) return "";
	if (typeof response === "string") return response;
	const rec = asRecord(response);
	if (rec) {
		const text =
			asString(rec.text) ?? asString(rec.content) ?? asString(rec.output) ?? asString(rec.stdout);
		if (text) return text;
		try {
			return JSON.stringify(response, null, 2);
		} catch {
			return String(response);
		}
	}
	if (Array.isArray(response)) {
		return response
			.map((item) => {
				const rec = asRecord(item);
				if (rec) return asString(rec.text) ?? JSON.stringify(item);
				return typeof item === "string" ? item : JSON.stringify(item);
			})
			.join("\n");
	}
	return String(response);
}

export function ToolCallBlock({ event }: { event: SessionEvent }) {
	const toolName = event.toolName ?? "Tool";
	const input = asRecord(event.toolInput);
	const summary = summarizeInput(toolName, input);
	const label = headerLabel(toolName);

	const isEdit = toolName === "Edit" || toolName === "MultiEdit";
	const isWrite = toolName === "Write";
	const oldStr = input ? asString(input.old_string) : null;
	const newStr = input ? asString(input.new_string) : null;
	const writeContent = input ? asString(input.content) : null;
	const bashCommand = toolName === "Bash" ? (input ? asString(input.command) : null) : null;
	const responseText = flattenResponse(event.toolResponse);

	return (
		<div className="text-sm">
			<div className="flex items-baseline gap-2 font-mono text-[13px]">
				<span className="text-primary select-none">⏺</span>
				<span>
					<span className="text-foreground">{label}</span>
					{summary ? <span className="text-muted-foreground">({summary})</span> : null}
				</span>
			</div>
			<div className="mt-1 ml-4">
				{isEdit && oldStr !== null && newStr !== null ? (
					<DiffView oldStr={oldStr} newStr={newStr} />
				) : isWrite && writeContent !== null ? (
					<DiffView oldStr="" newStr={writeContent} />
				) : bashCommand ? (
					<div className="font-mono text-[12px] leading-5 pl-4 border-l border-border/50">
						<div className="text-muted-foreground">
							<span className="mr-1">⎿</span>
							<span className="text-foreground">$ </span>
							<span className="whitespace-pre-wrap break-all">{bashCommand}</span>
						</div>
						{responseText ? (
							<pre className="whitespace-pre-wrap break-all m-0 mt-0.5 text-muted-foreground">
								{responseText.length > MAX_INLINE_CHARS
									? `${responseText.slice(0, MAX_INLINE_CHARS)}…`
									: responseText}
							</pre>
						) : null}
					</div>
				) : responseText ? (
					<ResponseBody text={responseText} />
				) : null}
			</div>
		</div>
	);
}
