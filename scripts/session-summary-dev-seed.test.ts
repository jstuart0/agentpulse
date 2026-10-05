/** AGEN-69 phase 8b: the dev seed names the plan's 34 screens and refuses a non-loopback server. */
import { describe, expect, test } from "bun:test";
import { HELP, SCREENS, foreignSessionIds, isLoopbackUrl } from "./session-summary-dev-seed.js";

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
	"failed-key-unreadable",
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
		expect(new Set(SCREENS.map((s) => s.name)).size).toBe(38);
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

describe("T-7 what counts as a throwaway loopback target", () => {
	test("loopback by exact host only", () => {
		for (const ok of ["http://127.0.0.1:3199", "http://localhost:3000", "http://[::1]:3000"]) {
			expect(isLoopbackUrl(ok), ok).toBe(true);
		}
		for (const bad of [
			"https://example.com",
			"http://localhost.evil.com",
			"http://127.0.0.1.nip.io",
			"http://127.0.0.1@evil.com",
			"not a url",
		]) {
			expect(isLoopbackUrl(bad), bad).toBe(false);
		}
	});

	test("a lookalike host is refused as a script (exit 2) and --allow-remote lets it past that check", async () => {
		const run = async (url: string, ...args: string[]) => {
			const p = Bun.spawn(["bun", "scripts/session-summary-dev-seed.ts", ...args], {
				cwd: `${import.meta.dir}/..`,
				env: { ...process.env, AGENTPULSE_URL: url },
				stdout: "pipe",
				stderr: "pipe",
			});
			const killer = setTimeout(() => p.kill(), 8000);
			const code = await p.exited;
			clearTimeout(killer);
			return { code, err: await new Response(p.stderr).text() };
		};
		const refused = await run("http://localhost.evil.com");
		expect(refused.code).toBe(2);
		expect(refused.err).toContain("isn't a loopback address");
		// With --allow-remote the loopback refusal is gone; the next check (an unreachable server) refuses instead.
		const past = await run("http://localhost.evil.com:9", "--allow-remote");
		expect(past.err).not.toContain("isn't a loopback address");
	});

	test("sessions this script didn't make mark a server as not a throwaway", () => {
		expect(foreignSessionIds(["scr-ready", "demo-fresh"])).toEqual([]);
		expect(foreignSessionIds(["scr-ready", "9f3c-real-work"])).toEqual(["9f3c-real-work"]);
	});

	test("the help says plainly what it writes and names both overrides", () => {
		expect(HELP).toContain("WRITES");
		expect(HELP).toContain("--allow-remote");
		expect(HELP).toContain("--allow-existing");
	});
});
