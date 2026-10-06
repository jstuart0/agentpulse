/**
 * AGEN-69 phase 8b: the header draws the Summary tab from the feature's own availability, so a
 * page that forgets to pass anything still gets it right.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { Session } from "../../../shared/types.js";
import type { LabsFlags } from "../../lib/api.js";
import { resetAiStatusStore, useAiStatusStore } from "../../stores/ai-status-store.js";
import { useLabsStore } from "../../stores/labs-store.js";
import { followLiveState } from "../../test-utils/live-stores.js";
import { SessionHeader } from "./SessionHeader.js";

let undo: () => void;
const SESSION = {
	sessionId: "s-1",
	agentType: "claude_code",
	status: "active",
	isWorking: false,
	isArchived: false,
	totalToolUses: 3,
	startedAt: "2026-10-04T10:00:00.000Z",
	metadata: {},
	managedSession: null,
} as unknown as Session;

function render(summaryBadge: string | null = null) {
	return renderToStaticMarkup(
		createElement(
			MemoryRouter,
			null,
			createElement(SessionHeader, {
				session: SESSION,
				displayName: "demo",
				allEvents: [],
				workspaceTab: "activity",
				onSelectTab: () => {},
				summaryBadge,
				mode: "progress",
				onModeChange: () => {},
				showTools: false,
				onToggleTools: () => {},
				showNoisyTools: false,
				onToggleNoisyTools: () => {},
				showSystem: true,
				onToggleSystem: () => {},
				onJumpTop: () => {},
				onJumpBottom: () => {},
				onRename: () => {},
				onStop: () => {},
				ackAction: null,
			}),
		),
	);
}

beforeEach(() => {
	undo = followLiveState(useLabsStore, useAiStatusStore);
	resetAiStatusStore();
});
afterEach(() => {
	undo();
	resetAiStatusStore();
	useLabsStore.setState({ flags: null });
});

describe("SessionHeader summary tab", () => {
	test("available: the Summary tab is there; flag off or AI not built in: it is not", () => {
		useAiStatusStore.setState({
			status: { build: true, runtime: true, killSwitch: false, active: true },
			loadState: "loaded",
		});
		useLabsStore.setState({ flags: { sessionSummary: true } as unknown as LabsFlags });
		expect(render()).toContain('id="workspace-tab-summary"');
		useLabsStore.setState({ flags: { sessionSummary: false } as unknown as LabsFlags });
		expect(render()).not.toContain('id="workspace-tab-summary"');
		useLabsStore.setState({ flags: { sessionSummary: true } as unknown as LabsFlags });
		useAiStatusStore.setState({
			status: { build: false, runtime: false, killSwitch: false, active: false },
		});
		expect(render()).not.toContain('id="workspace-tab-summary"');
	});

	test("the badge is shown on the Summary tab", () => {
		useAiStatusStore.setState({
			status: { build: true, runtime: true, killSwitch: false, active: true },
			loadState: "loaded",
		});
		useLabsStore.setState({ flags: { sessionSummary: true } as unknown as LabsFlags });
		expect(render("New")).toMatch(/Summary<\/span><span[^>]*>New</);
	});
});
