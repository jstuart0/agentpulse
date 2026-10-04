/**
 * tessa's Phase 1 mid-build High finding: agent_refused had no test through
 * ask-service.ts's real wiring — only through the pure parse functions.
 * This drives the actual runAskTurn / runAskTurnStream / resume-gate paths
 * with a mocked classifier response, proving the copy reaches a persisted
 * assistant reply and no launch/resume side effect occurs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import "../ai/__test_db.js";

let mockedClassifierText = "";
// mock.module replaces the module for every file in the process, and a mock is
// not undone when its file ends. Keep the real one and put it back in afterAll,
// or every file that runs after this one gets the fake (AGEN-69 P2-26).
const REGISTRY_PATH = "../ai/llm/registry.js";
const realRegistry = { ...(await import("../ai/llm/registry.js")) };
mock.module(REGISTRY_PATH, () => ({
	getAdapter: () => ({
		complete: async () => ({
			text: mockedClassifierText,
			usage: { estimated: true, inputTokens: 10, outputTokens: 10 },
		}),
	}),
}));

const { config } = await import("../../config.js");
const { getDb, initializeDatabase } = await import("../../db/client.js");
const { askMessages, askThreads, launchRequests, projects } = await import(
	"../../db/schema/index.js"
);
const { createProvider } = await import("../ai/providers-service.js");
const { bumpVersionAndReload } = await import("../projects/cache.js");
const { runAskTurn, runAskTurnStream } = await import("./ask-service.js");

const originalSecretsKey = config.secretsKey;

beforeAll(async () => {
	await initializeDatabase();
	config.secretsKey = "test-secrets-key-32-characters!!";
	await createProvider({
		userId: "local",
		name: "test-provider",
		kind: "anthropic",
		model: "claude-test",
		apiKey: "sk-test-not-real",
		isDefault: true,
	});
});

afterAll(() => {
	config.secretsKey = originalSecretsKey;
	mock.module(REGISTRY_PATH, () => realRegistry);
});

beforeEach(async () => {
	await getDb().delete(askMessages).execute();
	await getDb().delete(askThreads).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(projects).execute();
	await getDb()
		.insert(projects)
		.values({ id: "proj-1", name: "agentpulse", cwd: "/tmp/agentpulse" })
		.execute();
	await bumpVersionAndReload();
});

const TEST_ACTOR = { userId: null, label: "anonymous" as const };
const REFUSAL = "Copilot CLI can't be launched — AgentPulse can only launch Claude Code or Codex.";
const RESUME_REFUSAL =
	"Resume isn't supported for Copilot CLI sessions — AgentPulse can only launch Claude Code or Codex.";

describe("runAskTurn — agent_refused reaches a real persisted reply, no launch created", () => {
	test("a launch-flavored message with agentType:copilot_cli persists the refusal, no launchRequests row", async () => {
		mockedClassifierText = JSON.stringify({
			intent: "launch",
			projectName: "agentpulse",
			agentType: "copilot_cli",
		});
		const result = await runAskTurn({
			message: "launch copilot for agentpulse",
			actor: TEST_ACTOR,
		});
		expect(result.assistantMessage.content).toBe(REFUSAL);
		expect(result.includedSessionIds).toEqual([]);
		const rows = await getDb().select().from(launchRequests).execute();
		expect(rows.length).toBe(0);
	});

	test("a resume-flavored message with agentType:copilot_cli persists the resume refusal", async () => {
		mockedClassifierText = JSON.stringify({
			intent: "resume",
			sessionHint: "some session",
			newPrompt: "keep going",
			agentType: "copilot_cli",
		});
		const result = await runAskTurn({
			message: "resume my session with: keep going",
			actor: TEST_ACTOR,
		});
		expect(result.assistantMessage.content).toBe(RESUME_REFUSAL);
		expect(result.includedSessionIds).toEqual([]);
	});
});

describe("runAskTurnStream — agent_refused streams start/delta/done, no side effects", () => {
	test("a launch-flavored message with agentType:copilot_cli streams the refusal", async () => {
		mockedClassifierText = JSON.stringify({
			intent: "launch",
			projectName: "agentpulse",
			agentType: "copilot_cli",
		});
		const events: Array<{ kind: string }> = [];
		let deltaText = "";
		for await (const event of runAskTurnStream({
			message: "launch copilot for agentpulse",
			actor: TEST_ACTOR,
		})) {
			events.push(event);
			if (event.kind === "delta") deltaText += (event as { delta: string }).delta;
			if (event.kind === "done" || events.length > 10) break;
		}
		expect(events.map((e) => e.kind)).toEqual(["start", "delta", "done"]);
		expect(deltaText).toBe(REFUSAL);
		const rows = await getDb().select().from(launchRequests).execute();
		expect(rows.length).toBe(0);
	});
});
