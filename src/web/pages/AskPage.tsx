import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { MarkdownContent } from "../components/MarkdownContent.js";
import {
	type AskMessage,
	type AskThread,
	api,
	looksLikeAuthBounce,
	triggerAuthReload,
} from "../lib/api.js";
import { APP_API_BASE } from "../lib/paths.js";

/**
 * Global Ask chat. Left column: thread list. Right column: messages for
 * the selected thread + composer. The composer stays enabled while a
 * reply is in flight — sending a second message will just queue after
 * the assistant message lands (one turn at a time).
 */

export function AskPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const activeThreadId = searchParams.get("thread");
	const [threads, setThreads] = useState<AskThread[]>([]);
	const [messages, setMessages] = useState<AskMessage[]>([]);
	const [loadingThreads, setLoadingThreads] = useState(true);
	const [loadingMessages, setLoadingMessages] = useState(false);
	const [sending, setSending] = useState(false);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState<string | null>(null);
	const scrollerRef = useRef<HTMLDivElement>(null);
	// Telegram-origin threads are view-only on the web — answers delivered
	// back through Telegram, not the HTTP response. Track the active
	// thread's origin so we can gate the composer.
	const [activeThreadOrigin, setActiveThreadOrigin] = useState<"web" | "telegram" | null>(null);

	const reloadThreads = useCallback(async () => {
		try {
			const res = await api.getAskThreads();
			setThreads(res.threads);
			setLoadingThreads(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setLoadingThreads(false);
		}
	}, []);

	useEffect(() => {
		void reloadThreads();
	}, [reloadThreads]);

	useEffect(() => {
		if (!activeThreadId) {
			setMessages([]);
			setActiveThreadOrigin(null);
			return;
		}
		let cancelled = false;
		setLoadingMessages(true);
		api
			.getAskThread(activeThreadId)
			.then((res) => {
				if (cancelled) return;
				setMessages(res.messages);
				setActiveThreadOrigin(res.thread.origin);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoadingMessages(false);
			});
		return () => {
			cancelled = true;
		};
	}, [activeThreadId]);

	useEffect(() => {
		// Auto-scroll to newest message on content change.
		const el = scrollerRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages.length, sending]);

	function selectThread(id: string | null) {
		if (id) setSearchParams({ thread: id });
		else setSearchParams({});
	}

	async function handleNewThread() {
		selectThread(null);
		setMessages([]);
		setDraft("");
		setError(null);
	}

	async function handleDelete(id: string) {
		if (!confirm("Delete this conversation?")) return;
		try {
			await api.deleteAskThread(id);
			if (activeThreadId === id) selectThread(null);
			await reloadThreads();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function handleSend(e?: React.FormEvent) {
		e?.preventDefault();
		const text = draft.trim();
		if (!text || sending) return;
		setSending(true);
		setError(null);
		const optimisticUserId = `pending-user-${Date.now()}`;
		const optimisticAssistantId = `pending-assistant-${Date.now()}`;
		const optimisticUser: AskMessage = {
			id: optimisticUserId,
			threadId: activeThreadId ?? "pending",
			role: "user",
			content: text,
			contextSessionIds: null,
			tokensIn: null,
			tokensOut: null,
			errorMessage: null,
			createdAt: new Date().toISOString(),
		};
		const optimisticAssistant: AskMessage = {
			id: optimisticAssistantId,
			threadId: activeThreadId ?? "pending",
			role: "assistant",
			content: "",
			contextSessionIds: null,
			tokensIn: null,
			tokensOut: null,
			errorMessage: null,
			createdAt: new Date().toISOString(),
		};
		setMessages((prev) => [...prev, optimisticUser, optimisticAssistant]);
		setDraft("");

		try {
			let res: Response;
			try {
				res = await fetch(`${APP_API_BASE}/ai/ask/stream`, {
					method: "POST",
					credentials: "same-origin",
					redirect: "manual",
					headers: {
						"Content-Type": "application/json",
						Accept: "text/event-stream",
					},
					body: JSON.stringify({
						threadId: activeThreadId,
						message: text,
					}),
				});
			} catch (err) {
				if (err instanceof TypeError) {
					triggerAuthReload(`ask-stream fetch threw (${err.message})`);
				}
				throw err;
			}
			if (looksLikeAuthBounce(res)) {
				triggerAuthReload("ask-stream auth-bounce");
				throw new Error("Session expired; reloading to reauthenticate.");
			}
			if (!res.ok || !res.body) {
				const bodyText = await res.text().catch(() => "");
				throw new Error(bodyText || `HTTP ${res.status}`);
			}
			await consumeAskStream(res.body, {
				onStart: (evt) => {
					if (!activeThreadId) selectThread(evt.thread.id);
					setMessages((prev) =>
						prev.map((m) => {
							if (m.id === optimisticUserId) return evt.userMessage;
							if (m.id === optimisticAssistantId) {
								return { ...m, contextSessionIds: evt.includedSessionIds };
							}
							return m;
						}),
					);
				},
				onDelta: (delta) => {
					setMessages((prev) =>
						prev.map((m) =>
							m.id === optimisticAssistantId
								? { ...m, content: (m.content ?? "") + delta }
								: m,
						),
					);
				},
				onDone: (finalMsg) => {
					setMessages((prev) =>
						prev.map((m) => (m.id === optimisticAssistantId ? finalMsg : m)),
					);
				},
				onError: (message, finalMsg) => {
					setError(message);
					if (finalMsg) {
						setMessages((prev) =>
							prev.map((m) => (m.id === optimisticAssistantId ? finalMsg : m)),
						);
					} else {
						setMessages((prev) => prev.filter((m) => m.id !== optimisticAssistantId));
					}
				},
			});
			await reloadThreads();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// Surface the specific browser error so a generic "failed to
			// fetch" at least hints what went wrong (check /ai/ask/stream
			// in the Network panel for the real response).
			setError(
				msg === "Failed to fetch"
					? "Failed to fetch — the stream endpoint didn't respond. Check browser devtools → Network → /ai/ask/stream for details."
					: msg,
			);
			setMessages((prev) =>
				prev.filter((m) => m.id !== optimisticUserId && m.id !== optimisticAssistantId),
			);
		} finally {
			setSending(false);
		}
	}

	return (
		<div className="flex h-full min-h-0">
			{/* Thread sidebar */}
			<aside className="hidden md:flex w-60 flex-shrink-0 flex-col border-r border-border bg-card/30">
				<div className="p-3 border-b border-border">
					<button
						type="button"
						onClick={handleNewThread}
						className="w-full rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
					>
						New conversation
					</button>
				</div>
				<div className="flex-1 overflow-y-auto">
					{loadingThreads ? (
						<div className="p-3 text-xs text-muted-foreground">Loading…</div>
					) : threads.length === 0 ? (
						<div className="p-3 text-xs text-muted-foreground">
							No conversations yet. Ask a question to start.
						</div>
					) : (
						<ul>
							{threads.map((t) => (
								<li key={t.id}>
									<button
										type="button"
										onClick={() => selectThread(t.id)}
										className={`w-full text-left px-3 py-2 text-xs hover:bg-muted ${
											t.id === activeThreadId ? "bg-muted text-foreground" : "text-muted-foreground"
										}`}
									>
										<div className="flex items-center gap-1.5 min-w-0">
											<span className="truncate flex-1">{t.title || "Untitled"}</span>
											{t.origin === "telegram" && (
												<span className="shrink-0 text-[9px] rounded bg-sky-500/15 text-sky-300 border border-sky-500/30 px-1 py-0.5 uppercase tracking-wider">
													Telegram
												</span>
											)}
										</div>
										<div className="text-[10px] text-muted-foreground/70 mt-0.5 flex items-center justify-between">
											<span>{relTime(t.updatedAt)}</span>
											<button
												type="button"
												onClick={(e) => {
													e.stopPropagation();
													void handleDelete(t.id);
												}}
												className="text-muted-foreground/50 hover:text-red-300"
											>
												delete
											</button>
										</div>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			</aside>

			{/* Conversation column */}
			<div className="flex-1 flex flex-col min-w-0">
				<div className="px-4 py-3 border-b border-border flex items-center justify-between">
					<div>
						<h1 className="text-sm font-semibold text-foreground">Ask</h1>
						<p className="text-[11px] text-muted-foreground">
							Chat about your running sessions. Uses the default LLM provider configured in Settings
							→ AI.
						</p>
					</div>
				</div>

				<div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
					{!activeThreadId && messages.length === 0 && <WelcomeHints onPick={(q) => setDraft(q)} />}
					{loadingMessages && (
						<div className="text-xs text-muted-foreground">Loading messages…</div>
					)}
					{messages.map((m) => (
						<MessageBubble key={m.id} msg={m} />
					))}
					{error && (
						<div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-200">
							{error}
						</div>
					)}
				</div>

				{activeThreadOrigin === "telegram" && (
					<div className="border-t border-border px-4 py-2 text-[11px] text-sky-300 bg-sky-500/5">
						This thread lives in Telegram. Reply from your DM with the bot — answers are only
						delivered back through the channel they came from.
					</div>
				)}
				<form onSubmit={handleSend} className="border-t border-border p-3 flex items-end gap-2">
					<textarea
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void handleSend();
							}
						}}
						placeholder={
							activeThreadOrigin === "telegram"
								? "Reply from Telegram — this thread is read-only on the web."
								: "Ask about a session (Enter to send, Shift+Enter for newline)"
						}
						rows={2}
						disabled={activeThreadOrigin === "telegram"}
						className="flex-1 min-w-0 resize-y rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60 disabled:cursor-not-allowed"
					/>
					<button
						type="submit"
						disabled={sending || !draft.trim() || activeThreadOrigin === "telegram"}
						className="rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
					>
						{sending ? "Sending…" : "Send"}
					</button>
				</form>
			</div>
		</div>
	);
}

function WelcomeHints({ onPick }: { onPick: (q: string) => void }) {
	const hints = [
		"Which session is working on AgentPulse right now?",
		"Any sessions stuck or needing my attention?",
		"Summarize what my agents did today.",
		"What's the last thing the watcher proposed?",
	];
	return (
		<div className="rounded-lg border border-border bg-card/40 p-4 text-xs space-y-3 max-w-xl">
			<div className="text-foreground font-semibold">Ask anything about your sessions</div>
			<p className="text-muted-foreground">
				Ask uses your configured LLM to answer questions about the live state of your agents. Try
				one of these to get started:
			</p>
			<ul className="space-y-1.5">
				{hints.map((h) => (
					<li key={h}>
						<button
							type="button"
							onClick={() => onPick(h)}
							className="text-left text-primary hover:underline"
						>
							{h}
						</button>
					</li>
				))}
			</ul>
			<p className="text-[11px] text-muted-foreground">
				Responses are grounded in the resolver's pick of your most relevant sessions — the assistant
				won't invent sessions it doesn't see.
			</p>
		</div>
	);
}

function MessageBubble({ msg }: { msg: AskMessage }) {
	const isUser = msg.role === "user";
	return (
		<div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
			<div
				className={`max-w-[85%] rounded-lg px-3 py-2 text-xs ${
					isUser ? "whitespace-pre-wrap" : ""
				} ${
					isUser
						? "bg-primary/15 text-primary-foreground/90 border border-primary/30"
						: msg.errorMessage
							? "bg-red-500/10 text-red-200 border border-red-500/30"
							: "bg-card border border-border text-foreground"
				}`}
			>
				{isUser ? (
					<div>{msg.content}</div>
				) : msg.content ? (
					// Render assistant replies as markdown — Qwen/Claude/etc.
					// emit headers, lists, inline code, fenced blocks, etc. that
					// would otherwise show as raw syntax in a plain <div>.
					<MarkdownContent content={msg.content} className="text-xs" compact />
				) : (
					<span className="inline-flex items-center gap-2 text-muted-foreground">
						<span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
						Thinking…
					</span>
				)}
				{msg.errorMessage && (
					<div className="mt-1 text-[10px] text-red-300/80">Details: {msg.errorMessage}</div>
				)}
				{!isUser && msg.contextSessionIds && msg.contextSessionIds.length > 0 && (
					<div className="mt-2 flex flex-wrap gap-1">
						{msg.contextSessionIds.map((id) => (
							<Link
								key={id}
								to={`/sessions/${id}`}
								className="text-[10px] rounded border border-border bg-background/60 px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
							>
								{id.slice(0, 8)}
							</Link>
						))}
					</div>
				)}
				<div className="mt-1 text-[10px] text-muted-foreground/60">
					{new Date(msg.createdAt).toLocaleTimeString()}
				</div>
			</div>
		</div>
	);
}

async function consumeAskStream(
	body: ReadableStream<Uint8Array>,
	handlers: {
		onStart: (evt: {
			thread: AskThread;
			userMessage: AskMessage;
			includedSessionIds: string[];
		}) => void;
		onDelta: (delta: string) => void;
		onDone: (message: AskMessage) => void;
		onError: (message: string, finalMessage: AskMessage | null) => void;
	},
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep = buffer.indexOf("\n\n");
			while (sep !== -1) {
				const frame = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				sep = buffer.indexOf("\n\n");
				for (const line of frame.split("\n")) {
					if (!line.startsWith("data:")) continue;
					const payload = line.slice(5).trim();
					if (!payload) continue;
					let evt: Record<string, unknown>;
					try {
						evt = JSON.parse(payload);
					} catch {
						continue;
					}
					const kind = evt.kind as string | undefined;
					if (kind === "start") {
						handlers.onStart({
							thread: evt.thread as AskThread,
							userMessage: evt.userMessage as AskMessage,
							includedSessionIds: (evt.includedSessionIds as string[]) ?? [],
						});
					} else if (kind === "delta") {
						handlers.onDelta((evt.delta as string) ?? "");
					} else if (kind === "done") {
						handlers.onDone(evt.assistantMessage as AskMessage);
					} else if (kind === "error") {
						handlers.onError(
							(evt.message as string) ?? "stream error",
							(evt.assistantMessage as AskMessage | null) ?? null,
						);
					}
				}
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Reader already released — ignore.
		}
	}
}

function relTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const m = Math.floor(diff / 60000);
	if (m < 1) return "just now";
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}
