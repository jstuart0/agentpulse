import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { events, sessions, sessionTemplates } = await import("../../db/schema.js");
const { distillTemplate, provenanceMetadata } = await import("./template-distillation.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(events).execute();
	await db.delete(sessions).execute();
	await db.delete(sessionTemplates).execute();
});

async function mkSession(sessionId: string, overrides: Record<string, unknown> = {}) {
	await db
		.insert(sessions)
		.values({
			sessionId,
			agentType: "claude_code",
			status: "active",
			cwd: "/tmp/project",
			displayName: "demo",
			currentTask: "ship feature X",
			...overrides,
		})
		.execute();
}

async function mkEvent(sessionId: string, category: string, content: string) {
	await db
		.insert(events)
		.values({
			sessionId,
			eventType: "X",
			category,
			content,
			source: "observed_hook",
			rawPayload: {},
		})
		.execute();
}

describe("template-distillation", () => {
	test("builds a draft from a session's prompts and task", async () => {
		await mkSession("s1", { claudeMdContent: "# repo notes\nbe concise" });
		await mkEvent("s1", "prompt", "Initial prompt: implement feature X");
		await mkEvent("s1", "prompt", "Add tests for feature X");
		await mkEvent("s1", "assistant_message", "Implementation complete; tests pass.");

		const draft = await distillTemplate({ sessionId: "s1" });
		expect(draft).not.toBeNull();
		expect(draft?.draft.agentType).toBe("claude_code");
		expect(draft?.draft.cwd).toBe("/tmp/project");
		expect(draft?.draft.baseInstructions).toContain("be concise");
		expect(draft?.draft.taskPrompt).toContain("Initial prompt");
		expect(draft?.draft.taskPrompt).toContain("ship feature X");
		expect(draft?.draft.tags).toContain("distilled");
	});

	test("provenanceMetadata emits the expected shape", async () => {
		await mkSession("s2");
		await mkEvent("s2", "prompt", "hello");
		const draft = await distillTemplate({
			sessionId: "s2",
			providerId: "prov1",
			model: "m1",
		});
		if (!draft) throw new Error("draft null");
		const meta = provenanceMetadata(draft, "tpl-42");
		expect(meta).toMatchObject({
			provenance: {
				source: "ai_distillation",
				fromSessionIds: ["s2"],
				fromTemplateId: "tpl-42",
				providerId: "prov1",
				model: "m1",
			},
		});
	});

	test("returns null for a missing session", async () => {
		const res = await distillTemplate({ sessionId: "nonexistent" });
		expect(res).toBeNull();
	});

	test("inherits values from baseTemplateId when provided", async () => {
		await db
			.insert(sessionTemplates)
			.values({
				id: "tpl1",
				name: "Base",
				agentType: "claude_code",
				cwd: "/existing",
				baseInstructions: "existing base",
				taskPrompt: "existing task",
				tags: ["alpha"],
			})
			.execute();
		await mkSession("s3");
		await mkEvent("s3", "prompt", "override me");
		const draft = await distillTemplate({
			sessionId: "s3",
			baseTemplateId: "tpl1",
		});
		expect(draft?.draft.cwd).toBe("/existing");
		expect(draft?.draft.name).toContain("Base (distilled");
		expect(draft?.draft.tags).toContain("alpha");
		expect(draft?.draft.tags).toContain("distilled");
	});
});
