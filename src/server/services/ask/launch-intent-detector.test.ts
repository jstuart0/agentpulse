import { describe, expect, test } from "bun:test";
import type { CachedProject } from "../projects/cache.js";
import { gatePasses, parseLaunchIntentResponse } from "./launch-intent-detector.js";

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

	test("passes 'clone github.com/foo/bar' (clone verb + github phrase)", () => {
		expect(gatePasses("clone github.com/foo/bar", projects)).toBe(true);
	});

	test("passes 'check out the repo at github.com/x/y'", () => {
		expect(gatePasses("check out the repo at github.com/x/y", projects)).toBe(true);
	});
});

describe("parseLaunchIntentResponse", () => {
	test("parses launch_needs_project with cloneSpec containing url + branch", () => {
		const result = parseLaunchIntentResponse(
			{
				intent: "launch_needs_project",
				taskHint: "auth refactor",
				cloneSpec: { url: "https://github.com/foo/bar.git", branch: "main" },
			},
			projects,
		);
		expect(result.kind).toBe("launch_needs_project");
		if (result.kind !== "launch_needs_project") throw new Error("unreachable");
		expect(result.cloneSpec).toEqual({
			url: "https://github.com/foo/bar.git",
			branch: "main",
			depth: undefined,
		});
		expect(result.taskHint).toBe("auth refactor");
	});

	test("parses launch with cloneSpec when project is named", () => {
		const result = parseLaunchIntentResponse(
			{
				intent: "launch",
				projectName: "agentpulse",
				cloneSpec: { url: "https://github.com/foo/bar.git" },
			},
			projects,
		);
		expect(result.kind).toBe("launch");
		if (result.kind !== "launch") throw new Error("unreachable");
		expect(result.cloneSpec).toEqual({
			url: "https://github.com/foo/bar.git",
			branch: undefined,
			depth: undefined,
		});
	});

	test("drops cloneSpec entirely when url is empty (defensive)", () => {
		const result = parseLaunchIntentResponse(
			{ intent: "launch_needs_project", cloneSpec: { url: "" } },
			projects,
		);
		expect(result.kind).toBe("launch_needs_project");
		if (result.kind !== "launch_needs_project") throw new Error("unreachable");
		expect(result.cloneSpec).toBeUndefined();
	});

	test("drops cloneSpec entirely when url is missing (defensive)", () => {
		const result = parseLaunchIntentResponse(
			{ intent: "launch_needs_project", cloneSpec: { branch: "main" } },
			projects,
		);
		expect(result.kind).toBe("launch_needs_project");
		if (result.kind !== "launch_needs_project") throw new Error("unreachable");
		expect(result.cloneSpec).toBeUndefined();
	});

	test("drops cloneSpec entirely when url is not a string (defensive)", () => {
		const result = parseLaunchIntentResponse(
			{ intent: "launch_needs_project", cloneSpec: { url: 42 } },
			projects,
		);
		expect(result.kind).toBe("launch_needs_project");
		if (result.kind !== "launch_needs_project") throw new Error("unreachable");
		expect(result.cloneSpec).toBeUndefined();
	});

	test("drops invalid depth from cloneSpec but keeps url + branch", () => {
		const result = parseLaunchIntentResponse(
			{
				intent: "launch_needs_project",
				cloneSpec: { url: "https://github.com/foo/bar", branch: "main", depth: -1 },
			},
			projects,
		);
		expect(result.kind).toBe("launch_needs_project");
		if (result.kind !== "launch_needs_project") throw new Error("unreachable");
		expect(result.cloneSpec).toEqual({
			url: "https://github.com/foo/bar",
			branch: "main",
			depth: undefined,
		});
	});

	test("keeps positive integer depth", () => {
		const result = parseLaunchIntentResponse(
			{
				intent: "launch_needs_project",
				cloneSpec: { url: "https://github.com/foo/bar", depth: 1 },
			},
			projects,
		);
		expect(result.kind).toBe("launch_needs_project");
		if (result.kind !== "launch_needs_project") throw new Error("unreachable");
		expect(result.cloneSpec?.depth).toBe(1);
	});

	test("backward compat: response without cloneSpec parses cleanly", () => {
		const result = parseLaunchIntentResponse(
			{
				intent: "launch_needs_project",
				taskHint: "fix tests",
				displayName: "fix-tests",
			},
			projects,
		);
		expect(result.kind).toBe("launch_needs_project");
		if (result.kind !== "launch_needs_project") throw new Error("unreachable");
		expect(result.cloneSpec).toBeUndefined();
		expect(result.taskHint).toBe("fix tests");
		expect(result.displayName).toBe("fix-tests");
	});

	test("intent:none short-circuits", () => {
		const result = parseLaunchIntentResponse({ intent: "none" }, projects);
		expect(result.kind).toBe("none");
	});

	test("unknown project name with cloneSpec falls back to launch_needs_project, preserving cloneSpec", () => {
		const result = parseLaunchIntentResponse(
			{
				intent: "launch",
				projectName: "not-a-known-project",
				cloneSpec: { url: "https://github.com/foo/bar" },
			},
			projects,
		);
		expect(result.kind).toBe("launch_needs_project");
		if (result.kind !== "launch_needs_project") throw new Error("unreachable");
		expect(result.cloneSpec?.url).toBe("https://github.com/foo/bar");
	});
});
