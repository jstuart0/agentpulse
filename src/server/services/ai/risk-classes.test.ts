import { beforeAll, describe, expect, test } from "bun:test";
import "./__test_db.js";

const { initializeDatabase } = await import("../../db/client.js");
const { evaluateRisk, getRiskClasses } = await import("./risk-classes.js");

beforeAll(() => {
	initializeDatabase();
});

describe("risk-classes", () => {
	test("default config exposes destructive-command, credential, and test-failure classes", async () => {
		const config = await getRiskClasses();
		const ids = config.classes.map((c) => c.id);
		expect(ids).toContain("destructive_command");
		expect(ids).toContain("credential_touch");
		expect(ids).toContain("test_failure_recent");
	});

	test("regex rule matches a destructive command prompt", async () => {
		const config = await getRiskClasses();
		const hits = evaluateRisk(config, {
			proposedPrompt: "please run rm -rf / and clean up",
			recentToolEvents: [],
		});
		expect(hits.some((h) => h.classId === "destructive_command")).toBe(true);
	});

	test("credential regex matches api key references", async () => {
		const config = await getRiskClasses();
		const hits = evaluateRisk(config, {
			proposedPrompt: "check the api-key setup for our service",
			recentToolEvents: [],
		});
		expect(hits.some((h) => h.classId === "credential_touch")).toBe(true);
	});

	test("heuristic rule fires on multiple recent tool failures", async () => {
		const config = await getRiskClasses();
		const hits = evaluateRisk(config, {
			proposedPrompt: "next step",
			recentToolEvents: [
				{
					category: "tool_event",
					toolResponse: "tests failed",
					source: "observed_hook",
					eventType: "PostToolUse",
				},
				{
					category: "tool_event",
					toolResponse: "error: exit 1",
					source: "observed_hook",
					eventType: "PostToolUse",
				},
			],
		});
		expect(hits.some((h) => h.classId === "test_failure_recent")).toBe(true);
	});

	test("no hits for a benign prompt with clean history", async () => {
		const config = await getRiskClasses();
		const hits = evaluateRisk(config, {
			proposedPrompt: "add a comment to this function",
			recentToolEvents: [
				{
					category: "tool_event",
					toolResponse: "OK",
					source: "observed_hook",
					eventType: "PostToolUse",
				},
			],
		});
		expect(hits.length).toBe(0);
	});
});
