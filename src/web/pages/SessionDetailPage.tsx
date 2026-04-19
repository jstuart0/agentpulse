import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { StatusBadge } from "../components/StatusBadge.js";
import { AgentTypeBadge } from "../components/AgentTypeBadge.js";
import { MarkdownContent } from "../components/MarkdownContent.js";
import { formatDuration, formatTimeAgo } from "../lib/utils.js";
import { api } from "../lib/api.js";
import { cn } from "../lib/utils.js";
import { APP_API_BASE } from "../lib/paths.js";
import type { ControlAction, EventCategory, Session, SessionEvent } from "../../shared/types.js";
import { useEventStore } from "../stores/event-store.js";

function ScrollJumpControls({
	onTop,
	onBottom,
}: {
	onTop: () => void;
	onBottom: () => void;
}) {
	return (
		<div className="flex items-center gap-1">
			<button
				onClick={onTop}
				className="rounded border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
			>
				Top
			</button>
			<button
				onClick={onBottom}
				className="rounded border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
			>
				Bottom
			</button>
		</div>
	);
}

function NotesPanel({ sessionId, initialNotes }: { sessionId: string; initialNotes: string }) {
	const [notes, setNotes] = useState(initialNotes);
	const [saving, setSaving] = useState(false);
	const [lastSaved, setLastSaved] = useState<string | null>(null);
	const [mode, setMode] = useState<"edit" | "preview">("edit");
	const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const editRef = useRef<HTMLTextAreaElement>(null);
	const previewRef = useRef<HTMLDivElement>(null);

	// Auto-save 1 second after user stops typing
	const scheduleAutosave = useCallback(
		(value: string) => {
			if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
			saveTimeoutRef.current = setTimeout(async () => {
				setSaving(true);
				try {
					await fetch(`${APP_API_BASE}/sessions/${sessionId}/notes`, {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ notes: value }),
					});
					setLastSaved(new Date().toLocaleTimeString());
				} catch {}
				setSaving(false);
			}, 1000);
		},
		[sessionId],
	);

	return (
		<div className="flex flex-col h-full">
			<div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
				<div className="flex items-center gap-2">
					<span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Notes</span>
					<div className="flex items-center rounded-md border border-border p-0.5">
						<ModeButton active={mode === "edit"} label="Edit" onClick={() => setMode("edit")} />
						<ModeButton active={mode === "preview"} label="Preview" onClick={() => setMode("preview")} />
					</div>
					<ScrollJumpControls
						onTop={() => {
							if (mode === "edit") {
								editRef.current?.scrollTo({ top: 0, behavior: "smooth" });
							} else {
								previewRef.current?.scrollTo({ top: 0, behavior: "smooth" });
							}
						}}
						onBottom={() => {
							if (mode === "edit" && editRef.current) {
								editRef.current.scrollTo({
									top: editRef.current.scrollHeight,
									behavior: "smooth",
								});
							} else if (previewRef.current) {
								previewRef.current.scrollTo({
									top: previewRef.current.scrollHeight,
									behavior: "smooth",
								});
							}
						}}
					/>
				</div>
				<span className="text-[10px] text-muted-foreground">{saving ? "Saving..." : lastSaved ? `Saved ${lastSaved}` : ""}</span>
			</div>
			{mode === "edit" ? (
				<textarea
					ref={editRef}
					value={notes}
					onChange={(e) => {
						setNotes(e.target.value);
						scheduleAutosave(e.target.value);
					}}
					placeholder="Write notes about this session..."
					className="flex-1 w-full resize-none bg-transparent p-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
				/>
			) : (
				<div ref={previewRef} className="flex-1 overflow-y-auto p-3">
					{notes.trim() ? (
						<MarkdownContent content={notes} />
					) : (
						<div className="text-sm text-muted-foreground">No notes yet.</div>
					)}
				</div>
			)}
		</div>
	);
}

type TimelineMode = "prompts" | "conversation" | "progress" | "debug";

function PromptBubble({ text, time }: { text: string; time: string }) {
	return (
		<div className="flex justify-end">
			<div className="max-w-[80%]">
				<div className="rounded-2xl rounded-br-sm bg-primary/15 border border-primary/20 px-4 py-3">
					<MarkdownContent content={text} compact />
				</div>
				<p className="text-[10px] text-muted-foreground mt-1 text-right">
					{formatTimeAgo(time)}
				</p>
			</div>
		</div>
	);
}

function AssistantBubble({ text, time }: { text: string; time: string }) {
	return (
		<div className="flex justify-start">
			<div className="max-w-[80%]">
				<div className="rounded-2xl rounded-bl-sm bg-sky-500/10 border border-sky-500/20 px-4 py-3">
					<MarkdownContent content={text} compact />
				</div>
				<p className="text-[10px] text-muted-foreground mt-1">
					{formatTimeAgo(time)}
				</p>
			</div>
		</div>
	);
}

function TimelineCard({
	text,
	time,
	label,
	tone = "default",
}: {
	text: string;
	time: string;
	label: string;
	tone?: "default" | "emerald" | "amber" | "muted";
}) {
	const toneClasses = {
		default: "border-border bg-card/60",
		emerald: "border-emerald-500/20 bg-emerald-500/10",
		amber: "border-amber-500/20 bg-amber-500/10",
		muted: "border-border/70 bg-muted/30",
	};

	return (
		<div className={cn("rounded-xl border px-3 py-2.5", toneClasses[tone])}>
			<div className="flex items-center justify-between gap-3">
				<span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
				<span className="text-[10px] text-muted-foreground">{formatTimeAgo(time)}</span>
			</div>
			<div className="mt-1.5">
				<MarkdownContent content={text} compact />
			</div>
		</div>
	);
}

function ModeButton({
	active,
	label,
	onClick,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			onClick={onClick}
			className={cn(
				"rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
				active
					? "bg-primary text-primary-foreground"
					: "text-muted-foreground hover:text-foreground hover:bg-muted",
			)}
		>
			{label}
		</button>
	);
}

function FilterToggle({
	active,
	label,
	onClick,
	disabled = false,
}: {
	active: boolean;
	label: string;
	onClick: () => void;
	disabled?: boolean;
}) {
	return (
		<button
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"rounded-full border px-2.5 py-1 text-[10px] font-medium transition-colors",
				active
					? "border-primary/30 bg-primary/10 text-primary"
					: "border-border text-muted-foreground hover:text-foreground hover:bg-muted",
				disabled && "cursor-not-allowed opacity-50",
			)}
		>
			{label}
		</button>
	);
}

function buildExportMarkdown(displayName: string, session: Session, allEvents: SessionEvent[]) {
	const transcript = allEvents
		.map((event) => {
			if (event.category === "prompt" && event.content) {
				return `## Prompt\n\n${event.content}`;
			}
			if (event.category === "assistant_message" && event.content) {
				return `## Response\n\n${event.content}`;
			}
			if (
				(event.category === "progress_update" ||
					event.category === "plan_update" ||
					event.category === "status_update") &&
				event.content
			) {
				return `## Progress\n\n${event.content}`;
			}
			return null;
		})
		.filter(Boolean)
		.join("\n\n");

	return `# ${displayName}

**Project:** ${session.cwd}
**Agent:** ${session.agentType}
**Started:** ${session.startedAt}
**Tools:** ${session.totalToolUses}
${session.gitBranch ? `**Branch:** ${session.gitBranch}\n` : ""}${session.notes ? `## Notes

${session.notes}

` : ""}${transcript ? `## Timeline

${transcript}
` : ""}`;
}

function eventLabel(category: EventCategory | null): string {
	switch (category) {
		case "assistant_message":
			return "Response";
		case "progress_update":
			return "Progress";
		case "plan_update":
			return "Plan";
		case "status_update":
			return "Status";
		case "tool_event":
			return "Tool";
		case "system_event":
			return "System";
		default:
			return "Event";
	}
}

function getBaseCategories(mode: TimelineMode): Set<EventCategory> {
	switch (mode) {
		case "prompts":
			return new Set(["prompt"]);
		case "conversation":
			return new Set(["prompt", "assistant_message"]);
		case "progress":
			return new Set([
				"prompt",
				"assistant_message",
				"progress_update",
				"plan_update",
				"status_update",
				"system_event",
			]);
		case "debug":
			return new Set([
				"prompt",
				"assistant_message",
				"progress_update",
				"plan_update",
				"status_update",
				"tool_event",
				"system_event",
			]);
	}
}

function getVisibleEvents(
	allEvents: SessionEvent[],
	mode: TimelineMode,
	showTools: boolean,
	showNoisyTools: boolean,
	showSystem: boolean,
) {
	const categories = getBaseCategories(mode);
	if (showTools) categories.add("tool_event");
	if (!showSystem) categories.delete("system_event");

	return allEvents.filter((event) => {
		if (!event.category || !categories.has(event.category)) return false;
		if (event.category === "tool_event" && !showTools && mode !== "debug") return false;
		if (event.category === "tool_event" && !showNoisyTools && event.isNoise) return false;
		if (!event.content && event.category !== "tool_event") return false;
		return true;
	});
}

function eventKey(event: Pick<SessionEvent, "id" | "eventType" | "category" | "content" | "createdAt" | "providerEventType" | "rawPayload">) {
	const transcriptId =
		(typeof event.rawPayload?.transcript_uuid === "string" && event.rawPayload.transcript_uuid) ||
		(typeof event.rawPayload?.transcript_timestamp === "string" && event.rawPayload.transcript_timestamp) ||
		"";
	return [
		event.id || 0,
		event.eventType,
		event.category || "",
		event.content || "",
		event.createdAt,
		event.providerEventType || "",
		transcriptId,
	].join("::");
}

function mergeSessionEvents(baseEvents: SessionEvent[], liveEvents: SessionEvent[]) {
	const merged = new Map<string, SessionEvent>();
	for (const event of [...baseEvents, ...liveEvents]) {
		merged.set(eventKey(event), event);
	}
	return Array.from(merged.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function ClaudeMdPanel({ session, onPathChanged }: { session: Session; onPathChanged?: (path: string) => void }) {
	const [content, setContent] = useState("");
	const [filePath, setFilePath] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [saveMsg, setSaveMsg] = useState("");
	const [mode, setMode] = useState<"edit" | "preview">("edit");
	const editRef = useRef<HTMLTextAreaElement>(null);
	const previewRef = useRef<HTMLDivElement>(null);

	// Detect if we fell back to the other file
	const preferredFile = session.agentType === "codex_cli" ? "AGENTS.md" : "CLAUDE.md";
	const alternateFile = session.agentType === "codex_cli" ? "CLAUDE.md" : "AGENTS.md";
	const currentFile = filePath ? filePath.split("/").pop() || "" : "";
	const isFallback = currentFile !== "" && currentFile !== preferredFile;

	useEffect(() => {
		fetch(`${APP_API_BASE}/sessions/${session.sessionId}/claude-md`)
			.then((r) => r.json())
			.then((data) => {
				setContent(data.content || "");
				setFilePath(data.path || "");
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	}, [session.sessionId]);

	async function handleSave() {
		setSaving(true);
		try {
			await fetch(`${APP_API_BASE}/sessions/${session.sessionId}/claude-md`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content, path: filePath }),
			});
			setSaveMsg("Saved");
			setTimeout(() => setSaveMsg(""), 2000);
		} catch { setSaveMsg("Error"); }
		setSaving(false);
	}

	async function handleCreatePreferred() {
		if (!session.cwd) return;
		const newPath = session.cwd + "/" + preferredFile;
		setSaving(true);
		try {
			await fetch(`${APP_API_BASE}/sessions/${session.sessionId}/claude-md`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content, path: newPath }),
			});
			setFilePath(newPath);
			onPathChanged?.(newPath);
			setSaveMsg(`Created ${preferredFile}`);
			setTimeout(() => setSaveMsg(""), 2000);
		} catch { setSaveMsg("Error"); }
		setSaving(false);
	}

	if (loading) return <div className="p-3 text-xs text-muted-foreground">Loading...</div>;

	return (
		<div className="flex flex-col h-full">
			{/* Fallback notice */}
			{isFallback && (
				<div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center justify-between">
					<span className="text-[10px] text-amber-400">
						No {preferredFile} found -- showing {currentFile}
					</span>
					<button
						onClick={handleCreatePreferred}
						disabled={saving}
						className="text-[10px] rounded px-2 py-0.5 text-amber-400 border border-amber-500/30 hover:bg-amber-500/20 transition-colors"
					>
						Create {preferredFile}
					</button>
				</div>
			)}
			<div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
				<div className="flex items-center gap-2 min-w-0">
					<span className="text-[10px] text-muted-foreground truncate">{currentFile || "No file"}</span>
					<span className={`text-[10px] px-1.5 py-0 rounded ${
						content.length > 15000 ? "text-red-400 bg-red-500/10" :
						content.length > 8000 ? "text-amber-400 bg-amber-500/10" :
						"text-muted-foreground bg-muted/50"
					}`}>
						{(content.length / 1024).toFixed(1)}KB
					</span>
					<div className="flex items-center rounded-md border border-border p-0.5">
						<ModeButton active={mode === "edit"} label="Edit" onClick={() => setMode("edit")} />
						<ModeButton active={mode === "preview"} label="Preview" onClick={() => setMode("preview")} />
					</div>
					<ScrollJumpControls
						onTop={() => {
							if (mode === "edit") {
								editRef.current?.scrollTo({ top: 0, behavior: "smooth" });
							} else {
								previewRef.current?.scrollTo({ top: 0, behavior: "smooth" });
							}
						}}
						onBottom={() => {
							if (mode === "edit" && editRef.current) {
								editRef.current.scrollTo({
									top: editRef.current.scrollHeight,
									behavior: "smooth",
								});
							} else if (previewRef.current) {
								previewRef.current.scrollTo({
									top: previewRef.current.scrollHeight,
									behavior: "smooth",
								});
							}
						}}
					/>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-[10px] text-muted-foreground">{saveMsg}</span>
					<button
						onClick={handleSave}
						disabled={saving}
						className="text-[10px] rounded px-2 py-0.5 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
					>
						{saving ? "..." : "Save"}
					</button>
				</div>
			</div>
			{mode === "edit" ? (
				<textarea
					ref={editRef}
					value={content}
					onChange={(e) => setContent(e.target.value)}
					className="flex-1 w-full resize-none bg-transparent p-3 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none leading-relaxed"
					placeholder="No CLAUDE.md found"
				/>
			) : (
				<div ref={previewRef} className="flex-1 overflow-y-auto p-3">
					{content.trim() ? (
						<MarkdownContent content={content} />
					) : (
						<div className="text-sm text-muted-foreground">No {alternateFile} or {preferredFile} content found.</div>
					)}
				</div>
			)}
		</div>
	);
}

function RightPanel({ session }: { session: Session }) {
	const [tab, setTab] = useState<"notes" | "claudemd">("notes");
	const [mdPath, setMdPath] = useState(session.claudeMdPath || "");
	const mdLabel = mdPath
		? mdPath.split("/").pop() || "CLAUDE.md"
		: session.agentType === "codex_cli" ? "AGENTS.md" : "CLAUDE.md";

	return (
		<div className="w-full md:w-80 md:flex-shrink-0 border-t md:border-t-0 md:border-l border-border bg-card/50 flex flex-col min-h-[18rem] md:min-h-0">
			<div className="flex border-b border-border flex-shrink-0">
				<button
					onClick={() => setTab("notes")}
					className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
						tab === "notes" ? "text-foreground border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"
					}`}
				>
					Notes
				</button>
				<button
					onClick={() => setTab("claudemd")}
					className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
						tab === "claudemd" ? "text-foreground border-b-2 border-primary" : "text-muted-foreground hover:text-foreground"
					}`}
				>
					{mdLabel}
				</button>
			</div>
			<div className="flex-1 min-h-0">
				{tab === "notes" ? (
					<NotesPanel sessionId={session.sessionId} initialNotes={session.notes || ""} />
				) : (
					<ClaudeMdPanel session={session} onPathChanged={setMdPath} />
				)}
			</div>
		</div>
	);
}

function InlineRename({ sessionId, currentName, onRenamed }: { sessionId: string; currentName: string; onRenamed: (name: string) => void }) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(currentName);

	async function save() {
		if (!value.trim()) { setEditing(false); return; }
		await fetch(`${APP_API_BASE}/sessions/${sessionId}/rename`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: value.trim() }),
		});
		onRenamed(value.trim());
		setEditing(false);
	}

	if (editing) {
		return (
			<input
				autoFocus
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onBlur={save}
				onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
				className="font-mono font-bold text-sm bg-background border border-primary/30 rounded px-2.5 py-1 w-40 focus:outline-none focus:ring-1 focus:ring-primary"
			/>
		);
	}

	return (
		<span
			onClick={() => { setEditing(true); setValue(currentName); }}
			title="Click to rename"
			className="font-mono font-bold text-sm text-primary bg-primary/10 border border-primary/20 rounded px-2.5 py-1 cursor-pointer hover:bg-primary/20 transition-colors"
		>
			{currentName}
		</span>
	);
}

function CodexStatusHint({ displayName }: { displayName: string }) {
	const [copied, setCopied] = useState(false);
	const renameCommand = `/rename ${displayName}`;

	async function copyRenameCommand() {
		try {
			await navigator.clipboard.writeText(renameCommand);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {}
	}

	return (
		<div className="mx-6 mt-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-xs font-medium text-foreground">Show this name inside Codex</p>
					<p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
						Run <span className="font-mono text-foreground">{renameCommand}</span> in Codex, then enable
						{" "}<span className="font-mono text-foreground">thread-title</span> in <span className="font-mono text-foreground">/statusline</span>.
						This uses Codex&apos;s built-in status line instead of terminal-specific hacks.
					</p>
				</div>
				<button
					onClick={copyRenameCommand}
					className="flex-shrink-0 rounded border border-primary/30 px-2 py-1 text-[10px] font-medium text-primary hover:bg-primary/10 transition-colors"
				>
					{copied ? "Copied" : "Copy"}
				</button>
			</div>
		</div>
	);
}

function ManagedCodexStatus({
	managedSession,
}: {
	managedSession: NonNullable<Session["managedSession"]>;
}) {
	const syncTone =
		managedSession.providerSyncState === "synced"
			? "text-emerald-400 border-emerald-500/20 bg-emerald-500/10"
			: managedSession.providerSyncState === "failed"
				? "text-red-400 border-red-500/20 bg-red-500/10"
				: "text-amber-400 border-amber-500/20 bg-amber-500/10";

	return (
		<div className="mx-6 mt-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<p className="text-xs font-medium text-foreground">Managed Codex</p>
					<p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
						Thread title sync is managed by AgentPulse.
						{managedSession.hostName && (
							<>
								{" "}Host <span className="font-mono text-foreground">{managedSession.hostName}</span>.
							</>
						)}
						{managedSession.providerThreadId && (
							<>
								{" "}Thread <span className="font-mono text-foreground">{managedSession.providerThreadId}</span>.
							</>
						)}
					</p>
					{managedSession.providerThreadTitle && (
						<p className="mt-1 text-[11px] text-muted-foreground">
							Provider title: <span className="font-mono text-foreground">{managedSession.providerThreadTitle}</span>
						</p>
					)}
					{managedSession.providerSyncError && (
						<p className="mt-1 text-[11px] text-red-300">{managedSession.providerSyncError}</p>
					)}
				</div>
				<span className={`rounded-full border px-2 py-1 text-[10px] font-medium ${syncTone}`}>
					{managedSession.providerSyncState}
				</span>
			</div>
		</div>
	);
}

export function SessionDetailPage() {
	const { sessionId } = useParams<{ sessionId: string }>();
	const navigate = useNavigate();
	const [session, setSession] = useState<Session | null>(null);
	const [events, setEvents] = useState<SessionEvent[]>([]);
	const [controlActions, setControlActions] = useState<ControlAction[]>([]);
	const [loading, setLoading] = useState(true);
	const [mode, setMode] = useState<TimelineMode>("progress");
	const [showTools, setShowTools] = useState(false);
	const [showNoisyTools, setShowNoisyTools] = useState(false);
	const [showSystem, setShowSystem] = useState(true);
	const timelineContainerRef = useRef<HTMLDivElement>(null);
	const timelineEndRef = useRef<HTMLDivElement>(null);
	const shouldFollowTimelineRef = useRef(true);
	const previousEventCountRef = useRef(0);
	const liveEventsMap = useEventStore((s) => s.liveEvents);
	const clearLiveEvents = useEventStore((s) => s.clearSession);

	// Removed live event merging -- just use DB events with fast polling

	useEffect(() => {
		if (!sessionId) return;
		async function fetchData() {
			try {
				const data = await api.getSession(sessionId!);
				setSession(data.session as Session);
				setEvents(data.events as SessionEvent[]);
				setControlActions((data.controlActions as ControlAction[]) || []);
			} catch (err) {
				console.error("Failed to fetch session:", err);
			} finally {
				setLoading(false);
			}
		}
		fetchData();
		const interval = setInterval(fetchData, 10_000);
		return () => {
			clearInterval(interval);
			clearLiveEvents(sessionId);
		};
	}, [sessionId, clearLiveEvents]);

	const liveEvents = ((sessionId && liveEventsMap.get(sessionId)) || []) as SessionEvent[];
	const allEvents = mergeSessionEvents([...events].reverse(), liveEvents);
	const visibleEvents = getVisibleEvents(allEvents, mode, showTools || mode === "debug", showNoisyTools, showSystem);

	useEffect(() => {
		const hasNewEvents = allEvents.length > previousEventCountRef.current;
		const behavior = previousEventCountRef.current === 0 ? "auto" : "smooth";

		if (hasNewEvents && shouldFollowTimelineRef.current) {
			timelineEndRef.current?.scrollIntoView({ behavior });
		}

		previousEventCountRef.current = allEvents.length;
	}, [allEvents.length]);

	if (loading) {
		return (
			<div className="p-6">
				<div className="animate-pulse space-y-4">
					<div className="h-8 bg-muted rounded w-1/3" />
					<div className="h-4 bg-muted rounded w-1/2" />
					<div className="h-64 bg-muted rounded" />
				</div>
			</div>
		);
	}

	if (!session) {
		return (
			<div className="p-6 text-center text-muted-foreground">
				<p>Session not found</p>
				<button onClick={() => navigate("/")} className="mt-2 text-primary hover:underline text-sm">
					Back to dashboard
				</button>
			</div>
		);
	}

	const displayName = session.displayName || session.sessionId.slice(0, 8);
	const canStop = session.agentType === "codex_cli" && session.managedSession?.managedState === "managed";

	async function handleStop() {
		if (!sessionId) return;
		try {
			await api.stopSession(sessionId);
			const data = await api.getSession(sessionId);
			setSession(data.session as Session);
			setEvents(data.events as SessionEvent[]);
			setControlActions((data.controlActions as ControlAction[]) || []);
		} catch (error) {
			console.error("Failed to stop session:", error);
		}
	}

	function handleTimelineScroll() {
		const container = timelineContainerRef.current;
		if (!container) return;

		const distanceFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		shouldFollowTimelineRef.current = distanceFromBottom < 96;
	}

	function jumpTimelineTop() {
		timelineContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
		shouldFollowTimelineRef.current = false;
	}

	function jumpTimelineBottom() {
		timelineContainerRef.current?.scrollTo({
			top: timelineContainerRef.current.scrollHeight,
			behavior: "smooth",
		});
		shouldFollowTimelineRef.current = true;
	}

	return (
		<div className="flex flex-col h-full">
			{/* Sticky session name bar */}
			<div className="sticky top-0 z-10 bg-background border-b border-border flex-shrink-0">
				<div className="px-3 md:px-6 py-2.5 flex flex-wrap items-center gap-2 md:gap-3">
					<button
						onClick={() => navigate("/")}
						className="text-muted-foreground hover:text-foreground transition-colors"
					>
						<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
						</svg>
					</button>
					<InlineRename
						sessionId={session.sessionId}
						currentName={displayName}
						onRenamed={(name) => setSession({ ...session, displayName: name })}
					/>
					{session.isWorking && (
						<span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">
							<span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
							working
						</span>
					)}
					<span className="text-xs text-muted-foreground truncate">
						{session.cwd?.split("/").pop()}
					</span>
					<span className="text-xs text-muted-foreground">
						{formatDuration(session.startedAt)}
					</span>
					{session.gitBranch && (
						<span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded px-1.5 py-0.5">
							{session.gitBranch}
						</span>
					)}
					<div className="flex items-center gap-2 md:ml-auto">
						<ScrollJumpControls onTop={jumpTimelineTop} onBottom={jumpTimelineBottom} />
						{canStop && (
							<button
								onClick={handleStop}
								className="rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/20 transition-colors"
							>
								Stop
							</button>
						)}
						<button
							onClick={(e) => {
								e.stopPropagation();
								navigator.clipboard.writeText(buildExportMarkdown(displayName, session, allEvents));
							}}
							title="Export as Markdown"
							className="rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
						>
							<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
							</svg>
						</button>
						<span className="text-xs text-muted-foreground">{session.totalToolUses} tools</span>
						<AgentTypeBadge agentType={session.agentType} />
						<StatusBadge status={session.status} />
					</div>
				</div>
				<div className="px-3 md:px-6 py-2 border-t border-border/70 flex flex-col items-start gap-2 md:flex-row md:flex-wrap md:items-center md:justify-between md:gap-3">
					<div className="flex flex-wrap items-center gap-2">
						<ModeButton active={mode === "prompts"} label="Prompts" onClick={() => setMode("prompts")} />
						<ModeButton active={mode === "conversation"} label="Conversation" onClick={() => setMode("conversation")} />
						<ModeButton active={mode === "progress"} label="Progress" onClick={() => setMode("progress")} />
						<ModeButton active={mode === "debug"} label="Debug" onClick={() => setMode("debug")} />
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<FilterToggle
							active={showSystem}
							label="System"
							onClick={() => setShowSystem((value) => !value)}
							disabled={mode === "prompts" || mode === "conversation"}
						/>
						<FilterToggle
							active={showTools || mode === "debug"}
							label="Tools"
							onClick={() => setShowTools((value) => !value)}
						/>
						<FilterToggle
							active={showNoisyTools}
							label="Noisy"
							onClick={() => setShowNoisyTools((value) => !value)}
							disabled={!(showTools || mode === "debug")}
						/>
					</div>
				</div>
			</div>

			{session.agentType === "codex_cli" && session.managedSession ? (
				<ManagedCodexStatus managedSession={session.managedSession} />
			) : session.agentType === "codex_cli" ? (
				<CodexStatusHint displayName={displayName} />
			) : null}

			{controlActions.length > 0 && (
				<div className="mx-6 mt-3 rounded-lg border border-border bg-card px-3 py-2.5">
					<div className="text-xs font-medium text-foreground">Control History</div>
					<div className="mt-2 space-y-1.5">
						{controlActions.slice(-5).reverse().map((action) => (
							<div key={action.id} className="flex items-center justify-between gap-3 text-[11px]">
								<span className="text-muted-foreground">
									{action.actionType}
									{action.error ? `: ${action.error}` : ""}
								</span>
								<span className="font-mono text-foreground">{action.status}</span>
							</div>
						))}
					</div>
				</div>
			)}

			{/* Main content: timeline + notes side by side */}
			<div className="flex-1 flex min-h-0 flex-col md:flex-row">
				{/* Timeline (left) */}
				<div
					ref={timelineContainerRef}
					onScroll={handleTimelineScroll}
					className="flex-1 overflow-auto p-3 md:p-6"
				>
					<div className="space-y-3">
						{visibleEvents.length === 0 ? (
							<p className="text-sm text-muted-foreground text-center py-8">
								No events match this view yet.
							</p>
						) : (
							visibleEvents.map((event) => {
								if (event.category === "prompt" && event.content) {
									return <PromptBubble key={eventKey(event)} text={event.content} time={event.createdAt} />;
								}
								if (event.category === "assistant_message" && event.content) {
									return <AssistantBubble key={eventKey(event)} text={event.content} time={event.createdAt} />;
								}
								if (event.category === "tool_event") {
									const detail = event.content || event.toolName || event.eventType;
									return (
										<TimelineCard
											key={eventKey(event)}
											label={eventLabel(event.category)}
											text={detail}
											time={event.createdAt}
											tone={event.isNoise ? "muted" : "amber"}
										/>
									);
								}
								if (!event.content) return null;
								return (
									<TimelineCard
										key={eventKey(event)}
										label={eventLabel(event.category)}
										text={event.content}
										time={event.createdAt}
										tone={event.category === "status_update" ? "emerald" : "default"}
									/>
								);
							})
						)}
						<div ref={timelineEndRef} />
					</div>
				</div>

				{/* Right panel: Notes / CLAUDE.md tabs */}
				<RightPanel session={session} />
			</div>
		</div>
	);
}
