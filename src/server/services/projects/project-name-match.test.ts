import { describe, expect, test } from "bun:test";
import { levenshtein, matchProjectByName, normalizeProjectName } from "./project-name-match.js";

describe("normalizeProjectName", () => {
	test("collapses whitespace, dashes, underscores, dots, parens to a single canonical form", () => {
		const variants = [
			"Agent Pulse",
			"agent pulse",
			"agent-pulse",
			"Agent-Pulse",
			"agent_pulse",
			"Agent.Pulse",
			"(agent pulse)",
			"agentpulse",
			"  agent  pulse  ",
		];
		for (const v of variants) {
			expect(normalizeProjectName(v)).toBe("agentpulse");
		}
	});

	test("returns empty string for input with only punctuation", () => {
		expect(normalizeProjectName(" - _ . ( ) ")).toBe("");
	});

	test("preserves unicode letters and digits", () => {
		expect(normalizeProjectName("Project 42")).toBe("project42");
	});
});

describe("levenshtein", () => {
	test("returns 0 for identical strings", () => {
		expect(levenshtein("agentpulse", "agentpulse")).toBe(0);
	});

	test("returns the edit distance for short edits", () => {
		expect(levenshtein("agentpulse", "agnetpulse")).toBe(2); // 'ne' transposition counts as 2 ops
		expect(levenshtein("agentpulse", "agentpuls")).toBe(1); // delete
		expect(levenshtein("agentpulse", "agentpulses")).toBe(1); // insert
	});

	test("handles empty strings", () => {
		expect(levenshtein("", "abc")).toBe(3);
		expect(levenshtein("abc", "")).toBe(3);
		expect(levenshtein("", "")).toBe(0);
	});
});

const projects = [
	{ id: "p1", name: "agentpulse", cwd: "/dev/agentpulse" },
	{ id: "p2", name: "monarch", cwd: "/dev/monarch" },
];

describe("matchProjectByName", () => {
	test("returns null on empty candidate or empty project list", () => {
		expect(matchProjectByName("", projects)).toBeNull();
		expect(matchProjectByName("agentpulse", [])).toBeNull();
	});

	test("level 1: exact case-sensitive match wins", () => {
		const r = matchProjectByName("agentpulse", projects);
		expect(r?.matchKind).toBe("exact");
		expect(r?.project.id).toBe("p1");
	});

	test("level 2: case-insensitive match", () => {
		const r = matchProjectByName("AgentPulse", projects);
		expect(r?.matchKind).toBe("case_insensitive");
		expect(r?.project.id).toBe("p1");
	});

	test("level 3: normalized match (whitespace, dashes, dots)", () => {
		expect(matchProjectByName("agent pulse", projects)?.matchKind).toBe("normalized");
		expect(matchProjectByName("Agent Pulse", projects)?.matchKind).toBe("normalized");
		expect(matchProjectByName("agent-pulse", projects)?.matchKind).toBe("normalized");
		expect(matchProjectByName("agent_pulse", projects)?.matchKind).toBe("normalized");
		expect(matchProjectByName("Agent.Pulse", projects)?.matchKind).toBe("normalized");
	});

	test("level 4: typo within distance 2 matches when closest is unique", () => {
		const r = matchProjectByName("agnetpulse", projects);
		expect(r?.matchKind).toBe("typo");
		expect(r?.project.id).toBe("p1");
		expect(r?.distance).toBeLessThanOrEqual(2);
	});

	test("typo: candidate >2 edits away returns null", () => {
		expect(matchProjectByName("totallydifferent", projects)).toBeNull();
	});

	test("typo: ties (multiple projects within 2) return null for disambiguation", () => {
		const tieProjects = [
			{ id: "a", name: "foo", cwd: "/foo" },
			{ id: "b", name: "fop", cwd: "/fop" },
		];
		// "fooo" is distance 1 from "foo" and 2 from "fop" — still unique winner.
		expect(matchProjectByName("fooo", tieProjects)?.project.id).toBe("a");
		// "fopp" is distance 1 from "fop" and 2 from "foo" — still unique winner.
		expect(matchProjectByName("fopp", tieProjects)?.project.id).toBe("b");
		// "fou" is distance 1 from BOTH "foo" and "fop" — ambiguous, return null.
		// Plus "fou" is only 3 chars — also blocked by short-candidate rule.
		expect(matchProjectByName("fou", tieProjects)).toBeNull();
	});

	test("typo: ambiguous tie at the same distance returns null", () => {
		const tieProjects = [
			{ id: "a", name: "alpha", cwd: "/a" },
			{ id: "b", name: "alphz", cwd: "/b" }, // both 1 edit from "alphx"
		];
		expect(matchProjectByName("alphx", tieProjects)).toBeNull();
	});

	test("typo: candidate shorter than 4 chars is refused (avoid 'ap' → 'api')", () => {
		const shortProjects = [
			{ id: "a", name: "api", cwd: "/api" },
			{ id: "b", name: "app", cwd: "/app" },
		];
		expect(matchProjectByName("ap", shortProjects)).toBeNull();
		expect(matchProjectByName("a", shortProjects)).toBeNull();
	});

	test("normalized-form length is what gates the short-candidate rule", () => {
		// "a-b" normalizes to "ab" (2 chars) — typo path is refused even
		// though the raw input has 3 characters.
		expect(matchProjectByName("a-b", [{ id: "x", name: "abc", cwd: "/x" }])).toBeNull();
	});
});
