import { describe, expect, test } from "bun:test";
import type { CachedProject } from "../projects/cache.js";
import { gatePasses } from "./launch-intent-detector.js";

const projects: CachedProject[] = [
	{ id: "p1", name: "agentpulse", cwd: "/Users/me/dev/agentpulse" },
	{ id: "p2", name: "monarch", cwd: "/Users/me/dev/Monarch" },
];

describe("gatePasses", () => {
	test("passes for 'create a plan in agentpulse about caching'", () => {
		expect(gatePasses("create a plan in agentpulse about caching", projects)).toBe(true);
	});

	test("passes for 'fix the failing tests in agentpulse'", () => {
		expect(gatePasses("fix the failing tests in agentpulse", projects)).toBe(true);
	});

	test("passes question-flavored phrasings when an action verb is present (classifier decides intent)", () => {
		// The gate is a cheap pre-filter. False positives from question phrasings
		// that happen to mention a project + action verb are intended — the LLM
		// classifier returns intent:none for non-launch messages.
		expect(gatePasses("can you check on agentpulse?", projects)).toBe(true);
	});

	test("rejects 'just thinking' (no action verb, no project)", () => {
		expect(gatePasses("just thinking", projects)).toBe(false);
	});

	test("passes 'create a plan' even when no projects are configured (task-flavor phrase)", () => {
		// Gate must pass so the classifier can return launch_needs_project.
		// Whether to launch or not is decided downstream.
		expect(gatePasses("create a plan", [])).toBe(true);
	});

	test("rejects messages with no action verb and no project name", () => {
		expect(gatePasses("hello world", [])).toBe(false);
		expect(gatePasses("a sentence with nothing actionable", [])).toBe(false);
	});

	test("rejects message with action verb but no project and no task-flavor phrase", () => {
		expect(gatePasses("create something useful for life", projects)).toBe(false);
	});

	test("passes when an action verb is paired with a task-flavor phrase even without a project", () => {
		// Gate must pass so the classifier can return launch_needs_project
		// for the disambiguation flow.
		expect(gatePasses("create a plan about caching strategies", projects)).toBe(true);
		expect(gatePasses("fix the failing tests", projects)).toBe(true);
		expect(gatePasses("write a draft about onboarding", projects)).toBe(true);
	});

	test("preserves the original launch-verb coverage", () => {
		expect(gatePasses("launch agentpulse", projects)).toBe(true);
		expect(gatePasses("spin up agentpulse", projects)).toBe(true);
		expect(gatePasses("kick off agentpulse", projects)).toBe(true);
	});
});
