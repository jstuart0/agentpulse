import type { Session } from "../../../shared/types.js";
import { hasPendingCodexApproval } from "../../lib/codex-approval-wait.js";
import { type WorkspaceTabId, tabBadgeAccessibleName } from "../../lib/session-summary-core.js";
import { WorkspaceTabButton } from "./SharedControls.js";

export interface WorkspaceTabBarProps {
	/** The tab showing now; null while a `?tab=` link waits for availability. */
	active: WorkspaceTabId | null;
	onSelect: (tab: WorkspaceTabId) => void;
	instructionsLabel: string;
	isWorking: boolean;
	hasLaunch: boolean;
	aiTabEnabled: boolean;
	summaryAvailable: boolean;
	/** The word on the Summary tab while a summary is being made. */
	summaryBadge: string | null;
}

/**
 * Whether the Activity tab says "Working". While Codex waits on an approval the badge says it is waiting
 * (a state is said once), so the tab doesn't claim the opposite.
 */
export function activityTabWorking(session: Pick<Session, "isWorking" | "metadata">): boolean {
	return session.isWorking && !hasPendingCodexApproval(session);
}

export function workspaceTabButtonId(tab: WorkspaceTabId): string {
	return `workspace-tab-${tab}`;
}

/** Overview · Summary · Activity · Notes · instructions · Launch · AI; Summary only when the feature is available. */
export function WorkspaceTabBar(props: WorkspaceTabBarProps) {
	const { active, onSelect } = props;
	const tab = (
		id: WorkspaceTabId,
		label: string,
		badge: string | null = null,
		badgeName: string | null = null,
	) => (
		<WorkspaceTabButton
			id={workspaceTabButtonId(id)}
			active={active === id}
			label={label}
			badge={badge}
			badgeName={badgeName}
			onClick={() => onSelect(id)}
		/>
	);
	return (
		<nav
			aria-label="Session sections"
			className="flex flex-nowrap items-center gap-1.5 overflow-x-auto md:flex-wrap md:gap-2"
		>
			{tab("overview", "Overview")}
			{props.summaryAvailable &&
				tab(
					"summary",
					"Summary",
					props.summaryBadge,
					tabBadgeAccessibleName(props.summaryBadge as "Summarizing" | "New" | null),
				)}
			{tab("activity", "Activity", props.isWorking ? "Working" : null)}
			{tab("notes", "Notes")}
			{tab("instructions", props.instructionsLabel)}
			{props.hasLaunch && tab("launch", "Launch")}
			{props.aiTabEnabled && tab("ai", "AI")}
		</nav>
	);
}
