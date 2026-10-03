/**
 * The shell installers that write command hooks (scripts/setup-hooks.sh and the
 * /setup.sh the server renders; scripts/setup-relay.sh is covered in
 * installers-run.test.ts) must leave the check script those hooks run on disk.
 * These run the REAL installer end to end in a throwaway HOME, for Codex and
 * for Copilot, and assert the script is there, equals the generator byte for
 * byte, is mode 0500, and that ~/.agentpulse is private. Without it a test of
 * the install function alone would pass while the installer never called it,
 * and a rules file would then silently stop every event.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import "../src/server/db/__test_db.js";
import { buildBashExcludeScript } from "../src/shared/hook-command.js";

const { setup } = await import("../src/server/routes/setup.js");

// Each case runs a real installer in a subprocess; leave room for a loaded machine.
setDefaultTimeout(60_000);

const SETUP_HOOKS = join(import.meta.dir, "setup-hooks.sh");
const KEY = "ap_whole_run_key";
const URL_ARG = "http://localhost:1";
const made: string[] = [];
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	made.push(dir);
	return dir;
}

async function renderedSetupSh(): Promise<string> {
	const app = new Hono();
	app.route("/", setup);
	return (await app.request("/setup.sh")).text();
}

/**
 * The host's PATH with the agent CLIs taken out. The served installer configures whatever it
 * detects, so a real `copilot` on the machine running this suite would make its Copilot step
 * install the check script too, and a deleted install call in the Codex step would go unnoticed.
 * Each directory that holds one is mirrored as symlinks without those names, so every other
 * binary in it (python3, curl, jq...) still resolves from its real place.
 */
const AGENT_CLIS = ["copilot", "codex", "claude"];
const PATH = ((): string => {
	const mirrorRoot = mkdtempSync(join(tmpdir(), "ap-whole-run-path-"));
	made.push(mirrorRoot);
	const kept: string[] = [];
	for (const [i, dir] of (process.env.PATH ?? "/usr/bin:/bin")
		.split(":")
		.filter(Boolean)
		.entries()) {
		if (!AGENT_CLIS.some((name) => existsSync(join(dir, name)))) {
			kept.push(dir);
			continue;
		}
		const mirror = join(mirrorRoot, String(i));
		mkdirSync(mirror);
		for (const entry of readdirSync(dir)) {
			if (AGENT_CLIS.includes(entry)) continue;
			try {
				symlinkSync(join(dir, entry), join(mirror, entry));
			} catch {}
		}
		kept.push(mirror);
	}
	return kept.join(":");
})();

/** A stub `copilot` first on PATH so the Copilot step runs (the installers detect the CLI). */
function copilotStubDir(): string {
	const dir = scratch("ap-whole-run-copilot-");
	writeFileSync(join(dir, "copilot"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(dir, "copilot"), 0o755);
	return dir;
}

async function runScript(file: string, args: string[], home: string, pathPrefix = "") {
	const proc = Bun.spawn(["bash", file, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: pathPrefix ? `${pathPrefix}:${PATH}` : PATH, HOME: home },
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { code: proc.exitCode, out: out + err };
}

const mode = (path: string) => statSync(path).mode & 0o777;
const scriptPath = (home: string) => join(home, ".agentpulse", "exclude-check.sh");

function expectInstalled(home: string) {
	expect(readFileSync(scriptPath(home), "utf-8")).toBe(buildBashExcludeScript());
	expect(mode(scriptPath(home))).toBe(0o500);
}

const SITES: { name: string; file: () => Promise<string>; extraArgs: string[] }[] = [
	{ name: "scripts/setup-hooks.sh", file: async () => SETUP_HOOKS, extraArgs: [] },
	{
		name: "the rendered GET /setup.sh",
		file: async () => {
			const dir = scratch("ap-whole-run-served-");
			const file = join(dir, "setup.sh");
			writeFileSync(file, await renderedSetupSh());
			return file;
		},
		extraArgs: [],
	},
];

for (const site of SITES) {
	describe(`the whole installer: ${site.name}`, () => {
		for (const agent of ["codex_cli", "copilot_cli"] as const) {
			test(`${agent}: the check script is installed, byte for byte, mode 0500; ~/.agentpulse is created private`, async () => {
				const home = scratch("ap-whole-run-home-");
				const file = await site.file();
				const isServed = site.name.includes("rendered");
				// the served script configures whatever it detects; setup-hooks.sh takes --agent
				if (isServed) {
					mkdirSync(join(home, agent === "codex_cli" ? ".codex" : ".copilot"), { recursive: true });
				}
				const args = isServed
					? ["--url", URL_ARG, "--key", KEY, ...site.extraArgs]
					: ["--url", URL_ARG, "--key", KEY, "--agent", agent, ...site.extraArgs];
				const res = await runScript(
					file,
					args,
					home,
					agent === "copilot_cli" ? copilotStubDir() : "",
				);
				expect(res.code, res.out).toBe(0);
				expectInstalled(home);
				expect(
					mode(join(home, ".agentpulse")),
					"a directory the installer creates is private",
				).toBe(0o700);
			});
		}

		test("an existing ~/.agentpulse is never loosened or tightened", async () => {
			for (const existing of [0o700, 0o750, 0o755]) {
				const home = scratch("ap-whole-run-home-");
				mkdirSync(join(home, ".agentpulse"));
				chmodSync(join(home, ".agentpulse"), existing);
				const file = await site.file();
				const isServed = site.name.includes("rendered");
				if (isServed) mkdirSync(join(home, ".codex"), { recursive: true });
				const args = isServed
					? ["--url", URL_ARG, "--key", KEY]
					: ["--url", URL_ARG, "--key", KEY, "--agent", "codex_cli"];
				const res = await runScript(file, args, home);
				// 0750 / 0755 are not trusted by the check, so the installer says so and installs nothing there
				expect(mode(join(home, ".agentpulse")), `mode ${existing.toString(8)}`).toBe(existing);
				if (existing === 0o700) {
					expect(res.code, res.out).toBe(0);
					expectInstalled(home);
				}
			}
		});

		test("a current script is left alone on a re-run (compared, not rewritten); a stale one is replaced", async () => {
			const home = scratch("ap-whole-run-home-");
			const file = await site.file();
			const isServed = site.name.includes("rendered");
			if (isServed) mkdirSync(join(home, ".codex"), { recursive: true });
			const args = isServed
				? ["--url", URL_ARG, "--key", KEY]
				: ["--url", URL_ARG, "--key", KEY, "--agent", "codex_cli"];
			await runScript(file, args, home);
			expectInstalled(home);
			// age the file so a rewrite would show in its mtime, whatever the clock's granularity
			const old = new Date(Date.now() - 3600_000);
			utimesSync(scriptPath(home), old, old);
			const before = lstatSync(scriptPath(home));
			const again = await runScript(file, args, home);
			expect(again.code, again.out).toBe(0);
			const after = lstatSync(scriptPath(home));
			expect(after.ino, "the same file, not a replacement").toBe(before.ino);
			expect(after.mtimeMs).toBe(before.mtimeMs);
			expect(again.out).toContain("Exclusion check is current");

			chmodSync(scriptPath(home), 0o600);
			writeFileSync(
				scriptPath(home),
				"#!/bin/sh\n# agentpulse-exclude-check 00000000000000\nexit 42\n",
			);
			chmodSync(scriptPath(home), 0o500);
			await runScript(file, args, home);
			expectInstalled(home);
		});
	});
}
