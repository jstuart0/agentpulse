import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { StatusBadge } from "../components/StatusBadge.js";
import { AgentTypeBadge } from "../components/AgentTypeBadge.js";
import { formatDuration, formatTimeAgo } from "../lib/utils.js";
import { api } from "../lib/api.js";
import type { Session, SessionEvent } from "../../shared/types.js";

function NotesPanel({ sessionId, initialNotes }: { sessionId: string; initialNotes: string }) {
	const [notes, setNotes] = useState(initialNotes);
	const [saving, setSaving] = useState(false);
	const [lastSaved, setLastSaved] = useState<string | null>(null);
	const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

	// Auto-save 1 second after user stops typing
	const scheduleAutosave = useCallback(
		(value: string) => {
			if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
			saveTimeoutRef.current = setTimeout(async () => {
				setSaving(true);
				try {
					await fetch(`/api/v1/sessions/${sessionId}/notes`, {
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
				<span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Notes</span>
				<span className="text-[10px] text-muted-foreground">
					{saving ? "Saving..." : lastSaved ? `Saved ${lastSaved}` : ""}
				</span>
			</div>
			<textarea
				value={notes}
				onChange={(e) => {
					setNotes(e.target.value);
					scheduleAutosave(e.target.value);
				}}
				placeholder="Write notes about this session..."
				className="flex-1 w-full resize-none bg-transparent p-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
			/>
		</div>
	);
}

function extractPrompt(event: SessionEvent): string | null {
	if (event.eventType === "UserPromptSubmit") {
		const raw = event.rawPayload as Record<string, unknown>;
		if (typeof raw?.prompt === "string") return raw.prompt;
	}
	return null;
}

function PromptBubble({ text, time }: { text: string; time: string }) {
	return (
		<div className="flex justify-end">
			<div className="max-w-[80%]">
				<div className="rounded-2xl rounded-br-sm bg-primary/15 border border-primary/20 px-4 py-3">
					<p className="text-sm text-foreground whitespace-pre-wrap">{text}</p>
				</div>
				<p className="text-[10px] text-muted-foreground mt-1 text-right">
					{formatTimeAgo(time)}
				</p>
			</div>
		</div>
	);
}

function ClaudeMdPanel({ cwd }: { cwd: string | null }) {
	const [content, setContent] = useState("");
	const [filePath, setFilePath] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [saveMsg, setSaveMsg] = useState("");

	useEffect(() => {
		if (!cwd) { setLoading(false); return; }
		fetch(`/api/v1/agents-md?path=${encodeURIComponent(cwd)}`)
			.then((r) => r.json())
			.then((data) => {
				const file = data.files?.find((f: { exists: boolean }) => f.exists) || data.files?.[0];
				if (file) {
					setContent(file.content || "");
					setFilePath(file.path);
				}
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	}, [cwd]);

	async function handleSave() {
		if (!filePath) return;
		setSaving(true);
		try {
			await fetch("/api/v1/agents-md", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: filePath, content }),
			});
			setSaveMsg("Saved");
			setTimeout(() => setSaveMsg(""), 2000);
		} catch { setSaveMsg("Error"); }
		setSaving(false);
	}

	if (loading) return <div className="p-3 text-xs text-muted-foreground">Loading...</div>;
	if (!cwd) return <div className="p-3 text-xs text-muted-foreground">No project path</div>;

	return (
		<div className="flex flex-col h-full">
			<div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
				<span className="text-[10px] text-muted-foreground truncate">{filePath.split("/").pop()}</span>
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
			<textarea
				value={content}
				onChange={(e) => setContent(e.target.value)}
				className="flex-1 w-full resize-none bg-transparent p-3 text-xs font-mono text-foreground placeholder:text-muted-foreground/50 focus:outline-none leading-relaxed"
				placeholder="No CLAUDE.md found"
			/>
		</div>
	);
}

function RightPanel({ session }: { session: Session }) {
	const [tab, setTab] = useState<"notes" | "claudemd">("notes");

	return (
		<div className="w-80 flex-shrink-0 border-l border-border bg-card/50 flex flex-col">
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
					CLAUDE.md
				</button>
			</div>
			<div className="flex-1 min-h-0">
				{tab === "notes" ? (
					<NotesPanel sessionId={session.sessionId} initialNotes={session.notes || ""} />
				) : (
					<ClaudeMdPanel cwd={session.cwd} />
				)}
			</div>
		</div>
	);
}

export function SessionDetailPage() {
	const { sessionId } = useParams<{ sessionId: string }>();
	const navigate = useNavigate();
	const [session, setSession] = useState<Session | null>(null);
	const [events, setEvents] = useState<SessionEvent[]>([]);
	const [loading, setLoading] = useState(true);
	const timelineEndRef = useRef<HTMLDivElement>(null);

	// Removed live event merging -- just use DB events with fast polling

	useEffect(() => {
		if (!sessionId) return;
		async function fetchData() {
			try {
				const data = await api.getSession(sessionId!);
				setSession(data.session as Session);
				setEvents(data.events as SessionEvent[]);
			} catch (err) {
				console.error("Failed to fetch session:", err);
			} finally {
				setLoading(false);
			}
		}
		fetchData();
		const interval = setInterval(fetchData, 3_000); // Fast refresh for near-realtime
		return () => clearInterval(interval);
	}, [sessionId]);

	useEffect(() => {
		timelineEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [events.length]);

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

	// Server already filters to UserPromptSubmit only -- just reverse to chronological
	const allEvents = [...events].reverse();

	return (
		<div className="flex flex-col h-full">
			{/* Sticky session name bar */}
			<div className="sticky top-0 z-10 bg-background border-b border-border px-6 py-2.5 flex items-center gap-3 flex-shrink-0">
				<button
					onClick={() => navigate("/")}
					className="text-muted-foreground hover:text-foreground transition-colors"
				>
					<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
					</svg>
				</button>
				<span className="font-mono font-bold text-sm text-primary bg-primary/10 border border-primary/20 rounded px-2.5 py-1">
					{displayName}
				</span>
				<span className="text-xs text-muted-foreground truncate">
					{session.cwd?.split("/").pop()}
				</span>
				<span className="text-xs text-muted-foreground">
					{formatDuration(session.startedAt)}
				</span>
				<div className="ml-auto flex items-center gap-2">
					<span className="text-xs text-muted-foreground">{session.totalToolUses} tools</span>
					<AgentTypeBadge agentType={session.agentType} />
					<StatusBadge status={session.status} />
				</div>
			</div>

			{/* Main content: timeline + notes side by side */}
			<div className="flex-1 flex min-h-0">
				{/* Timeline (left) */}
				<div className="flex-1 overflow-auto p-6">
					<div className="space-y-3">
						{allEvents.length === 0 ? (
							<p className="text-sm text-muted-foreground text-center py-8">
								Waiting for events...
							</p>
						) : (
							allEvents.map((event) => {
								const prompt = extractPrompt(event);
								if (!prompt) return null;
								return <PromptBubble key={event.id} text={prompt} time={event.createdAt} />;
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
