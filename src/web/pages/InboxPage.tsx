import { useCallback, useEffect, useState } from "react";
import { LabsBadge } from "../components/LabsBadge.js";
import { ActionRequestCard } from "../components/inbox/ActionRequestCard.js";
import { FailedProposalCard } from "../components/inbox/FailedProposalCard.js";
import { HitlCard } from "../components/inbox/HitlCard.js";
import { RiskyCard } from "../components/inbox/RiskyCard.js";
import { StuckCard } from "../components/inbox/StuckCard.js";
import { type ActionRequestDecision, type Inbox, type InboxWorkItem, api } from "../lib/api.js";

/**
 * Per-kind display labels for the filter select (longLabel) and the footer
 * ribbon (shortLabel). Typed as Record<InboxWorkItem["kind"], …> so TypeScript
 * fails compilation if any kind is added to the union without a matching entry.
 * Object.keys(KIND_META) is narrowed back to InboxWorkItem["kind"][] at the
 * two call sites below — safe because the exhaustive Record guarantees the keys
 * are exactly the union members.
 */
const KIND_META: Record<InboxWorkItem["kind"], { shortLabel: string; longLabel: string }> = {
	hitl: { shortLabel: "hitl", longLabel: "HITL" },
	stuck: { shortLabel: "stuck", longLabel: "Stuck" },
	risky: { shortLabel: "risky", longLabel: "Risky" },
	failed_proposal: { shortLabel: "failed", longLabel: "Failed" },
	action_launch: { shortLabel: "launches", longLabel: "Launch requests" },
	action_add_project: { shortLabel: "projects", longLabel: "Project requests" },
	action_session_stop: { shortLabel: "stops", longLabel: "Session stop" },
	action_session_archive: { shortLabel: "archives", longLabel: "Session archive" },
	action_session_delete: { shortLabel: "deletes", longLabel: "Session delete" },
	action_edit_project: { shortLabel: "proj-edits", longLabel: "Edit project" },
	action_delete_project: { shortLabel: "proj-deletes", longLabel: "Delete project" },
	action_edit_template: { shortLabel: "tmpl-edits", longLabel: "Edit template" },
	action_delete_template: { shortLabel: "tmpl-deletes", longLabel: "Delete template" },
	action_add_channel: { shortLabel: "channels", longLabel: "Add channel" },
	action_create_alert_rule: { shortLabel: "alert-rules", longLabel: "Alert rules" },
	action_create_freeform_alert_rule: {
		shortLabel: "freeform-alerts",
		longLabel: "Freeform alerts",
	},
	action_bulk_session: { shortLabel: "bulk", longLabel: "Bulk actions" },
};

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

	async function handleActionDecide(id: string, decision: ActionRequestDecision) {
		await api.decideActionRequest(id, { decision });
		reload();
	}

	async function handleSnooze(id: string, kind: InboxWorkItem["kind"], durationMs: number) {
		await api.snoozeInboxItem({ kind, targetId: id, durationMs });
		reload();
	}

	function renderCard(item: InboxWorkItem) {
		switch (item.kind) {
			case "hitl":
				return <HitlCard key={`${item.kind}:${item.id}`} item={item} onDecide={handleHitlDecide} />;
			case "stuck":
				return <StuckCard key={`${item.kind}:${item.id}`} item={item} />;
			case "risky":
				return <RiskyCard key={`${item.kind}:${item.id}`} item={item} />;
			case "failed_proposal":
				return (
					<FailedProposalCard key={`${item.kind}:${item.id}`} item={item} onSnooze={handleSnooze} />
				);
			case "action_session_stop":
			case "action_session_archive":
			case "action_session_delete":
			case "action_launch":
			case "action_add_project":
			case "action_add_channel":
			case "action_create_alert_rule":
			case "action_create_freeform_alert_rule":
			case "action_edit_project":
			case "action_edit_template":
			case "action_delete_project":
			case "action_delete_template":
			case "action_bulk_session":
				return (
					<ActionRequestCard
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
						{(Object.keys(KIND_META) as InboxWorkItem["kind"][]).map((k) => (
							<option key={k} value={k}>
								{KIND_META[k].longLabel}
							</option>
						))}
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
					{(Object.keys(KIND_META) as InboxWorkItem["kind"][]).map((k) => (
						<span key={k}>
							{KIND_META[k].shortLabel}: {inbox.byKind[k]}
						</span>
					))}
				</footer>
			)}
		</div>
	);
}
