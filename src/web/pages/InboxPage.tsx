import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type Inbox, type InboxWorkItem, api } from "../lib/api.js";

/**
 * Operator inbox. Pulls the discriminated-union work items from the
 * server-side read model and renders each kind with its own card layout.
 */
export function InboxPage() {
	const [inbox, setInbox] = useState<Inbox | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [kindFilter, setKindFilter] = useState<InboxWorkItem["kind"] | "all">("all");

	const reload = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const data = await api.getAiInbox({
				kinds: kindFilter === "all" ? undefined : [kindFilter],
			});
			setInbox(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [kindFilter]);

	useEffect(() => {
		void reload();
	}, [reload]);

	return (
		<div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
			<header className="flex items-center justify-between gap-2">
				<div>
					<h1 className="text-xl font-semibold">Operator inbox</h1>
					<p className="text-xs text-muted-foreground">
						Open AI work items across all sessions. Pinned by severity.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<select
						value={kindFilter}
						onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}
						className="text-xs bg-background border border-border rounded px-2 py-1"
					>
						<option value="all">All kinds</option>
						<option value="hitl">HITL</option>
						<option value="stuck">Stuck</option>
						<option value="risky">Risky</option>
						<option value="failed_proposal">Failed</option>
					</select>
					<button
						type="button"
						onClick={() => void reload()}
						className="text-xs px-3 py-1 rounded border border-border bg-background hover:bg-muted"
					>
						Refresh
					</button>
				</div>
			</header>

			{error && (
				<div className="rounded border border-red-500/30 bg-red-500/10 text-red-300 p-3 text-xs">
					{error}
				</div>
			)}

			{loading ? (
				<div className="text-sm text-muted-foreground">Loading…</div>
			) : inbox && inbox.items.length === 0 ? (
				<div className="rounded border border-border bg-card p-6 text-center text-sm text-muted-foreground">
					Inbox empty. Nothing needs your attention.
				</div>
			) : (
				<div className="space-y-3">
					{inbox?.items.map((item) => (
						<InboxCard key={`${item.kind}:${item.id}`} item={item} onResolved={reload} />
					))}
				</div>
			)}

			{inbox && (
				<footer className="pt-2 text-xs text-muted-foreground flex items-center gap-3">
					<span>total: {inbox.total}</span>
					<span>hitl: {inbox.byKind.hitl}</span>
					<span>stuck: {inbox.byKind.stuck}</span>
					<span>risky: {inbox.byKind.risky}</span>
					<span>failed: {inbox.byKind.failed_proposal}</span>
				</footer>
			)}
		</div>
	);
}

function InboxCard({
	item,
	onResolved,
}: {
	item: InboxWorkItem;
	onResolved: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const sessionLink = (
		<Link to={`/sessions/${item.sessionId}`} className="text-primary hover:underline font-medium">
			{item.sessionName ?? item.sessionId.slice(0, 8)}
		</Link>
	);

	async function handleDecide(action: "approve" | "decline") {
		if (item.kind !== "hitl") return;
		setBusy(true);
		setErr(null);
		try {
			await api.decideInboxHitl(item.id, { action });
			onResolved();
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	const sevClass =
		item.severity === "high" ? "border-red-500/30 bg-red-500/5" : "border-border bg-card";

	return (
		<div className={`rounded-lg border p-4 ${sevClass}`}>
			<div className="flex items-center justify-between gap-2 mb-2">
				<div className="flex items-center gap-2">
					<KindBadge kind={item.kind} />
					{sessionLink}
				</div>
				<span
					className={`text-[10px] font-mono rounded px-1.5 py-0.5 border ${
						item.severity === "high"
							? "border-red-500/30 text-red-300"
							: "border-border text-muted-foreground"
					}`}
				>
					{item.severity}
				</span>
			</div>

			{item.kind === "hitl" && (
				<>
					<div className="text-xs text-muted-foreground mb-2">
						Decision: <span className="font-mono">{item.decision}</span>
						{item.why ? ` — ${item.why}` : ""}
					</div>
					{item.prompt && (
						<pre className="text-xs font-mono bg-background/50 border border-border rounded p-2 whitespace-pre-wrap break-words max-h-40 overflow-auto">
							{item.prompt}
						</pre>
					)}
					<div className="flex items-center gap-2 mt-3">
						<button
							type="button"
							disabled={busy}
							onClick={() => handleDecide("approve")}
							className="text-xs px-3 py-1 rounded bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30 disabled:opacity-50"
						>
							Approve
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() => handleDecide("decline")}
							className="text-xs px-3 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
						>
							Decline
						</button>
						<span className="text-[10px] text-muted-foreground ml-auto">
							{relTime(item.openedAt)}
						</span>
					</div>
				</>
			)}

			{(item.kind === "stuck" || item.kind === "risky") && (
				<>
					<div className="text-xs text-muted-foreground mb-1">
						Reason: <span className="font-mono">{item.reason}</span>
					</div>
					{item.evidence.length > 0 && (
						<ul className="text-[11px] text-muted-foreground list-disc list-inside">
							{item.evidence.slice(0, 4).map((e) => (
								<li key={e} className="font-mono">
									{e}
								</li>
							))}
						</ul>
					)}
				</>
			)}

			{item.kind === "failed_proposal" && (
				<>
					<div className="text-xs text-muted-foreground">
						{item.errorSubType ? (
							<>
								<span className="font-mono">{item.errorSubType}</span>
								{item.errorMessage ? `: ${item.errorMessage}` : ""}
							</>
						) : (
							(item.errorMessage ?? "unknown error")
						)}
					</div>
					<div className="text-[10px] text-muted-foreground mt-1">{relTime(item.at)}</div>
				</>
			)}

			{err && <div className="mt-2 text-[11px] text-red-300">{err}</div>}
		</div>
	);
}

function KindBadge({ kind }: { kind: InboxWorkItem["kind"] }) {
	const styles: Record<InboxWorkItem["kind"], string> = {
		hitl: "bg-primary/10 text-primary border-primary/30",
		stuck: "bg-red-500/10 text-red-300 border-red-500/30",
		risky: "bg-amber-500/10 text-amber-300 border-amber-500/30",
		failed_proposal: "bg-muted text-muted-foreground border-border",
	};
	const labels: Record<InboxWorkItem["kind"], string> = {
		hitl: "HITL",
		stuck: "stuck",
		risky: "risky",
		failed_proposal: "failed",
	};
	return (
		<span className={`text-[10px] font-semibold rounded px-1.5 py-0.5 border ${styles[kind]}`}>
			{labels[kind]}
		</span>
	);
}

function relTime(iso: string): string {
	const ts = iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`;
	const diff = Date.now() - new Date(ts).getTime();
	const s = Math.floor(diff / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}
