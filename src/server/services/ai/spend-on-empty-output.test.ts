/**
 * AGEN-79: a provider that answers with no usable text still billed the tokens
 * it produced (a thinking model spends most of its budget on exactly those
 * calls), so the daily cap has to count them. Real adapters over a stub server.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";
import { startLlmStubServer } from "../../test-utils/llm-stub-server.js";
import type { LlmStubServer } from "../../test-utils/llm-stub-server.js";

const { config } = await import("../../config.js");
const { getDb, initializeDatabase } = await import("../../db/client.js");
const { aiDailySpend, events, llmProviders, sessions } = await import("../../db/schema/index.js");
const { createProvider } = await import("./providers-service.js");
const { upsertSetting } = await import("../settings-service.js");
const { AI_FAST_PROVIDER_ID_KEY } = await import("./feature.js");
const { getTodaySpendCents } = await import("./spend-service.js");
const { detectQaIntent } = await import("../ask/launch-intent-detector.js");
const { handleSessionQa } = await import("../ask/ask-qa-handler.js");
const fast = await import("./fast-provider.js");
const { globalCentsForUsage } = await import("./usage-cost.js");

const originalSecretsKey = config.secretsKey;
/** 1,000,000 billed input tokens is 100 cents under the flat rate. */
const BILLED = { input: 1_000_000, output: 0 };

let stub: LlmStubServer;
let fastStub: LlmStubServer;
let fastId: string;

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

beforeAll(async () => {
	await initializeDatabase();
	config.secretsKey = "test-secrets-key-32-characters!!";
	stub = startLlmStubServer();
	fastStub = startLlmStubServer();
	await getDb().delete(llmProviders);
	await createProvider({
		userId: "local",
		name: "default",
		kind: "openai_compatible",
		model: "big",
		baseUrl: stub.baseUrl("openai"),
		apiKey: "k",
		isDefault: true,
	});
	fastId = (
		await createProvider({
			userId: "local",
			name: "fast",
			kind: "openai_compatible",
			model: "small",
			baseUrl: fastStub.baseUrl("openai"),
			apiKey: "k",
		})
	).id;
});
afterAll(async () => {
	await upsertSetting(AI_FAST_PROVIDER_ID_KEY, "", { allowProtected: true });
	await getDb().delete(aiDailySpend);
	config.secretsKey = originalSecretsKey;
	await stub.stop();
	await fastStub.stop();
});
beforeEach(async () => {
	await getDb().delete(aiDailySpend);
	await upsertSetting(AI_FAST_PROVIDER_ID_KEY, "", { allowProtected: true });
	fast.__resetFastProviderForTests();
	stub.reset();
	fastStub.reset();
});
afterEach(() => {
	stub.verify();
	fastStub.verify();
});

describe("empty replies are charged to the daily cap", () => {
	test("an intent classifier whose reply was empty", async () => {
		stub.script("openai", { text: "", stop: "length", usage: BILLED });
		const r = await detectQaIntent("summarize session alpha");
		expect(r.kind).toBe("classifier_failed");
		expect(r).toMatchObject({ subType: "empty_output" });
		await settle();
		expect(await getTodaySpendCents()).toBe(100);
	});

	test("a per-session Q&A answer whose reply was empty, and the user is told so", async () => {
		await getDb().delete(events);
		await getDb().delete(sessions);
		await getDb().insert(sessions).values({
			sessionId: "qa-s",
			displayName: "qa session",
			agentType: "claude_code",
			status: "active",
		});
		await getDb()
			.insert(events)
			.values({
				sessionId: "qa-s",
				eventType: "UserPromptSubmit",
				category: "prompt",
				source: "observed_hook",
				rawPayload: { prompt: "hello" },
				content: "hello",
			});
		stub.script("openai", { text: "", stop: "length", usage: BILLED });
		const r = await handleSessionQa(
			{ kind: "qa", sessionHint: null, question: "what happened?" },
			{ origin: "web", threadId: "t" },
		);
		expect(r.replyText).toContain("didn't produce an answer");
		await settle();
		expect(await getTodaySpendCents()).toBe(100);
	});

	test("the failed attempt on the fast provider, as well as the default's answer", async () => {
		await upsertSetting(AI_FAST_PROVIDER_ID_KEY, fastId, { allowProtected: true });
		fastStub.script("openai", { text: "", stop: "length", usage: BILLED });
		stub.script("openai", {
			text: '{"intent":"none"}',
			stop: "stop",
			usage: { input: 10, output: 5 },
		});
		const r = await detectQaIntent("hello");
		expect(r.kind).toBe("none");
		await settle();
		// 100 for the empty fast attempt, 1 for the default's small answer.
		expect(await getTodaySpendCents()).toBe(101);
	});

	test("usage that was only estimated is charged the caller's flat estimate", () => {
		expect(globalCentsForUsage({ inputTokens: 5, outputTokens: 5, estimated: true }, 3)).toBe(3);
		expect(globalCentsForUsage({ inputTokens: 5, outputTokens: 5, estimated: false }, 3)).toBe(1);
	});

	test("a failure that carries no usage (a 500) charges nothing", async () => {
		stub.script("openai", { text: "", status: 500, errorBody: "boom" });
		await detectQaIntent("hello");
		await settle();
		expect(await getTodaySpendCents()).toBe(0);
	});
});
