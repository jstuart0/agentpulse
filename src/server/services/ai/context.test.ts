import { describe, expect, test } from "bun:test";
import type { Session, SessionEvent } from "../../../shared/types.js";
import { buildWatcherContext } from "./context.js";

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: "s-1",
		sessionId: "sess-1",
		displayName: "brave-falcon",
		agentType: "claude_code",
		status: "active",
		cwd: "/Users/test/project",
		transcriptPath: null,
		model: "claude-sonnet-4-6",
		startedAt: new Date().toISOString(),
		lastActivityAt: new Date().toISOString(),
		endedAt: null,
		semanticStatus: null,
		currentTask: "implement feature",
		planSummary: ["step one", "step two"],
		totalToolUses: 0,
		isWorking: false,
		isPinned: false,
		gitBranch: "main",
		claudeMdContent: null,
		claudeMdPath: null,
		claudeMdUpdatedAt: null,
		notes: null,
		metadata: {},
		projectId: null,
		...overrides,
	};
}

function makeEvent(overrides: Partial<SessionEvent> = {}): SessionEvent {
	return {
		id: 1,
		sessionId: "sess-1",
		eventType: "UserPromptSubmit",
		category: "prompt",
		source: "observed_hook",
		content: "please do the thing",
		isNoise: false,
		providerEventType: null,
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: {},
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("buildWatcherContext", () => {
	test("produces a system prompt with session identity", () => {
		const ctx = buildWatcherContext({
			session: makeSession(),
			events: [],
			triggerType: "idle",
		});
		expect(ctx.systemPrompt).toContain("brave-falcon");
		expect(ctx.systemPrompt).toContain("claude_code");
		expect(ctx.systemPrompt).toContain("/Users/test/project");
		expect(ctx.systemPrompt).toContain("main");
	});

	test("always includes the decision schema in the system prompt", () => {
		const ctx = buildWatcherContext({
			session: makeSession(),
			events: [],
			triggerType: "idle",
		});
		for (const keyword of ["continue", "ask", "report", "stop", "wait"]) {
			expect(ctx.systemPrompt).toContain(keyword);
		}
	});

	test("embeds events inside a marked untrusted block", () => {
		const ctx = buildWatcherContext({
			session: makeSession(),
			events: [makeEvent({ content: "hello" })],
			triggerType: "idle",
		});
		expect(ctx.transcriptPrompt).toContain("<transcript>");
		expect(ctx.transcriptPrompt).toContain("</transcript>");
		expect(ctx.transcriptPrompt).toContain("UNTRUSTED data");
	});

	test("redacts secrets in events before embedding", () => {
		const leaky = makeEvent({
			content: "here is the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz12",
		});
		const ctx = buildWatcherContext({
			session: makeSession(),
			events: [leaky],
			triggerType: "idle",
		});
		expect(ctx.transcriptPrompt).not.toContain("sk-ant-api03");
		expect(ctx.transcriptPrompt).toContain("REDACTED");
		expect(ctx.redactionHits).toBeGreaterThan(0);
	});

	test("drops old events when the token budget is small", () => {
		const events = Array.from({ length: 50 }, (_, i) =>
			makeEvent({
				id: i,
				content: `some content ${i} `.repeat(40),
				createdAt: new Date(Date.now() - (50 - i) * 1000).toISOString(),
			}),
		);
		const ctx = buildWatcherContext({
			session: makeSession(),
			events,
			triggerType: "idle",
			transcriptTokenBudget: 200, // very small
		});
		expect(ctx.eventsDropped).toBeGreaterThan(0);
		expect(ctx.eventsIncluded).toBeGreaterThan(0);
	});

	test("respects a time budget", () => {
		const events = [
			makeEvent({
				id: 1,
				content: "old event",
				createdAt: new Date(Date.now() - 3600_000).toISOString(),
			}),
			makeEvent({
				id: 2,
				content: "recent event",
				createdAt: new Date().toISOString(),
			}),
		];
		const ctx = buildWatcherContext({
			session: makeSession(),
			events,
			triggerType: "idle",
			transcriptTimeBudgetMs: 60_000, // last minute only
		});
		expect(ctx.transcriptPrompt).toContain("recent event");
		expect(ctx.transcriptPrompt).not.toContain("old event");
	});

	test("honors customSystemPrompt", () => {
		const ctx = buildWatcherContext({
			session: makeSession(),
			events: [],
			triggerType: "idle",
			customSystemPrompt: "You are a concise watcher. Always respond with JSON.",
		});
		expect(ctx.systemPrompt).toContain("concise watcher");
		// Still appends session identity block after the custom prompt.
		expect(ctx.systemPrompt).toContain("brave-falcon");
	});

	test("mentions current task and plan in transcript prompt", () => {
		const ctx = buildWatcherContext({
			session: makeSession({
				currentTask: "write tests",
				planSummary: ["analyze", "implement", "verify"],
			}),
			events: [],
			triggerType: "stop",
		});
		expect(ctx.transcriptPrompt).toContain("write tests");
		expect(ctx.transcriptPrompt).toContain("analyze");
		expect(ctx.transcriptPrompt).toContain("verify");
	});
});
