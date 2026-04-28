import { describe, expect, test } from "bun:test";
import type { WorkspaceSettings } from "./feature.js";
import {
	WorkspaceCollisionExhaustedError,
	applyTemplateTokens,
	scaffoldWorkArea,
	sha256,
} from "./scaffold.js";

const baseSettings: WorkspaceSettings = {
	defaultRoot: "~/agentpulse-work",
	templateClaudeMd: "# {{taskSlug}}\n\n{{taskSummary}}",
	gitInit: false,
};

describe("applyTemplateTokens", () => {
	test("substitutes known tokens", () => {
		expect(applyTemplateTokens("hi {{name}}", { name: "jay" })).toBe("hi jay");
	});

	test("leaves unknown tokens as-is", () => {
		expect(applyTemplateTokens("{{a}} and {{b}}", { a: "x" })).toBe("x and {{b}}");
	});

	test("substitutes empty string when token value is empty", () => {
		expect(applyTemplateTokens("[{{name}}]", { name: "" })).toBe("[]");
	});

	test("ignores tokens with non-word characters", () => {
		expect(applyTemplateTokens("{{ a }}", { a: "x" })).toBe("{{ a }}");
	});
});

describe("sha256", () => {
	test("produces lowercase hex digest", async () => {
		const hash = await sha256("hello world");
		expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("differs across inputs", async () => {
		const a = await sha256("a");
		const b = await sha256("b");
		expect(a).not.toBe(b);
	});
});

describe("scaffoldWorkArea", () => {
	test("uses <root>/<slug> when no collision", async () => {
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			taskSummary: "Plan caching strategies",
			workspaceSettings: baseSettings,
		});
		expect(result.resolvedPath).toBe("~/agentpulse-work/plan-caching");
	});

	test("trims trailing slash on defaultRoot when joining", async () => {
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			workspaceSettings: { ...baseSettings, defaultRoot: "~/agentpulse-work/" },
		});
		expect(result.resolvedPath).toBe("~/agentpulse-work/plan-caching");
	});

	test("does not expand ~ in the resolved path", async () => {
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			workspaceSettings: baseSettings,
		});
		expect(result.resolvedPath.startsWith("~/")).toBe(true);
	});

	test("suffixes -2 when the base path collides", async () => {
		const colliding = new Set(["~/agentpulse-work/plan-caching"]);
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			workspaceSettings: baseSettings,
			collidingPaths: colliding,
		});
		expect(result.resolvedPath).toBe("~/agentpulse-work/plan-caching-2");
	});

	test("repeats suffix to -3 when base and -2 both collide", async () => {
		const colliding = new Set([
			"~/agentpulse-work/plan-caching",
			"~/agentpulse-work/plan-caching-2",
		]);
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			workspaceSettings: baseSettings,
			collidingPaths: colliding,
		});
		expect(result.resolvedPath).toBe("~/agentpulse-work/plan-caching-3");
	});

	test("throws WorkspaceCollisionExhaustedError when cap exceeded", async () => {
		const colliding = new Set<string>(["~/agentpulse-work/plan-caching"]);
		for (let i = 2; i <= 10; i++) {
			colliding.add(`~/agentpulse-work/plan-caching-${i}`);
		}
		await expect(
			scaffoldWorkArea({
				taskSlug: "plan-caching",
				workspaceSettings: baseSettings,
				collidingPaths: colliding,
			}),
		).rejects.toBeInstanceOf(WorkspaceCollisionExhaustedError);
	});

	test("substitutes both taskSummary and taskSlug in template", async () => {
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			taskSummary: "Plan caching strategies",
			workspaceSettings: {
				...baseSettings,
				templateClaudeMd: "slug={{taskSlug}}; summary={{taskSummary}}",
			},
		});
		const action = result.prelaunchActions[0];
		expect(action.kind).toBe("scaffold_workarea");
		expect(action.seedClaudeMd?.content).toBe("slug=plan-caching; summary=Plan caching strategies");
	});

	test("defaults missing taskSummary to empty string", async () => {
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			workspaceSettings: {
				...baseSettings,
				templateClaudeMd: "summary=[{{taskSummary}}]",
			},
		});
		expect(result.prelaunchActions[0].seedClaudeMd?.content).toBe("summary=[]");
	});

	test("leaves unknown tokens in the template untouched", async () => {
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			workspaceSettings: {
				...baseSettings,
				templateClaudeMd: "{{taskSlug}} but {{foo}}",
			},
		});
		expect(result.prelaunchActions[0].seedClaudeMd?.content).toBe("plan-caching but {{foo}}");
	});

	test("computes SHA-256 of substituted CLAUDE.md content", async () => {
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			taskSummary: "x",
			workspaceSettings: {
				...baseSettings,
				templateClaudeMd: "{{taskSlug}}/{{taskSummary}}",
			},
		});
		const expected = await sha256("plan-caching/x");
		expect(result.prelaunchActions[0].seedClaudeMd?.sha256).toBe(expected);
		expect(result.prelaunchActions[0].seedClaudeMd?.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	test("seedClaudeMd path is relative ('CLAUDE.md')", async () => {
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			workspaceSettings: baseSettings,
		});
		expect(result.prelaunchActions[0].seedClaudeMd?.path).toBe("CLAUDE.md");
	});

	test("honors workspaceSettings.gitInit=true", async () => {
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			workspaceSettings: { ...baseSettings, gitInit: true },
		});
		expect(result.prelaunchActions[0].gitInit).toBe(true);
	});

	test("honors workspaceSettings.gitInit=false", async () => {
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			workspaceSettings: { ...baseSettings, gitInit: false },
		});
		expect(result.prelaunchActions[0].gitInit).toBe(false);
	});

	test("returns exactly one prelaunch action", async () => {
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			workspaceSettings: baseSettings,
		});
		expect(result.prelaunchActions).toHaveLength(1);
		expect(result.prelaunchActions[0].kind).toBe("scaffold_workarea");
	});

	test("resolvedPath matches the action's path field", async () => {
		const result = await scaffoldWorkArea({
			taskSlug: "plan-caching",
			workspaceSettings: baseSettings,
		});
		expect(result.prelaunchActions[0].path).toBe(result.resolvedPath);
	});
});
