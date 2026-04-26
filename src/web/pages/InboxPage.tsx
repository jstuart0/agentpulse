import { useCallback, useEffect, useState } from "react";
import { ActionAddProjectCard } from "../components/inbox/ActionAddProjectCard.js";
import { ActionLaunchCard } from "../components/inbox/ActionLaunchCard.js";
import { ActionSessionArchiveCard } from "../components/inbox/ActionSessionArchiveCard.js";
import { ActionSessionDeleteCard } from "../components/inbox/ActionSessionDeleteCard.js";
import { ActionSessionStopCard } from "../components/inbox/ActionSessionStopCard.js";
import { FailedProposalCard } from "../components/inbox/FailedProposalCard.js";
import { HitlCard } from "../components/inbox/HitlCard.js";
import { RiskyCard } from "../components/inbox/RiskyCard.js";
import { StuckCard } from "../components/inbox/StuckCard.js";
import { LabsBadge } from "../components/LabsBadge.js";
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

	async function handleHitlDecide(id: string, action: "approve" | "decline") {
		await api.decideInboxHitl(id, { action });
		reload();
	}

	async function handleActionDecide(id: string, decision: "applied" | "declined") {
		await api.decideActionRequest(id, { decision });
		reload();
	}

	async function handleSnooze(
		id: string,
		kind: InboxWorkItem["kind"],
		durationMs: number,
	) {
		await api.snoozeInboxItem({ kind, targetId: id, durationMs });
		reload();
	}

	function renderCard(item: InboxWorkItem) {
		switch (item.kind) {
			case "hitl":
				return (
					<HitlCard
						key={`${item.kind}:${item.id}`}
						item={item}
						onDecide={handleHitlDecide}
					/>
				);
			case "stuck":
				return <StuckCard key={`${item.kind}:${item.id}`} item={item} />;
			case "risky":
				return <RiskyCard key={`${item.kind}:${item.id}`} item={item} />;
			case "failed_proposal":
				return (
					<FailedProposalCard
						key={`${item.kind}:${item.id}`}
						item={item}
						onSnooze={handleSnooze}
					/>
				);
			case "action_launch":
				return (
					<ActionLaunchCard
						key={`${item.kind}:${item.id}`}
						item={item}
						onDecide={handleActionDecide}
					/>
				);
			case "action_add_project":
				return (
					<ActionAddProjectCard
						key={`${item.kind}:${item.id}`}
						item={item}
						onDecide={handleActionDecide}
					/>
				);
			case "action_session_stop":
				return (
					<ActionSessionStopCard
						key={`${item.kind}:${item.id}`}
						item={item}
						onDecide={handleActionDecide}
					/>
				);
			case "action_session_archive":
				return (
					<ActionSessionArchiveCard
						key={`${item.kind}:${item.id}`}
						item={item}
						onDecide={handleActionDecide}
					/>
				);
			case "action_session_delete":
				return (
					<ActionSessionDeleteCard
						key={`${item.kind}:${item.id}`}
						item={item}
						onDecide={handleActionDecide}
					/>
				);
		}
	}

	return (
		<div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
			<header className="flex items-center justify-between gap-2">
				<div>
					<div className="flex items-center gap-2">
						<h1 className="text-xl font-semibold">Operator inbox</h1>
						<LabsBadge />
					</div>
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
						<option value="action_launch">Launch requests</option>
						<option value="action_add_project">Project requests</option>
						<option value="action_session_stop">Session stop</option>
						<option value="action_session_archive">Session archive</option>
						<option value="action_session_delete">Session delete</option>
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
				<div className="space-y-3">{inbox?.items.map((item) => renderCard(item))}</div>
			)}

			{inbox && (
				<footer className="pt-2 text-xs text-muted-foreground flex items-center gap-3">
					<span>total: {inbox.total}</span>
					<span>hitl: {inbox.byKind.hitl}</span>
					<span>stuck: {inbox.byKind.stuck}</span>
					<span>risky: {inbox.byKind.risky}</span>
					<span>failed: {inbox.byKind.failed_proposal}</span>
					<span>launches: {inbox.byKind.action_launch}</span>
					<span>projects: {inbox.byKind.action_add_project}</span>
					<span>stops: {inbox.byKind.action_session_stop}</span>
					<span>archives: {inbox.byKind.action_session_archive}</span>
					<span>deletes: {inbox.byKind.action_session_delete}</span>
				</footer>
			)}
		</div>
	);
}
