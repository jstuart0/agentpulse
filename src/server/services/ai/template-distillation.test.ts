import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { events, sessions, sessionTemplates, projects } = await import("../../db/schema/index.js");
const { distillTemplate, provenanceMetadata } = await import("./template-distillation.js");

beforeAll(() => {
	return initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(sessionTemplates).execute();
	await getDb().delete(projects).execute();
});

async function mkSession(sessionId: string, overrides: Record<string, unknown> = {}) {
	await getDb()
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
	await getDb()
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
		await getDb()
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

const AGENT_TYPE_SUBSTITUTED_NOTE = "agent_type_substituted: copilot_cli is observe-only";

describe("template-distillation — D5 Pattern A' agentType substitution", () => {
	test("an observe-only session with no base and no project falls back to codex_cli, with a provenance note", async () => {
		await mkSession("obs1", { agentType: "copilot_cli", cwd: null });
		await mkEvent("obs1", "prompt", "hello");

		const draft = await distillTemplate({ sessionId: "obs1" });
		expect(draft?.draft.agentType).toBe("codex_cli");
		expect(draft?.notes).toContain(AGENT_TYPE_SUBSTITUTED_NOTE);

		if (!draft) throw new Error("draft null");
		const meta = provenanceMetadata(draft, null);
		expect(meta.provenance.notes).toContain(AGENT_TYPE_SUBSTITUTED_NOTE);
	});

	test("an observe-only session with a registered project falls back to the project's default agent type", async () => {
		await getDb()
			.insert(projects)
			.values({ id: "proj1", name: "P", cwd: "/tmp/obsproj", defaultAgentType: "codex_cli" })
			.execute();
		await mkSession("obs2", { agentType: "copilot_cli", cwd: "/tmp/obsproj" });
		await mkEvent("obs2", "prompt", "hello");

		const draft = await distillTemplate({ sessionId: "obs2" });
		expect(draft?.draft.agentType).toBe("codex_cli");
		expect(draft?.notes).toContain(AGENT_TYPE_SUBSTITUTED_NOTE);
	});

	test("when base is provided, the substitution never overrides it, and no provenance note is added, even for an observe-only session", async () => {
		await getDb()
			.insert(sessionTemplates)
			.values({
				id: "tpl-launchable",
				name: "Base",
				agentType: "claude_code",
				cwd: "/existing",
				baseInstructions: "",
				taskPrompt: "",
			})
			.execute();
		await mkSession("obs3", { agentType: "copilot_cli" });
		await mkEvent("obs3", "prompt", "hello");

		const draft = await distillTemplate({ sessionId: "obs3", baseTemplateId: "tpl-launchable" });
		expect(draft?.draft.agentType).toBe("claude_code");
		expect(draft?.notes).not.toContain(AGENT_TYPE_SUBSTITUTED_NOTE);
	});

	test("a launchable session is unchanged, with no provenance note", async () => {
		await mkSession("launchable1", { agentType: "claude_code" });
		await mkEvent("launchable1", "prompt", "hello");

		const draft = await distillTemplate({ sessionId: "launchable1" });
		expect(draft?.draft.agentType).toBe("claude_code");
		expect(draft?.notes).not.toContain(AGENT_TYPE_SUBSTITUTED_NOTE);
	});
});
