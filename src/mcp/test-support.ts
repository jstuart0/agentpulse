/**
 * Shared fake-client test fixture (AGEN-12, D3 seams 1/3).
 *
 * Every AgentPulseClient method defaults to a "not stubbed" rejection so a
 * test that forgets to override the method it actually exercises fails
 * loudly with a clear message, instead of silently returning misleading
 * data from some other test's leftover default. Override only what the
 * test under-test needs via `fakeClient({ methodName: async () => ... })`.
 *
 * Centralized here (rather than duplicated per test file, as server.ts and
 * scopes.test.ts each had their own copy through Phase 2) because Phase 3
 * grew AgentPulseClient from 2 methods to 17 — every test file that builds
 * a fake client needs the full interface satisfied.
 */
import type { DashboardStats } from "../shared/types.js";
import type { AgentPulseClient, AuthMeResponse } from "./client.js";

export const FAKE_STATS: DashboardStats = {
	activeSessions: 3,
	totalSessionsToday: 7,
	totalToolUsesToday: 42,
	byAgentType: { claude_code: 2, codex_cli: 1 },
};

export const FAKE_AUTH_ME: AuthMeResponse = {
	authenticated: true,
	user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["*"] },
	signOutUrl: null,
	disableAuth: false,
	allowSignup: false,
};

function notStubbed(name: string) {
	return async () => {
		throw new Error(`fakeClient: ${name} was called but not stubbed for this test`);
	};
}

export function fakeClient(overrides: Partial<AgentPulseClient> = {}): AgentPulseClient {
	const base = {
		baseUrl: "http://localhost:3000/api/v1",
		getStats: async () => FAKE_STATS,
		getAuthMe: async () => FAKE_AUTH_ME,
		getSessions: notStubbed("getSessions"),
		getSession: notStubbed("getSession"),
		getSessionTimeline: notStubbed("getSessionTimeline"),
		getEventContext: notStubbed("getEventContext"),
		getSessionClaudeMd: notStubbed("getSessionClaudeMd"),
		search: notStubbed("search"),
		listProjects: notStubbed("listProjects"),
		getSessionIntelligence: notStubbed("getSessionIntelligence"),
		getDigest: notStubbed("getDigest"),
		getAiStatus: notStubbed("getAiStatus"),
		getAiDiagnostics: notStubbed("getAiDiagnostics"),
		listTemplates: notStubbed("listTemplates"),
		getTemplate: notStubbed("getTemplate"),
		listLaunches: notStubbed("listLaunches"),
		getLaunch: notStubbed("getLaunch"),
		getInbox: notStubbed("getInbox"),
	};
	// Spreading a Partial<AgentPulseClient> over a fully-populated base
	// widens every overlapping property's inferred type to include
	// `| undefined` (TS's spread-merge takes the type from whichever
	// operand appears last in source order) — a cast is required even
	// though every property is concretely present at runtime.
	return { ...base, ...overrides } as AgentPulseClient;
}
