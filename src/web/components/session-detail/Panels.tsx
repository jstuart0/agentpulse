import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { LaunchRequest, Session } from "../../../shared/types.js";
import { api } from "../../lib/api.js";
import { MarkdownContent } from "../MarkdownContent.js";
import { formatTimeAgo } from "../../lib/utils.js";
import { ModeButton, ScrollJumpControls } from "./SharedControls.js";

export function NotesPanel({ sessionId, initialNotes }: { sessionId: string; initialNotes: string }) {
	const [notes, setNotes] = useState(initialNotes);
	const [saving, setSaving] = useState(false);
	const [lastSaved, setLastSaved] = useState<string | null>(null);
	const [mode, setMode] = useState<"edit" | "preview">("edit");
	const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
	const editRef = useRef<HTMLTextAreaElement>(null);
	const previewRef = useRef<HTMLDivElement>(null);

	const scheduleAutosave = useCallback(
		(value: string) => {
			if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
			saveTimeoutRef.current = setTimeout(async () => {
				setSaving(true);
				try {
					await api.saveSessionNotes(sessionId, value);
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
						onTop={() => (mode === "edit" ? editRef.current?.scrollTo({ top: 0, behavior: "smooth" }) : previewRef.current?.scrollTo({ top: 0, behavior: "smooth" }))}
						onBottom={() => {
							if (mode === "edit" && editRef.current) {
								editRef.current.scrollTo({ top: editRef.current.scrollHeight, behavior: "smooth" });
							} else if (previewRef.current) {
								previewRef.current.scrollTo({ top: previewRef.current.scrollHeight, behavior: "smooth" });
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
					{notes.trim() ? <MarkdownContent content={notes} /> : <div className="text-sm text-muted-foreground">No notes yet.</div>}
				</div>
			)}
		</div>
	);
}

export function ClaudeMdPanel({ session, onPathChanged }: { session: Session; onPathChanged?: (path: string) => void }) {
	const [content, setContent] = useState("");
	const [filePath, setFilePath] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [saveMsg, setSaveMsg] = useState("");
	const [mode, setMode] = useState<"edit" | "preview">("edit");
	const editRef = useRef<HTMLTextAreaElement>(null);
	const previewRef = useRef<HTMLDivElement>(null);

	const preferredFile = session.agentType === "codex_cli" ? "AGENTS.md" : "CLAUDE.md";
	const alternateFile = session.agentType === "codex_cli" ? "CLAUDE.md" : "AGENTS.md";
	const currentFile = filePath ? filePath.split("/").pop() || "" : "";
	const isFallback = currentFile !== "" && currentFile !== preferredFile;

	useEffect(() => {
		api
			.getSessionInstructions(session.sessionId)
			.then((data) => {
				setContent(data.content || "");
				setFilePath(data.path || "");
			})
			.catch(() => {})
			.finally(() => setLoading(false));
	}, [session.sessionId]);

	async function handleSave(path = filePath, message = "Saved") {
		setSaving(true);
		try {
			await api.saveSessionInstructions(session.sessionId, { content, path });
			if (path !== filePath) {
				setFilePath(path);
				onPathChanged?.(path);
			}
			setSaveMsg(message);
			setTimeout(() => setSaveMsg(""), 2000);
		} catch {
			setSaveMsg("Error");
		}
		setSaving(false);
	}

	if (loading) return <div className="p-3 text-xs text-muted-foreground">Loading...</div>;

	return (
		<div className="flex flex-col h-full">
			{isFallback && (
				<div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center justify-between">
					<span className="text-[10px] text-amber-400">No {preferredFile} found -- showing {currentFile}</span>
					<button
						onClick={() => {
							if (!session.cwd) return;
							void handleSave(`${session.cwd}/${preferredFile}`, `Created ${preferredFile}`);
						}}
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
						onTop={() => (mode === "edit" ? editRef.current?.scrollTo({ top: 0, behavior: "smooth" }) : previewRef.current?.scrollTo({ top: 0, behavior: "smooth" }))}
						onBottom={() => {
							if (mode === "edit" && editRef.current) {
								editRef.current.scrollTo({ top: editRef.current.scrollHeight, behavior: "smooth" });
							} else if (previewRef.current) {
								previewRef.current.scrollTo({ top: previewRef.current.scrollHeight, behavior: "smooth" });
							}
						}}
					/>
				</div>
				<div className="flex items-center gap-2">
					<span className="text-[10px] text-muted-foreground">{saveMsg}</span>
					<button
						onClick={() => void handleSave()}
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

export function SummaryField({ label, value, mono = false }: { label: string; value: string | null | undefined; mono?: boolean }) {
	if (!value) return null;
	return (
		<div className="rounded-md border border-border bg-background/60 p-3">
			<div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
			<div className={`mt-1 text-sm text-foreground ${mono ? "font-mono break-all text-xs" : ""}`}>{value}</div>
		</div>
	);
}

export function EmbeddedLaunchPanel({ launchId }: { launchId: string }) {
	const [launch, setLaunch] = useState<LaunchRequest | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		async function load() {
			try {
				const data = await api.getLaunch(launchId);
				if (!cancelled) setLaunch(data.launchRequest);
			} catch (error) {
				console.error("Failed to load linked launch", error);
			} finally {
				if (!cancelled) setLoading(false);
			}
		}
		load();
		const interval = setInterval(load, 2000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [launchId]);

	if (loading) return <div className="p-4 text-sm text-muted-foreground">Loading launch…</div>;
	if (!launch) return <div className="p-4 text-sm text-muted-foreground">Linked launch not found.</div>;

	const modeLabel =
		launch.requestedLaunchMode === "headless"
			? "Headless task"
			: launch.requestedLaunchMode === "interactive_terminal"
				? "Interactive terminal"
				: "Managed Codex";
	const output = launch.providerLaunchMetadata?.output as
		| {
				assistantPreview?: string;
				stderrPreview?: string;
				activity?: Array<{ kind: string; text: string; timestamp: string }>;
		  }
		| undefined;

	return (
		<div className="space-y-4 p-3 md:p-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<div className="text-sm font-semibold text-foreground">Launch</div>
					<div className="mt-1 text-xs text-muted-foreground">{launch.status} · {modeLabel}</div>
				</div>
				<Link to={`/launches/${launch.id}`} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent transition-colors">
					Open full launch detail
				</Link>
			</div>

			<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
				<SummaryField label="Created" value={launch.createdAt} />
				<SummaryField label="Host" value={launch.resolvedSupervisorId} mono />
				<SummaryField label="PID" value={launch.pid != null ? String(launch.pid) : null} mono />
				<SummaryField label="Validation" value={launch.validationSummary} />
			</div>

			{launch.error ? (
				<div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-sm text-red-200">{launch.error}</div>
			) : null}

			{output ? (
				<div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
					<div className="rounded-lg border border-border bg-card p-4">
						<div className="text-sm font-semibold text-foreground">Visible output</div>
						<pre className="mt-3 min-h-40 overflow-x-auto rounded-md bg-background/60 p-3 text-xs text-foreground whitespace-pre-wrap break-words">
							{output.assistantPreview?.trim() || "Waiting for visible output…"}
						</pre>
						{output.stderrPreview?.trim() ? (
							<pre className="mt-3 overflow-x-auto rounded-md bg-red-500/5 p-3 text-xs text-red-200 whitespace-pre-wrap break-words">
								{output.stderrPreview}
							</pre>
						) : null}
					</div>
					<div className="rounded-lg border border-border bg-card p-4">
						<div className="text-sm font-semibold text-foreground">Recent activity</div>
						<div className="mt-3 space-y-2">
							{output.activity?.length ? (
								output.activity.map((entry, index) => (
									<div key={`${entry.timestamp}-${index}`} className="rounded-md bg-background/60 p-3">
										<div className="text-[10px] uppercase tracking-wide text-muted-foreground">{entry.kind}</div>
										<div className="mt-1 whitespace-pre-wrap break-words text-xs text-foreground">{entry.text}</div>
									</div>
								))
							) : (
								<div className="text-sm text-muted-foreground">No activity yet.</div>
							)}
						</div>
					</div>
				</div>
			) : (
				<div className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
					{launch.requestedLaunchMode === "interactive_terminal"
						? "This launch opened on the selected host terminal. Use that terminal to drive the session while AgentPulse observes it here."
						: "No provider output captured yet."}
				</div>
			)}
		</div>
	);
}

