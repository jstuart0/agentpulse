/**
 * The updater as the installer ships it: one file built with `bun build --target=bun src/updater/cli.ts`, run
 * from outside the checkout with a throwaway HOME. It must run on its own (every import bundled in), take the
 * command line as the shim passes it, and never reach for a service manager without the opt-in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
let scratch: string;
let bundle: string;
let home: string;

beforeAll(() => {
	scratch = mkdtempSync(join(tmpdir(), "ap-bundle-"));
	home = join(scratch, "home");
	mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
	bundle = join(scratch, "updater.js");
	const built = Bun.spawnSync(
		[process.execPath, "build", "--target=bun", "src/updater/cli.ts", "--outfile", bundle],
		{ cwd: REPO, stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode !== 0) throw new Error(`bundle build failed: ${built.stderr.toString()}`);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function run(args: string[]) {
	const proc = Bun.spawnSync([process.execPath, bundle, ...args], {
		cwd: join(home, ".agentpulse"),
		env: { PATH: process.env.PATH ?? "", HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe("the bundled updater", () => {
	test("is one self-contained file that runs outside the checkout", () => {
		expect(statSync(bundle).size).toBeGreaterThan(10_000);
		const r = run(["update", "--bogus"]);
		expect(r.code).toBe(2);
		expect(r.err).toContain("Usage: agentpulse update");
	});

	test("status works with no install record, and says client scripts aren't refreshed here", () => {
		const r = run(["update", "status"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("Installed: unknown");
		expect(r.out).toContain("not refreshed here");
	});

	test("an update with no install record says so and changes nothing", () => {
		const r = run(["update"]);
		expect(r.code).toBe(1);
		expect(r.out).toContain("This machine has no install record.");
	});

	test("the version flag takes a v-prefixed version, and the downgrade flag has the name the web copy gives", () => {
		expect(run(["update", "--to", "v0.12.0", "--allow-downgrade"]).out).toContain(
			"no install record",
		);
	});
});
