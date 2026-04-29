import { useState } from "react";
import { Link } from "react-router-dom";
import type { ActionInboxItem } from "../../../shared/types.js";
import type { ActionRequestDecision } from "../../lib/api.js";
import { KindBadge } from "./shared/KindBadge.js";
import { severityBorderClass, severityPillClass } from "./shared/cardUtils.js";
import { relTime } from "./shared/relTime.js";

type ApproveTone = "destructive" | "constructive" | "neutral";

const APPROVE_TONE_CLASS: Record<ApproveTone, string> = {
	destructive: "bg-red-500/20 text-red-300 border border-red-500/30 hover:bg-red-500/30",
	constructive: "bg-blue-500/20 text-blue-300 border border-blue-500/30 hover:bg-blue-500/30",
	neutral: "bg-slate-500/20 text-slate-300 border border-slate-500/30 hover:bg-slate-500/30",
};

const RULE_TYPE_LABELS: Record<string, string> = {
	status_failed: "session fails",
	status_stuck: "session gets stuck",
	status_completed: "session completes",
	no_activity_minutes: "session has no activity for N minutes",
};

interface CardSpec {
	header: React.ReactNode;
	body: React.ReactNode;
	approveTone: ApproveTone;
	approveLabel: string;
}

function BodyDiv({ children }: { children: React.ReactNode }) {
	return <div className="text-xs text-muted-foreground mb-2 space-y-1">{children}</div>;
}

function Origin({ value }: { value: string }) {
	return (
		<div>
			Origin: <span className="font-mono">{value}</span>
		</div>
	);
}

function cardSpecFor(item: ActionInboxItem): CardSpec {
	switch (item.kind) {
		case "action_session_stop":
		case "action_session_archive":
		case "action_session_delete":
			return {
				header: (
					<Link
						to={`/sessions/${item.sessionId}`}
						className="text-primary hover:underline font-medium"
					>
						{item.sessionName ?? item.sessionId.slice(0, 8)}
					</Link>
				),
				body: (
					<BodyDiv>
						<Origin value={item.origin} />
					</BodyDiv>
				),
				approveTone: "destructive",
				approveLabel: "Approve",
			};

		case "action_launch":
			return {
				header: (
					<span className="text-sm font-medium">
						{item.parentSessionId
							? `Resume of ${item.parentSessionName ?? item.parentSessionId.slice(0, 8)}`
							: item.projectName}
					</span>
				),
				body: (
					<BodyDiv>
						{item.parentSessionId && (
							<div className="font-medium text-blue-300">
								Resume of{" "}
								<strong>{item.parentSessionName ?? item.parentSessionId.slice(0, 8)}</strong>
							</div>
						)}
						<div>
							Agent: <span className="font-mono">{item.template.agentType ?? "—"}</span>
							{" · "}
							Mode: <span className="font-mono">{item.requestedLaunchMode}</span>
							{" · "}
							Origin: <span className="font-mono">{item.origin}</span>
						</div>
						<div className="font-mono text-[10px] break-all">
							{item.template.cwd ?? item.launchSpec?.cwd ?? ""}
						</div>
						{item.template.taskPrompt ? (
							<div className="italic">Task: {item.template.taskPrompt}</div>
						) : null}
					</BodyDiv>
				),
				approveTone: "constructive",
				approveLabel: "Approve",
			};

		case "action_add_project":
			return {
				header: <span className="text-sm font-medium">New project request</span>,
				body: (
					<BodyDiv>
						<div>
							Name: <span className="font-mono">{item.projectName}</span>
						</div>
						<div className="font-mono text-[10px] break-all">{item.projectCwd}</div>
						{item.defaultAgentType && (
							<div>
								Agent: <span className="font-mono">{item.defaultAgentType}</span>
							</div>
						)}
						{item.defaultLaunchMode && (
							<div>
								Mode: <span className="font-mono">{item.defaultLaunchMode}</span>
							</div>
						)}
						{item.defaultModel && (
							<div>
								Model: <span className="font-mono">{item.defaultModel}</span>
							</div>
						)}
						<Origin value={item.origin} />
					</BodyDiv>
				),
				approveTone: "constructive",
				approveLabel: "Approve",
			};

		case "action_add_channel":
			return {
				header: <span className="text-sm font-medium">New channel request</span>,
				body: (
					<BodyDiv>
						<div>
							Kind: <span className="font-mono">{item.channelKind}</span>
						</div>
						<div>
							Label: <span className="font-mono">{item.channelLabel}</span>
						</div>
						<Origin value={item.origin} />
					</BodyDiv>
				),
				approveTone: "constructive",
				approveLabel: "Approve",
			};

		case "action_create_alert_rule": {
			const ruleLabel =
				item.ruleType === "no_activity_minutes" && item.thresholdMinutes != null
					? `session has no activity for ${item.thresholdMinutes} minutes`
					: (RULE_TYPE_LABELS[item.ruleType] ?? item.ruleType);
			return {
				header: <span className="text-sm font-medium">Alert rule request</span>,
				body: (
					<BodyDiv>
						<div>
							Project: <span className="font-mono">{item.projectName}</span>
						</div>
						<div>
							Trigger: <span className="font-mono">{ruleLabel}</span>
						</div>
						<Origin value={item.origin} />
					</BodyDiv>
				),
				approveTone: "constructive",
				approveLabel: "Approve",
			};
		}

		case "action_create_freeform_alert_rule":
			return {
				header: <span className="text-sm font-medium">Freeform alert rule</span>,
				body: (
					<BodyDiv>
						<div>
							Project: <span className="font-mono">{item.projectName}</span>
						</div>
						<div className="font-mono text-[10px] break-all">{item.condition}</div>
						<div>
							Daily token budget: <span className="font-mono">{item.dailyTokenBudget}</span>
						</div>
						<Origin value={item.origin} />
					</BodyDiv>
				),
				approveTone: "constructive",
				approveLabel: "Approve",
			};

		case "action_edit_project":
		case "action_edit_template": {
			const fieldEntries = Object.entries(item.fields);
			const titleName = item.kind === "action_edit_project" ? item.projectName : item.templateName;
			return {
				header: <span className="text-sm font-medium">{titleName}</span>,
				body: (
					<BodyDiv>
						{fieldEntries.length > 0 ? (
							fieldEntries.map(([key, value]) => (
								<div key={key}>
									<span className="font-mono">{key}:</span>{" "}
									<span className="font-mono">{value === null ? "(clear)" : String(value)}</span>
								</div>
							))
						) : (
							<div className="italic">No fields specified</div>
						)}
						<Origin value={item.origin} />
					</BodyDiv>
				),
				approveTone: "constructive",
				approveLabel: "Approve",
			};
		}

		case "action_delete_project":
			return {
				header: <span className="text-sm font-medium">{item.projectName}</span>,
				body: (
					<BodyDiv>
						{item.affectedTemplates > 0 && (
							<div>
								Linked templates:{" "}
								<span className="font-mono text-amber-300">{item.affectedTemplates}</span> will be
								unlinked
							</div>
						)}
						{item.affectedSessions > 0 && (
							<div>
								Sessions: <span className="font-mono text-amber-300">{item.affectedSessions}</span>{" "}
								will be disassociated
							</div>
						)}
						{item.affectedTemplates === 0 && item.affectedSessions === 0 && (
							<div className="italic">No linked templates or sessions</div>
						)}
						<Origin value={item.origin} />
					</BodyDiv>
				),
				approveTone: "destructive",
				approveLabel: "Approve (permanent)",
			};

		case "action_delete_template":
			return {
				header: <span className="text-sm font-medium">{item.templateName}</span>,
				body: (
					<BodyDiv>
						<div className="italic text-amber-300/80">
							This action is permanent and cannot be undone.
						</div>
						<Origin value={item.origin} />
					</BodyDiv>
				),
				approveTone: "destructive",
				approveLabel: "Approve (permanent)",
			};

		case "action_bulk_session": {
			const actionLabel = item.action.charAt(0).toUpperCase() + item.action.slice(1);
			const tone: ApproveTone = item.action === "archive" ? "neutral" : "destructive";
			return {
				header: (
					<span className="text-sm font-medium">
						{actionLabel} {item.sessionCount} session{item.sessionCount !== 1 ? "s" : ""}
					</span>
				),
				body: (
					<>
						<div className="flex flex-wrap gap-1 mb-2">
							{item.sessionNames.map((name) => (
								<span
									key={name}
									className="text-[10px] font-mono bg-muted border border-border rounded px-1.5 py-0.5 truncate max-w-[200px]"
									title={name}
								>
									{name}
								</span>
							))}
							{item.hasMore && (
								<span className="text-[10px] text-muted-foreground px-1.5 py-0.5">
									+{item.sessionCount - item.sessionNames.length} more
								</span>
							)}
						</div>
						{item.exclusionCount > 0 && (
							<div className="text-[11px] text-amber-400/80 mb-2">
								{item.exclusionCount} session{item.exclusionCount !== 1 ? "s" : ""} excluded from
								this action (hook-only or active — cannot be acted on).
							</div>
						)}
						<div className="text-xs text-muted-foreground mb-2">
							Origin: <span className="font-mono">{item.origin}</span>
						</div>
					</>
				),
				approveTone: tone,
				approveLabel: "Approve",
			};
		}

		default: {
			// Exhaustiveness guard — adding a new action_* variant without a case
			// is a compile error here.
			const _exhaustive: never = item;
			return _exhaustive;
		}
	}
}

export function ActionRequestCard({
	item,
	onDecide,
}: {
	item: ActionInboxItem;
	onDecide: (id: string, decision: ActionRequestDecision) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const spec = cardSpecFor(item);

	async function handleDecide(decision: ActionRequestDecision) {
		setBusy(true);
		setErr(null);
		try {
			await onDecide(item.id, decision);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className={`rounded-lg border p-4 ${severityBorderClass(item.severity)}`}>
			<div className="flex items-center justify-between gap-2 mb-2">
				<div className="flex items-center gap-2">
					<KindBadge kind={item.kind} />
					{spec.header}
				</div>
				<span
					className={`text-[10px] font-mono rounded px-1.5 py-0.5 border ${severityPillClass(item.severity)}`}
				>
					{item.severity}
				</span>
			</div>
			{spec.body}
			<div className="flex items-center gap-2 mt-3">
				<button
					type="button"
					disabled={busy}
					onClick={() => handleDecide("applied")}
					className={`text-xs px-3 py-1 rounded disabled:opacity-50 ${APPROVE_TONE_CLASS[spec.approveTone]}`}
				>
					{spec.approveLabel}
				</button>
				<button
					type="button"
					disabled={busy}
					onClick={() => handleDecide("declined")}
					className="text-xs px-3 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
				>
					Decline
				</button>
				<span className="text-[10px] text-muted-foreground ml-auto">{relTime(item.createdAt)}</span>
			</div>
			{err && <div className="mt-2 text-[11px] text-red-300">{err}</div>}
		</div>
	);
}
