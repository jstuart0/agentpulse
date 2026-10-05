import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectEvidenceIds, isLoopbackUrl } from "./session-summary-live-test.js";

const SCRIPT = join(import.meta.dir, "session-summary-live-test.ts");
const RUN_TIMEOUT_MS = 90_000;

/** Runs the script as a user would, with no ambient server or provider key it could pick up. */
async function runScript(...args: string[]) {
	const env: Record<string, string | undefined> = { ...process.env };
	env.AGENTPULSE_URL = undefined;
	env.ANTHROPIC_API_KEY = undefined;
	env.DATABASE_URL = undefined;
	const proc = Bun.spawn(["bun", SCRIPT, ...args], { env, stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS - 5000);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timer);
	return { stdout, stderr, code };
}

describe("session-summary live check, stub mode", () => {
	test(
		"passes against a real throwaway server",
		async () => {
			const { stdout, code } = await runScript("--stub");
			expect(stdout).toContain("all checks passed");
			expect(stdout).not.toContain("FAIL");
			expect(code).toBe(0);
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"a planted injection in the handoff exits non-zero and names the check",
		async () => {
			const { stdout, code } = await runScript("--stub", "--plant", "handoff-injection");
			expect(stdout).toContain("FAIL  the injected text is not in the handoff");
			expect(code).toBe(1);
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"an unusable model answer exits non-zero",
		async () => {
			const { stdout, code } = await runScript("--stub", "--plant", "bad-json");
			expect(stdout).toContain("FAIL  view is ready");
			expect(code).toBe(1);
		},
		RUN_TIMEOUT_MS,
	);

	test(
		"a secret in the model's own answer is masked by the server, so the run still passes",
		async () => {
			const { stdout, code } = await runScript("--stub", "--plant", "handoff-secret");
			expect(stdout).toContain("PASS  the fake secret is absent from the response");
			expect(code).toBe(0);
		},
		RUN_TIMEOUT_MS,
	);

	test("refuses to run without a key in --real mode, exit 2", async () => {
		const { stderr, code } = await runScript("--real");
		expect(stderr).toContain("ANTHROPIC_API_KEY");
		expect(code).toBe(2);
	});
});

describe("helpers", () => {
	test("collectEvidenceIds reads item citations and provenance keys, and ignores other strings", () => {
		const stored = {
			summary: {
				accomplishments: [{ text: "E5 in prose", evidence: ["E12", "E3"] }],
				validation: [{ what: "x", evidence: ["E7"] }],
				handoff: "E99",
			},
			provenance: { evidence: { E12: {}, E40: {} } },
		};
		expect(collectEvidenceIds(stored)).toEqual([3, 7, 12, 40]);
		expect(collectEvidenceIds(null)).toEqual([]);
	});

	test("isLoopbackUrl matches the parsed host exactly", () => {
		expect(isLoopbackUrl("http://127.0.0.1:3000")).toBe(true);
		expect(isLoopbackUrl("http://localhost:3000")).toBe(true);
		expect(isLoopbackUrl("http://localhost.evil.com")).toBe(false);
		expect(isLoopbackUrl("http://127.0.0.1@evil.com")).toBe(false);
		expect(isLoopbackUrl("not a url")).toBe(false);
	});
});
