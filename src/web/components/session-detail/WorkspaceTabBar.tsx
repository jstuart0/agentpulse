import type { WorkspaceTabId } from "../../lib/session-summary-view.js";

export interface WorkspaceTabBarProps {
	active: WorkspaceTabId | null;
	onSelect: (tab: WorkspaceTabId) => void;
	instructionsLabel: string;
	isWorking: boolean;
	hasLaunch: boolean;
	aiTabEnabled: boolean;
	summaryAvailable: boolean;
	summaryBadge: string | null;
}

export function workspaceTabButtonId(tab: WorkspaceTabId): string {
	return `workspace-tab-${tab}`;
}

export function WorkspaceTabBar(_props: WorkspaceTabBarProps) {
	return null;
}
