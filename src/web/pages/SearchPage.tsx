import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api.js";

/**
 * Global search across session metadata + event content.
 *
 * URL state: `?q=…&…` — filters are in the URL so a search result page
 * is shareable and refresh-safe. The page listens to `?q=` changes and
 * re-runs the query automatically.
 */

type Hit = Awaited<ReturnType<typeof api.search>>["hits"][number];

export function SearchPage() {
	const [params, setParams] = useSearchParams();
	const q = params.get("q") ?? "";
	const agentType = params.get("agentType") ?? "";
	const sessionStatus = params.get("sessionStatus") ?? "";
	const eventType = params.get("eventType") ?? "";
	const cwd = params.get("cwd") ?? "";
	const kinds = params.get("kinds") ?? "";

	const [hits, setHits] = useState<Hit[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [draft, setDraft] = useState(q);

	useEffect(() => {
		setDraft(q);
	}, [q]);

	useEffect(() => {
		if (!q.trim()) {
			setHits([]);
			setTotal(0);
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(null);
		api
			.search({
				q,
				agentType: agentType === "claude_code" || agentType === "codex_cli" ? agentType : undefined,
				sessionStatus:
					sessionStatus === "active" ||
					sessionStatus === "idle" ||
					sessionStatus === "completed" ||
					sessionStatus === "archived"
						? sessionStatus
						: undefined,
				eventType: eventType || undefined,
				cwd: cwd || undefined,
				kinds: kinds
					? (kinds.split(",").filter((k) => k === "session" || k === "event") as Array<
							"session" | "event"
						>)
					: undefined,
				limit: 100,
			})
			.then((res) => {
				if (cancelled) return;
				setHits(res.hits);
				setTotal(res.total);
			})
			.catch((err) => {
				if (!cancelled) setError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [q, agentType, sessionStatus, eventType, cwd, kinds]);

	function submit(e: React.FormEvent) {
		e.preventDefault();
		const next = new URLSearchParams(params);
		if (draft.trim()) next.set("q", draft.trim());
		else next.delete("q");
		setParams(next);
	}

	function updateFilter(key: string, value: string) {
		const next = new URLSearchParams(params);
		if (value) next.set(key, value);
		else next.delete(key);
		setParams(next);
	}

	return (
		<div className="p-4 md:p-6 max-w-5xl mx-auto">
			<h1 className="text-xl md:text-2xl font-bold text-foreground">Search</h1>
			<p className="text-xs text-muted-foreground mt-1 mb-4">
				Full-text search across session metadata and every meaningful event (user prompts, assistant
				messages, AI reports, HITL proposals). Ranked by relevance.
			</p>

			<form onSubmit={submit} className="flex gap-2 mb-3">
				<input
					type="search"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="Search sessions and events… (e.g. 'auth refactor', 'passed tests')"
					className="flex-1 min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
					// biome-ignore lint/a11y/noAutofocus: search page is the primary action — auto-focusing the input matches user expectation
					autoFocus
				/>
				<button
					type="submit"
					disabled={!draft.trim()}
					className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
				>
					Search
				</button>
			</form>

			<div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4 text-xs">
				<FilterSelect
					label="Agent"
					value={agentType}
					onChange={(v) => updateFilter("agentType", v)}
					options={[
						{ value: "", label: "Any" },
						{ value: "claude_code", label: "Claude Code" },
						{ value: "codex_cli", label: "Codex CLI" },
					]}
				/>
				<FilterSelect
					label="Status"
					value={sessionStatus}
					onChange={(v) => updateFilter("sessionStatus", v)}
					options={[
						{ value: "", label: "Any" },
						{ value: "active", label: "Active" },
						{ value: "idle", label: "Idle" },
						{ value: "completed", label: "Completed" },
						{ value: "archived", label: "Archived" },
					]}
				/>
				<FilterSelect
					label="Event type"
					value={eventType}
					onChange={(v) => updateFilter("eventType", v)}
					options={[
						{ value: "", label: "Any" },
						{ value: "UserPromptSubmit", label: "User prompt" },
						{ value: "AssistantMessage", label: "Assistant message" },
						{ value: "Stop", label: "Session stop" },
						{ value: "TaskCreated", label: "Task created" },
						{ value: "TaskCompleted", label: "Task completed" },
						{ value: "AiProposal", label: "AI proposal" },
						{ value: "AiReport", label: "AI report" },
						{ value: "AiHitlRequest", label: "HITL request" },
					]}
				/>
				<FilterSelect
					label="Kind"
					value={kinds}
					onChange={(v) => updateFilter("kinds", v)}
					options={[
						{ value: "", label: "Both" },
						{ value: "session", label: "Sessions only" },
						{ value: "event", label: "Events only" },
					]}
				/>
			</div>

			{error && (
				<div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-200 mb-3">
					{error}
				</div>
			)}

			{loading && <div className="text-xs text-muted-foreground mb-3">Searching…</div>}

			{!loading && q && (
				<div className="text-[11px] text-muted-foreground mb-2">
					{total} hit{total === 1 ? "" : "s"} for <span className="font-mono">{q}</span>
				</div>
			)}

			<ul className="space-y-2">
				{hits.map((hit) => (
					<ResultRow
						key={`${hit.kind}:${hit.kind === "event" ? hit.eventId : hit.sessionId}`}
						hit={hit}
					/>
				))}
			</ul>

			{!loading && q && hits.length === 0 && (
				<div className="rounded-md border border-dashed border-border px-4 py-6 text-xs text-muted-foreground text-center">
					No matches. Try broader terms, or remove filters.
				</div>
			)}
		</div>
	);
}

function FilterSelect({
	label,
	value,
	onChange,
	options,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	options: Array<{ value: string; label: string }>;
}) {
	return (
		<label className="flex flex-col gap-1">
			<span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
			<select
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
			>
				{options.map((o) => (
					<option key={o.value} value={o.value}>
						{o.label}
					</option>
				))}
			</select>
		</label>
	);
}

function ResultRow({ hit }: { hit: Hit }) {
	const title =
		hit.sessionDisplayName ??
		`${hit.sessionId.slice(0, 8)}${hit.sessionCwd ? ` — ${hit.sessionCwd.split("/").pop()}` : ""}`;
	const href =
		hit.kind === "event" && hit.eventId != null
			? `/sessions/${hit.sessionId}?tab=activity#event-${hit.eventId}`
			: `/sessions/${hit.sessionId}`;
	return (
		<li>
			<Link
				to={href}
				className="block rounded-md border border-border bg-card hover:bg-muted px-3 py-2 transition-colors"
			>
				<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
					<span className="rounded border border-border px-1.5 py-0.5 font-mono">
						{hit.kind === "event" ? (hit.eventType ?? "event") : "session"}
					</span>
					<span className="truncate">{title}</span>
					<span className="ml-auto text-[10px] opacity-70">
						{new Date(hit.timestamp).toLocaleString()}
					</span>
				</div>
				<div
					className="mt-1 text-xs text-foreground/90 [&>mark]:bg-primary/20 [&>mark]:text-primary [&>mark]:rounded [&>mark]:px-0.5"
					// FTS5's snippet() returns pre-tagged HTML with <mark>…</mark>
					// around matches. Safe to render as-is because the tags are
					// emitted by SQLite, not by user content — and we escape the
					// rest (SQLite's snippet() doesn't escape HTML, so we still
					// strip script/img to be defensive).
					// biome-ignore lint/security/noDangerouslySetInnerHtml: FTS5-generated snippet
					dangerouslySetInnerHTML={{
						__html: sanitizeSnippet(hit.snippet),
					}}
				/>
			</Link>
		</li>
	);
}

/**
 * FTS5's snippet() outputs raw string content with `<mark>…</mark>`
 * tags. The content inside came from user/agent messages, so we need
 * to defend against tag smuggling. Strategy:
 *   1. Escape all < and > except our own <mark>/</mark> markers.
 *   2. Remove anything that looks like an HTML tag after that step.
 */
function sanitizeSnippet(input: string): string {
	// Temporarily swap our marker tags for sentinels, escape everything,
	// then swap the sentinels back. This way user text like `<script>`
	// becomes `&lt;script&gt;` but our `<mark>` tags survive.
	const OPEN = "\u0001MARK_OPEN\u0001";
	const CLOSE = "\u0001MARK_CLOSE\u0001";
	const escaped = input
		.replace(/<mark>/g, OPEN)
		.replace(/<\/mark>/g, CLOSE)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(new RegExp(OPEN, "g"), "<mark>")
		.replace(new RegExp(CLOSE, "g"), "</mark>");
	return escaped;
}
