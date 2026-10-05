/** AGEN-69 phase 8b: the dev seed names the plan's 34 screens and refuses a non-loopback server. */
import { describe, expect, test } from "bun:test";
import { SCREENS } from "./session-summary-dev-seed.js";

const PLAN_SCREENS = [
	"loading",
	"load-failed",
	"too-little-activity",
	"empty",
	"empty-free-provider",
	"empty-team",
	"no-provider",
	"no-provider-with-summary",
	"paused-no-summary",
	"paused-with-summary",
	"over-budget",
	"over-budget-with-summary",
	"generating-first",
	"generating-with-previous",
	"ready",
	"ready-long",
	"ready-corrected-outcome",
	"ready-partial-evidence",
	"ready-mostly-claims",
	"ready-validation-failed",
	"ready-empty-sections",
	"stale",
	"stale-over-budget",
	"failed-no-summary",
	"failed-with-summary",
	"cooling-down",
	"evidence-shrunk-dialog",
	"suspect",
	"rate-limited",
	"ai-tab-pointer",
	"dashboard-open-summary",
	"digest-row",
	"activity-after-evidence-link",
	"settings-labs-anchor",
	"suspect-note",
	"lost-contact",
	"activity-mode-switched",
];

describe("session-summary dev seed", () => {
	test("one entry per named screen (the plan's 34 and the review's three), no more, no fewer", () => {
		expect(SCREENS.map((s) => s.name)).toEqual(PLAN_SCREENS);
		expect(new Set(SCREENS.map((s) => s.name)).size).toBe(37);
	});

	test("a screen that isn't a real server state of its own session says how to reach it", () => {
		for (const s of SCREENS) expect(s.real !== undefined || Boolean(s.how), s.name).toBe(true);
	});

	test("a non-loopback AGENTPULSE_URL is refused with the loopback message", async () => {
		const proc = Bun.spawn(["bun", "scripts/session-summary-dev-seed.ts"], {
			cwd: `${import.meta.dir}/..`,
			env: { ...process.env, AGENTPULSE_URL: "https://example.com" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;
		const err = await new Response(proc.stderr).text();
		expect(code).not.toBe(0);
		expect(err).toContain("isn't a loopback address");
	});
});

describe("the long screen fills every section to the server's cap", () => {
	test("ten items of three hundred characters", async () => {
		const seed = await import("./session-summary-dev-seed.js");
		expect(seed.SCREENS.find((s) => s.name === "ready-long")?.variant).toBe("long");
	});
});
