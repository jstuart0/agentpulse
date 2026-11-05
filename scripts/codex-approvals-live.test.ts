/**
 * The canary's argument check (AGEN-91 phase 5). A scenario id that matches nothing used to run zero scenarios
 * and exit 0, so a typo in `--only` passed the release gate. These run the real script with no Codex and no
 * network: the check happens before anything starts.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "codex-approvals-live.ts");

async function runScript(...args: string[]) {
	const proc = Bun.spawn(["bun", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code };
}

describe("codex-approvals-live --real --only", () => {
	const scratch = mkdtempSync(join(tmpdir(), "live-args-"));
	const work = join(scratch, "work");

	for (const only of ["no-such-scenario", "followup,bogus", "", "argv,"]) {
		test(`--only ${JSON.stringify(only)} exits 2 before anything starts`, async () => {
			const { code, stderr, stdout } = await runScript("--real", "--only", only, "--work", work);
			expect(code).toBe(2);
			expect(stderr).toContain("unknown scenario");
			expect(stdout).not.toContain("throwaway server");
			expect(existsSync(work)).toBe(false);
		});
	}

	test("known ids get past the check (positive control: they reach the scratch-directory refusal)", async () => {
		const notScratch = join(homedir(), "dev", "live-args-not-scratch");
		for (const only of ["followup", "argv,decline,fc-accept,fc-decline,fc-patch,followup"]) {
			const { code, stderr } = await runScript("--real", "--only", only, "--work", notScratch);
			expect(stderr).not.toContain("unknown scenario");
			expect(stderr).toContain("not a scratch directory");
			expect(code).not.toBe(2);
		}
		expect(existsSync(notScratch)).toBe(false);
	});

	test("cleanup", () => {
		rmSync(scratch, { recursive: true, force: true });
		expect(existsSync(scratch)).toBe(false);
	});
});
