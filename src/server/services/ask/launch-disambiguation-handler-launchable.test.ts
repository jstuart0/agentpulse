import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../../db/client.js");
const { aiPendingProjectDrafts, askThreads, launchRequests, aiActionRequests, sessions, projects } =
	await import("../../db/schema/index.js");
const { resolveLaunchDisambiguation } = await import("./launch-disambiguation-handler.js");

import type { ProjectChoiceSnapshot } from "../../db/schema/index.js";

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(aiPendingProjectDrafts).execute();
	await getDb().delete(askThreads).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(aiActionRequests).execute();
	await getDb().delete(projects).execute();
	await getDb().delete(sessions).execute();
});

const choices: ProjectChoiceSnapshot[] = [{ id: "p1", name: "agentpulse", cwd: "/tmp/agentpulse" }];

async function countLaunchAndActionRows() {
	const lr = await getDb().select().from(launchRequests).execute();
	const ar = await getDb().select().from(aiActionRequests).execute();
	return lr.length + ar.length;
}

async function seedDraft(draftFields: Record<string, unknown>) {
	const threadId = crypto.randomUUID();
	const now = new Date().toISOString();
	await getDb()
		.insert(askThreads)
		.values({ id: threadId, title: "test", origin: "web", createdAt: now, updatedAt: now })
		.execute();
	const [draft] = await getDb()
		.insert(aiPendingProjectDrafts)
		.values({
			askThreadId: threadId,
			channelId: null,
			origin: "web",
			kind: "launch_disambiguation",
			draftFields,
			nextQuestion: { field: "name", prompt: "project_choice", retryCount: 0 },
			status: "drafting",
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	return { threadId, draft };
}

const REFUSAL = "Copilot CLI can't be launched — AgentPulse can only launch Claude Code or Codex.";

describe("launch-disambiguation-handler — D5 Pattern A' non-launchable agentType refusal", () => {
	test("numeric_choice (:403/:427 shared guard) refuses before reconstructing a launch", async () => {
		const { threadId, draft } = await seedDraft({
			originalMessage: "x",
			agentType: "copilot_cli",
			proposedProjectChoices: choices,
		});
		const result = await resolveLaunchDisambiguation({
			draft,
			reply: "1",
			origin: "web",
			threadId,
		});
		expect(result.replyText).toBe(REFUSAL);
		expect(result.actionRequestId).toBeNull();
		expect(await countLaunchAndActionRows()).toBe(0);
	});

	test("absolute_path reply (same shared guard) refuses before reconstructing a launch", async () => {
		const { threadId, draft } = await seedDraft({
			originalMessage: "x",
			agentType: "copilot_cli",
			proposedProjectChoices: choices,
		});
		const result = await resolveLaunchDisambiguation({
			draft,
			reply: "/tmp/agentpulse",
			origin: "web",
			threadId,
		});
		expect(result.replyText).toBe(REFUSAL);
		expect(result.actionRequestId).toBeNull();
		expect(await countLaunchAndActionRows()).toBe(0);
	});

	test(":901 executeScaffoldConfirm refuses before creating a project", async () => {
		const { threadId, draft } = await seedDraft({
			originalMessage: "x",
			agentType: "copilot_cli",
			proposedProjectChoices: choices,
			pendingScaffold: {
				taskSlug: "plan-caching",
				resolvedPath: "/tmp/plan-caching",
				actions: [{ kind: "scaffold_workarea", path: "/tmp/plan-caching" }],
			},
		});
		const result = await resolveLaunchDisambiguation({
			draft,
			reply: "confirm",
			origin: "web",
			threadId,
		});
		expect(result.replyText).toBe(REFUSAL);
		expect(result.actionRequestId).toBeNull();
		expect(await countLaunchAndActionRows()).toBe(0);
		const projectRows = await getDb().select().from(projects).execute();
		expect(projectRows.length).toBe(0);
	});

	test(":1476 executeCloneConfirm refuses before creating a project", async () => {
		const { threadId, draft } = await seedDraft({
			originalMessage: "x",
			agentType: "copilot_cli",
			proposedProjectChoices: choices,
			pendingClone: {
				taskSlug: "bar",
				resolvedPath: "/tmp/bar",
				url: "https://github.com/foo/bar.git",
				timeoutSeconds: 300,
				actions: [
					{ kind: "clone_repo", url: "https://github.com/foo/bar.git", intoPath: "/tmp/bar" },
				],
			},
		});
		const result = await resolveLaunchDisambiguation({
			draft,
			reply: "confirm",
			origin: "web",
			threadId,
		});
		expect(result.replyText).toBe(REFUSAL);
		expect(result.actionRequestId).toBeNull();
		expect(await countLaunchAndActionRows()).toBe(0);
		const projectRows = await getDb().select().from(projects).execute();
		expect(projectRows.length).toBe(0);
	});

	test("claude_code proceeds past the guard (reaches project resolution, not a refusal)", async () => {
		const { threadId, draft } = await seedDraft({
			originalMessage: "x",
			agentType: "claude_code",
			proposedProjectChoices: choices,
		});
		const result = await resolveLaunchDisambiguation({
			draft,
			reply: "1",
			origin: "web",
			threadId,
		});
		expect(result.replyText).not.toBe(REFUSAL);
	});
});
