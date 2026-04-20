import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { db, initializeDatabase } = await import("../../db/client.js");
const { events, sessions, supervisors } = await import("../../db/schema.js");
const { recommendLaunch } = await import("./launch-recommender.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(events).execute();
	await db.delete(sessions).execute();
	await db.delete(supervisors).execute();
});

async function mkSession(
	sessionId: string,
	cwd: string,
	status: string,
	agentType = "claude_code",
	model: string | null = null,
) {
	await db
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType,
			status,
			cwd,
			model,
		})
		.execute();
}

async function mkSupervisor(id: string, agentTypes: string[], status = "connected") {
	await db
		.insert(supervisors)
		.values({
			id,
			hostName: `host-${id}`,
			platform: "darwin",
			arch: "arm64",
			version: "1",
			status,
			capabilities: { agentTypes, launchModes: ["interactive_terminal"] },
			trustedRoots: [],
		})
		.execute();
}

describe("launch-recommender", () => {
	test("rationalizes prior completions at same cwd", async () => {
		await mkSession("a", "/p", "completed", "claude_code", "sonnet");
		await mkSession("b", "/p", "completed", "claude_code", "sonnet");
		await mkSupervisor("sup", ["claude_code"]);

		const rec = await recommendLaunch({
			template: {
				name: "t",
				agentType: "claude_code",
				cwd: "/p",
				baseInstructions: "",
				taskPrompt: "",
			},
		});
		expect(rec.rationale.some((r) => r.includes("prior session(s) at this cwd"))).toBe(true);
		expect(rec.confidence).toBeGreaterThan(0.5);
	});

	test("warns when a connected supervisor does not advertise the agent", async () => {
		await mkSupervisor("sup", ["codex_cli"]);
		const rec = await recommendLaunch({
			template: {
				name: "t",
				agentType: "claude_code",
				cwd: "/p",
				baseInstructions: "",
				taskPrompt: "",
			},
		});
		expect(rec.suggestedSupervisorId).toBeNull();
		expect(rec.warnings.some((w) => w.includes("No connected supervisor"))).toBe(true);
	});

	test("suggests an alternative model when a different one historically won", async () => {
		await mkSession("a", "/p", "completed", "claude_code", "sonnet");
		await mkSession("b", "/p", "completed", "claude_code", "sonnet");
		await mkSupervisor("sup", ["claude_code"]);
		const rec = await recommendLaunch({
			template: {
				name: "t",
				agentType: "claude_code",
				cwd: "/p",
				baseInstructions: "",
				taskPrompt: "",
				model: "opus",
			},
		});
		expect(rec.alternatives.some((a) => a.model === "sonnet")).toBe(true);
	});

	test("prefers explicit preferredSupervisorId when connected", async () => {
		await mkSupervisor("a", ["claude_code"]);
		await mkSupervisor("b", ["claude_code"]);
		const rec = await recommendLaunch({
			template: {
				name: "t",
				agentType: "claude_code",
				cwd: "/p",
				baseInstructions: "",
				taskPrompt: "",
			},
			preferredSupervisorId: "b",
		});
		expect(rec.suggestedSupervisorId).toBe("b");
	});
});
