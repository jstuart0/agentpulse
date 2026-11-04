/**
 * When the approval card asks the server (AGEN-87, 6.8). No new WebSocket message type, no second
 * timer: the session page's 10 s poll and the live updates change the session row, and these rules
 * decide whether that is worth a request. Never per tool call.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	codexApprovalWaitIds,
	hasPendingCodexApproval,
	showsApprovalCard,
} from "../../lib/codex-approval-wait.js";
import { fetchDelayMs, shouldRefetchOnSession } from "./codex-approval-view.js";

const WEB = join(import.meta.dir, "..", "..");
const hook = readFileSync(join(WEB, "hooks/useCodexApprovals.ts"), "utf-8");

describe("reading the open approvals off the session row", () => {
	test("only approval: ids count, in order", () => {
		expect(
			codexApprovalWaitIds({
				permissionWait: { ids: ["approval:a", "toolu_1", "approval:b"], anon: 0 },
			}),
		).toEqual(["a", "b"]);
		expect(codexApprovalWaitIds({ permissionWait: { ids: ["toolu_1"], anon: 2 } })).toEqual([]);
		expect(codexApprovalWaitIds({})).toEqual([]);
		expect(codexApprovalWaitIds(null)).toEqual([]);
		expect(codexApprovalWaitIds({ permissionWait: { ids: "approval:a" } })).toEqual([]);
		expect(codexApprovalWaitIds({ permissionWait: { ids: [1, null, {}] } })).toEqual([]);
	});

	test("a Claude wait is not a Codex approval", () => {
		expect(
			hasPendingCodexApproval({ metadata: { permissionWait: { ids: ["t1"], anon: 1 } } }),
		).toBe(false);
		expect(
			hasPendingCodexApproval({ metadata: { permissionWait: { ids: ["approval:x"], anon: 0 } } }),
		).toBe(true);
	});
});

describe("session_updated and the 10 s poll", () => {
	test("unchanged wait ids and an empty list: no refetch, however often the row changes", () => {
		for (let i = 0; i < 5; i++) {
			expect(
				shouldRefetchOnSession({
					previousIds: ["a"],
					ids: ["a"],
					listHasRows: false,
					notOwner: false,
				}),
			).toBe(false);
		}
	});

	test("a prior non-empty list keeps it fetching, so a close is noticed", () => {
		expect(
			shouldRefetchOnSession({ previousIds: [], ids: [], listHasRows: true, notOwner: false }),
		).toBe(true);
	});

	test("changed ids fetch, in either direction", () => {
		expect(
			shouldRefetchOnSession({ previousIds: [], ids: ["a"], listHasRows: false, notOwner: false }),
		).toBe(true);
		expect(
			shouldRefetchOnSession({ previousIds: ["a"], ids: [], listHasRows: false, notOwner: false }),
		).toBe(true);
	});

	test("the debounce holds: a burst inside 2 s waits for the rest of the 2 s", () => {
		expect(fetchDelayMs(100, false)).toBe(1900);
		expect(fetchDelayMs(1999, false)).toBe(1);
		expect(fetchDelayMs(2000, false)).toBe(0);
	});

	test("the hook has no timer of its own for fetching, and opens no socket", () => {
		expect(hook).not.toMatch(/setInterval\([^)]*fetch|new WebSocket|WebSocket\(/);
		expect((hook.match(/setInterval\(/g) ?? []).length).toBe(1);
		expect(hook).toMatch(/setInterval\(\(\) => setNowMono\(performance\.now\(\)\), 1000\)/);
		expect(hook).toMatch(/\[session, refresh\]/);
	});

	test("a permission event on the live feed is the only live-feed trigger", () => {
		expect(hook).toMatch(/e\.category === "permission_event"/);
	});
});

describe("which sessions ever call the route", () => {
	const managedCodex = { agentType: "codex_cli", managedSession: { sessionId: "s" } };
	test("a managed Codex session does", () => {
		expect(showsApprovalCard(managedCodex)).toBe(true);
	});
	test("nothing else does", () => {
		expect(showsApprovalCard({ agentType: "codex_cli", managedSession: null })).toBe(false);
		expect(showsApprovalCard({ agentType: "codex_cli" })).toBe(false);
		expect(
			showsApprovalCard({ agentType: "claude_code", managedSession: { sessionId: "s" } }),
		).toBe(false);
		expect(
			showsApprovalCard({ agentType: "copilot_cli", managedSession: { sessionId: "s" } }),
		).toBe(false);
	});
	test("the page mounts the card only through that test", () => {
		const page = readFileSync(join(WEB, "pages/SessionDetailPage.tsx"), "utf-8");
		expect(page).toMatch(
			/\{showsApprovalCard\(session\) \? \(\s*<Suspense fallback=\{null\}>\s*<CodexApprovalCard/,
		);
	});
});
