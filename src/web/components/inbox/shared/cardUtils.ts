import type { InboxSeverity } from "../../../lib/api.js";

export function severityBorderClass(severity: InboxSeverity): string {
	return severity === "high"
		? "border-red-500/30 bg-red-500/5"
		: severity === "info"
			? "border-blue-500/30 bg-blue-500/5"
			: "border-border bg-card";
}

export function severityPillClass(severity: InboxSeverity): string {
	return severity === "high"
		? "border-red-500/30 text-red-300"
		: severity === "info"
			? "border-blue-500/30 text-blue-300"
			: "border-border text-muted-foreground";
}
