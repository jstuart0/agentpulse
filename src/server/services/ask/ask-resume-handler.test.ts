import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";
import { deleteAllSupervisors } from "../__test_supervisors.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { sessions, launchRequests } = await import("../../db/schema/index.js");
const { handleResumeIntent } = await import("./ask-resume-handler.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await deleteAllSupervisors();
	await getDb().delete(sessions).execute();
	await getDb().delete(launchRequests).execute();
});

async function seedSession(agentType: string, overrides: Record<string, unknown> = {}) {
	const sessionId = crypto.randomUUID();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: "resume-me",
			agentType,
			status: "completed",
			cwd: "/tmp/work",
			isArchived: false,
			...overrides,
		})
		.execute();
	return sessionId;
}

describe("handleResumeIntent — D5 Pattern A'", () => {
	test("a non-launchable parent with no intent.agentType returns refusal copy naming the agent's label, and creates zero launchRequests rows", async () => {
		await seedSession("copilot_cli");
		const result = await handleResumeIntent({
			intent: { kind: "resume", sessionHint: null, newPrompt: "keep going" },
			origin: "web",
			threadId: crypto.randomUUID(),
		});
		expect(result.replyText).toBe(
			"Resume isn't supported for Copilot CLI sessions — AgentPulse can only launch Claude Code or Codex.",
		);
		expect(result.actionRequestId).toBeNull();
		const rows = await getDb().select().from(launchRequests).execute();
		expect(rows.length).toBe(0);
	});

	test("a non-launchable parent with an explicit launchable intent.agentType proceeds with the intent's agent", async () => {
		await seedSession("copilot_cli");
		const result = await handleResumeIntent({
			intent: {
				kind: "resume",
				sessionHint: null,
				newPrompt: "keep going",
				agentType: "claude_code",
			},
			origin: "web",
			threadId: crypto.randomUUID(),
		});
		expect(result.replyText).not.toContain("Resume isn't supported");
	});

	test("a launchable parent with no intent.agentType proceeds using the parent's own agent type", async () => {
		await seedSession("codex_cli");
		const result = await handleResumeIntent({
			intent: { kind: "resume", sessionHint: null, newPrompt: "keep going" },
			origin: "web",
			threadId: crypto.randomUUID(),
		});
		expect(result.replyText).not.toContain("Resume isn't supported");
	});
});
