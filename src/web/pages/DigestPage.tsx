import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { LabsBadge } from "../components/LabsBadge.js";
import { SkeletonCard, SkeletonCardList } from "../components/SkeletonCard.js";
import { StatCard } from "../components/StatCard.js";
import { type Digest, type RepoDigest, api } from "../lib/api.js";
import { formatTimeAgo } from "../lib/utils.js";

/**
 * Daily project digest. Deterministic aggregation of recent sessions
 * grouped by working directory with health/activity rollups.
 */
export function DigestPage() {
	const [digest, setDigest] = useState<Digest | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (fresh = false) => {
		setLoading(true);
		setError(null);
		try {
			const data = fresh ? await api.refreshDigest() : await api.getDigest();
			setDigest(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
			<header className="flex items-center justify-between gap-2">
				<div>
					<div className="flex items-center gap-2">
						<h1 className="text-xl font-semibold">Project digest</h1>
						<LabsBadge />
					</div>
					<p className="text-xs text-muted-foreground">
						Last 24 hours, grouped by repository. Auto-refreshed daily.
					</p>
				</div>
				<button
					type="button"
					onClick={() => void load(true)}
					disabled={loading}
					aria-busy={loading}
					className="flex items-center gap-1.5 text-xs px-3 py-1 rounded border border-border bg-background hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
				>
					{loading && (
						<span
							className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
							aria-hidden="true"
						/>
					)}
					Refresh now
				</button>
			</header>

			{error && (
				<div className="rounded border border-red-500/30 bg-red-500/10 text-red-300 p-3 text-xs">
					{error}
				</div>
			)}

			{loading ? (
				<output aria-label="Loading digest">
					{/* Stats row skeleton */}
					<section className="grid grid-cols-2 md:grid-cols-5 gap-3">
						{Array.from({ length: 5 }, (_, i) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: static skeleton rows
							<SkeletonCard key={i} lines={1} />
						))}
					</section>
					<SkeletonCardList count={3} lines={4} />
				</output>
			) : digest ? (
				<>
					<section className="grid grid-cols-2 md:grid-cols-5 gap-3">
						<StatCard label="Repos" value={digest.totals.repos} />
						<StatCard label="Sessions" value={digest.totals.sessions} />
						<StatCard label="Active" value={digest.totals.active} />
						<StatCard
							label="Blocked"
							value={digest.totals.blocked}
							tone={digest.totals.blocked > 0 ? "warn" : "default"}
						/>
						<StatCard
							label="Stuck"
							value={digest.totals.stuck}
							tone={digest.totals.stuck > 0 ? "danger" : "default"}
						/>
					</section>

					{digest.repos.length === 0 ? (
						<div className="rounded border border-border bg-card p-6 text-center text-sm text-muted-foreground">
							No recent activity in the last 24 hours.
						</div>
					) : (
						<div className="space-y-3">
							{digest.repos.map((r) => (
								<RepoCard key={r.repoKey} repo={r} />
							))}
						</div>
					)}

					<footer className="text-[10px] text-muted-foreground pt-2">
						generated {formatTimeAgo(digest.generatedAt)} · window{" "}
						{formatTimeAgo(digest.windowStart)} → {formatTimeAgo(digest.windowEnd)}
					</footer>
				</>
			) : null}
		</div>
	);
}

function RepoCard({ repo }: { repo: RepoDigest }) {
	return (
		<div className="rounded-lg border border-border bg-card p-4">
			<div className="flex items-center justify-between gap-2 mb-2">
				<div className="min-w-0">
					<h3 className="text-sm font-semibold text-foreground">{repo.projectName}</h3>
					<p className="text-[10px] font-mono text-muted-foreground truncate">
						{repo.cwd ?? "(no cwd)"}
					</p>
				</div>
				<div className="flex items-center gap-1 text-[10px]">
					<Chip label={`${repo.activeCount} active`} />
					{repo.blockedCount > 0 && (
						<Chip
							label={`${repo.blockedCount} blocked`}
							className="border-amber-500/30 text-amber-300"
						/>
					)}
					{repo.stuckCount > 0 && (
						<Chip label={`${repo.stuckCount} stuck`} className="border-red-500/30 text-red-300" />
					)}
					{repo.completedToday > 0 && (
						<Chip
							label={`${repo.completedToday} done`}
							className="border-emerald-500/30 text-emerald-300"
						/>
					)}
					{repo.failedToday > 0 && (
						<Chip label={`${repo.failedToday} failed`} className="border-red-500/30 text-red-300" />
					)}
				</div>
			</div>

			{repo.topPlanCompletions.length > 0 && (
				<div className="mb-2">
					<div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
						Plan completions
					</div>
					<ul className="text-xs list-disc list-inside space-y-0.5">
						{repo.topPlanCompletions.map((p) => (
							<li key={p} className="text-foreground/90 truncate">
								{p}
							</li>
						))}
					</ul>
				</div>
			)}

			{repo.notableFailures.length > 0 && (
				<div className="mb-2">
					<div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
						Notable failures
					</div>
					<ul className="text-[11px] space-y-0.5">
						{repo.notableFailures.map((f) => (
							<li key={`${f.sessionId}:${f.at}`} className="text-red-300/90">
								<Link
									to={`/sessions/${f.sessionId}`}
									className="text-primary hover:underline font-mono"
								>
									{f.sessionId.slice(0, 8)}
								</Link>
								{f.message ? ` — ${f.message}` : ""}
							</li>
						))}
					</ul>
				</div>
			)}

			<details className="group">
				<summary className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground cursor-pointer select-none list-none rounded px-1 -mx-1 py-0.5 hover:bg-muted/60 transition-colors">
					{/* Custom chevron replaces the browser disclosure triangle */}
					<svg
						className="w-2.5 h-2.5 shrink-0 transition-transform group-open:rotate-90"
						aria-hidden="true"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
						strokeWidth={3}
					>
						<path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
					</svg>
					Sessions ({repo.sessions.length})
				</summary>
				<ul className="mt-2 space-y-1 border-t border-border/40 pt-2">
					{repo.sessions.map((s) => (
						<li key={s.sessionId} className="flex items-center gap-2 text-xs">
							<Link
								to={`/sessions/${s.sessionId}`}
								className="text-primary hover:underline font-mono"
							>
								{s.displayName ?? s.sessionId.slice(0, 8)}
							</Link>
							<Chip label={s.status} />
							{s.health && <Chip label={s.health} />}
							<span className="text-muted-foreground ml-auto">
								{formatTimeAgo(s.lastActivityAt)}
							</span>
						</li>
					))}
				</ul>
			</details>
		</div>
	);
}

function Chip({ label, className = "" }: { label: string; className?: string }) {
	return (
		<span
			className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px] border-border text-muted-foreground bg-background/40 ${className}`}
		>
			{label}
		</span>
	);
}
