import type { InboxWorkItem } from "../../../lib/api.js";

const styles: Record<InboxWorkItem["kind"], string> = {
	hitl: "bg-primary/10 text-primary border-primary/30",
	stuck: "bg-red-500/10 text-red-300 border-red-500/30",
	risky: "bg-amber-500/10 text-amber-300 border-amber-500/30",
	failed_proposal: "bg-muted text-muted-foreground border-border",
	action_launch: "bg-blue-500/10 text-blue-300 border-blue-500/30",
	action_add_project: "bg-teal-500/10 text-teal-300 border-teal-500/30",
	action_session_stop: "bg-red-500/10 text-red-300 border-red-500/30",
	action_session_archive: "bg-slate-500/10 text-slate-300 border-slate-500/30",
	action_session_delete: "bg-red-500/10 text-red-300 border-red-500/30",
	action_edit_project: "bg-violet-500/10 text-violet-300 border-violet-500/30",
	action_delete_project: "bg-red-500/10 text-red-300 border-red-500/30",
	action_edit_template: "bg-violet-500/10 text-violet-300 border-violet-500/30",
	action_delete_template: "bg-red-500/10 text-red-300 border-red-500/30",
	action_add_channel: "bg-cyan-500/10 text-cyan-300 border-cyan-500/30",
	action_create_alert_rule: "bg-orange-500/10 text-orange-300 border-orange-500/30",
	action_create_freeform_alert_rule: "bg-orange-500/10 text-orange-300 border-orange-500/30",
	action_bulk_session: "bg-red-500/10 text-red-300 border-red-500/30",
};

const labels: Record<InboxWorkItem["kind"], string> = {
	hitl: "HITL",
	stuck: "stuck",
	risky: "risky",
	failed_proposal: "failed",
	action_launch: "launch",
	action_add_project: "new project",
	action_session_stop: "stop session",
	action_session_archive: "archive session",
	action_session_delete: "delete session",
	action_edit_project: "edit project",
	action_delete_project: "delete project",
	action_edit_template: "edit template",
	action_delete_template: "delete template",
	action_add_channel: "add channel",
	action_create_alert_rule: "alert rule",
	action_create_freeform_alert_rule: "freeform alert",
	action_bulk_session: "bulk action",
};

export function KindBadge({ kind }: { kind: InboxWorkItem["kind"] }) {
	return (
		<span className={`text-[10px] font-semibold rounded px-1.5 py-0.5 border ${styles[kind]}`}>
			{labels[kind]}
		</span>
	);
}
