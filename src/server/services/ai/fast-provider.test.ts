/**
 * AGEN-79: the fast provider. Small, latency-sensitive calls go to it first and
 * fall back, once, to the default provider. Real adapters, real HTTP to two
 * stub servers (the default provider is an Anthropic-shaped endpoint, the fast
 * one an OpenAI-shaped one), real provider rows and settings.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test,
} from "bun:test";
import "./__test_db.js";
import { startLlmStubServer } from "../../test-utils/llm-stub-server.js";
import type { LlmStubServer } from "../../test-utils/llm-stub-server.js";

const { config } = await import("../../config.js");
const { getDb, initializeDatabase } = await import("../../db/client.js");
const { llmProviders } = await import("../../db/schema/index.js");
const { createProvider, deleteProvider } = await import("./providers-service.js");
const { upsertSetting } = await import("../settings-service.js");
const { AI_FAST_PROVIDER_ID_KEY } = await import("./feature.js");
const { detectQaIntent } = await import("../ask/launch-intent-detector.js");
const fast = await import("./fast-provider.js");

const originalSecretsKey = config.secretsKey;
const NONE = '{"intent":"none"}';
const QA = JSON.stringify({ intent: "qa", sessionHint: "alpha" });

let defaultStub: LlmStubServer;
let fastStub: LlmStubServer;
let defaultId: string;
let fastId: string;
let nowMs: number;

const setFast = (id: string | null) =>
	upsertSetting(AI_FAST_PROVIDER_ID_KEY, id ?? "", { allowProtected: true });

function warnings() {
	const lines: Array<Record<string, unknown>> = [];
	const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		if (typeof args[0] !== "string") return;
		try {
			lines.push(JSON.parse(args[0]));
		} catch {
			// not structured
		}
	});
	return { lines, restore: () => spy.mockRestore() };
}

beforeAll(async () => {
	await initializeDatabase();
	config.secretsKey = "test-secrets-key-32-characters!!";
	defaultStub = startLlmStubServer();
	fastStub = startLlmStubServer();
	await getDb().delete(llmProviders);
	defaultId = (
		await createProvider({
			userId: "local",
			name: "default-provider",
			kind: "anthropic",
			model: "big-model",
			baseUrl: defaultStub.baseUrl("anthropic"),
			apiKey: "sk-default",
			isDefault: true,
		})
	).id;
	fastId = (
		await createProvider({
			userId: "local",
			name: "fast-provider",
			kind: "openai_compatible",
			model: "small-model",
			baseUrl: fastStub.baseUrl("openai"),
			apiKey: "sk-fast",
		})
	).id;
});
afterAll(async () => {
	await setFast(null);
	config.secretsKey = originalSecretsKey;
	await defaultStub.stop();
	await fastStub.stop();
});
beforeEach(async () => {
	nowMs = 5_000_000;
	fast.__resetFastProviderForTests(() => nowMs);
	defaultStub.reset();
	fastStub.reset();
	await setFast(fastId);
});
afterEach(() => {
	defaultStub.verify();
	fastStub.verify();
});

describe("which provider answers a small call", () => {
	test("no fast provider set: the default answers, as before", async () => {
		await setFast(null);
		defaultStub.script("anthropic", { text: QA, stop: "end_turn" });
		const r = await detectQaIntent("summarize session alpha");
		expect(r.kind).toBe("qa");
		expect(defaultStub.requests("anthropic")).toHaveLength(1);
		expect(fastStub.requests()).toHaveLength(0);
	});

	test("a fast provider set: it answers, with its own model and reasoning off, and the default is not called", async () => {
		fastStub.script("openai", { text: QA, stop: "stop" });
		const r = await detectQaIntent("summarize session alpha");
		expect(r.kind).toBe("qa");
		expect(defaultStub.requests()).toHaveLength(0);
		const body = JSON.parse(fastStub.requests("openai")[0]?.body ?? "{}");
		expect(body.model).toBe("small-model");
		expect(body.reasoning_effort).toBe("none");
	});

	test("the fast provider being the default itself, or deleted, changes nothing", async () => {
		await setFast(defaultId);
		defaultStub.script("anthropic", { text: NONE, stop: "end_turn" });
		await detectQaIntent("hello");
		expect(defaultStub.requests("anthropic")).toHaveLength(1);
		expect(fastStub.requests()).toHaveLength(0);

		const gone = await createProvider({
			userId: "local",
			name: "temp",
			kind: "openai_compatible",
			model: "m",
			baseUrl: fastStub.baseUrl("openai"),
			apiKey: "k",
		});
		await setFast(gone.id);
		await deleteProvider(gone.id);
		defaultStub.script("anthropic", { text: NONE, stop: "end_turn" });
		await detectQaIntent("hello again");
		expect(defaultStub.requests("anthropic")).toHaveLength(2);
		expect(fastStub.requests()).toHaveLength(0);
	});
});

describe("when the fast provider fails", () => {
	test("the call is made again, once, on the default provider, and the caller gets that answer", async () => {
		fastStub.script("openai", { text: "", status: 500, errorBody: "overloaded" });
		defaultStub.script("anthropic", { text: QA, stop: "end_turn" });
		const log = warnings();
		try {
			const r = await detectQaIntent("summarize session alpha");
			expect(r.kind).toBe("qa");
			expect(fastStub.requests("openai")).toHaveLength(1);
			expect(defaultStub.requests("anthropic")).toHaveLength(1);
			const body = JSON.parse(defaultStub.requests("anthropic")[0]?.body ?? "{}");
			expect(body.model).toBe("big-model");
			const entry = log.lines.find((l) => l.kind === "ai_fast_provider_fallback");
			expect(entry).toMatchObject({ level: "warn", fastProviderId: fastId });
			// The log carries no content: not the message, not the provider's error text.
			const raw = JSON.stringify(log.lines);
			expect(raw).not.toContain("summarize session alpha");
			expect(raw).not.toContain("overloaded");
		} finally {
			log.restore();
		}
	});

	test("an empty reply from the fast model counts as a failure and falls back too", async () => {
		fastStub.script("openai", { text: "", stop: "length" });
		defaultStub.script("anthropic", { text: QA, stop: "end_turn" });
		const log = warnings();
		try {
			expect((await detectQaIntent("summarize session alpha")).kind).toBe("qa");
			expect(log.lines.find((l) => l.kind === "ai_fast_provider_fallback")).toMatchObject({
				subType: "empty_output",
			});
		} finally {
			log.restore();
		}
	});

	test("while it cools down the next calls skip it, and it is tried again afterwards", async () => {
		fastStub.script("openai", { text: "", status: 500, errorBody: "down" });
		defaultStub.script(
			"anthropic",
			{ text: NONE, stop: "end_turn" },
			{ text: NONE, stop: "end_turn" },
			{ text: NONE, stop: "end_turn" },
		);
		const log = warnings();
		try {
			await detectQaIntent("one");
			await detectQaIntent("two");
			nowMs += fast.FAST_PROVIDER_COOLDOWN_MS - 1;
			await detectQaIntent("three");
			expect(fastStub.requests("openai")).toHaveLength(1); // only the first call tried it
			expect(defaultStub.requests("anthropic")).toHaveLength(3);

			nowMs += 1;
			fastStub.script("openai", { text: NONE, stop: "stop" });
			await detectQaIntent("four");
			expect(fastStub.requests("openai")).toHaveLength(2); // tried again, and answered
			expect(defaultStub.requests("anthropic")).toHaveLength(3);
		} finally {
			log.restore();
		}
	});

	test("if the default also fails, the caller sees the classifier failure, not a second fallback", async () => {
		fastStub.script("openai", { text: "", status: 500, errorBody: "x" });
		defaultStub.script("anthropic", { text: "", status: 500, errorBody: "y" });
		const log = warnings();
		try {
			const r = await detectQaIntent("summarize session alpha");
			expect(r.kind).toBe("classifier_failed");
			expect(fastStub.requests("openai")).toHaveLength(1);
			expect(defaultStub.requests("anthropic")).toHaveLength(1);
		} finally {
			log.restore();
		}
	});
});
