/**
 * `setup-hooks.sh --statusline` copies a statusline script into ~/.claude and
 * makes it executable, so it must only ever copy the one that ships next to
 * the installer. Run as `curl ... | bash` (or any way that gives it no file
 * on disk) the script has no location of its own: it must refuse, not fall
 * back to whatever `./statusline.sh` sits in the current directory.
 *
 * Every run uses a throwaway HOME, and the planted file is named like the real
 * script so a fallback to the working directory would copy it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SETUP_HOOKS = join(ROOT, "scripts", "setup-hooks.sh");
const STATUSLINE = join(ROOT, "scripts", "statusline.sh");
const PATH = process.env.PATH ?? "/usr/bin:/bin";
const PLANTED = "#!/bin/sh\n# planted: must never be installed\nexit 0\n";
const created: string[] = [];
afterAll(() => {
	for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	created.push(dir);
	return dir;
}

const ARGS = [
	"--url",
	"http://127.0.0.1:1",
	"--key",
	"ap_statusline_test",
	"--no-auth-check",
	"--statusline",
];

async function run(argv: string[], home: string, cwd: string, stdin?: string, path = PATH) {
	const proc = Bun.spawn(argv, {
		cwd,
		stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: path, HOME: home, SHELL: "/bin/zsh" },
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { code: proc.exitCode, out: out + err };
}

const installed = (home: string) => join(home, ".claude", "statusline-agentpulse.sh");

function expectRefusedAndNothingInstalled(res: { code: number | null; out: string }, home: string) {
	expect(res.code, res.out).toBe(0);
	expect(existsSync(installed(home)), "nothing is copied into ~/.claude").toBe(false);
	expect(res.out).toContain("--statusline needs the installer to be a file");
	expect(res.out).toContain("relay installer");
	const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
	expect(settings.statusLine, "settings.json gets no statusLine").toBeUndefined();
}

describe("setup-hooks.sh --statusline without a file on disk", () => {
	test("piped into bash (curl | bash): a ./statusline.sh in the working directory is not copied", async () => {
		const home = scratch("ap-sl-home-");
		const cwd = scratch("ap-sl-cwd-");
		writeFileSync(join(cwd, "statusline.sh"), PLANTED);
		const res = await run(
			["bash", "-s", "--", ...ARGS],
			home,
			cwd,
			readFileSync(SETUP_HOOKS, "utf-8"),
		);
		expectRefusedAndNothingInstalled(res, home);
	});

	test("a file named like the shell sits beside a planted statusline.sh in the working directory: still refused (the shell's own name is not a script location)", async () => {
		const home = scratch("ap-sl-home-");
		const cwd = scratch("ap-sl-cwd-");
		writeFileSync(join(cwd, "statusline.sh"), PLANTED);
		writeFileSync(join(cwd, "bash"), "not the shell");
		const res = await run(
			["bash", "-s", "--", ...ARGS],
			home,
			cwd,
			readFileSync(SETUP_HOOKS, "utf-8"),
		);
		expectRefusedAndNothingInstalled(res, home);
	});

	test("run with `bash -c <text>`: refused the same way", async () => {
		const home = scratch("ap-sl-home-");
		const cwd = scratch("ap-sl-cwd-");
		writeFileSync(join(cwd, "statusline.sh"), PLANTED);
		const res = await run(
			["bash", "-c", readFileSync(SETUP_HOOKS, "utf-8"), "setup-hooks.sh", ...ARGS],
			home,
			cwd,
		);
		expectRefusedAndNothingInstalled(res, home);
	});

	test('run with `bash -c <text> setup-hooks.sh`, the way `bash -c "$(curl ...)" setup-hooks.sh` does, from a directory holding a lookalike setup-hooks.sh and a planted statusline.sh: refused', async () => {
		for (const bash of installedBashes()) {
			const home = scratch("ap-sl-home-");
			const cwd = scratch("ap-sl-cwd-");
			writeFileSync(join(cwd, "statusline.sh"), PLANTED);
			// the lookalike has the right name and carries the installer's header line, as an attacker's would
			writeFileSync(
				join(cwd, "setup-hooks.sh"),
				"# AgentPulse Hook Setup Script\nnot the installer\n",
			);
			const res = await run(
				[bash.path, "-c", readFileSync(SETUP_HOOKS, "utf-8"), "setup-hooks.sh", ...ARGS],
				home,
				cwd,
			);
			expect(res.code, `bash ${bash.version}: ${res.out}`).toBe(0);
			expect(existsSync(installed(home)), `bash ${bash.version}: nothing is copied`).toBe(false);
		}
	});

	test("run from process substitution (the script is a pipe, not a regular file): refused", async () => {
		const home = scratch("ap-sl-home-");
		const cwd = scratch("ap-sl-cwd-");
		writeFileSync(join(cwd, "statusline.sh"), PLANTED);
		const res = await run(
			["bash", "-c", `bash <(cat '${SETUP_HOOKS}') "$@"`, "x", ...ARGS],
			home,
			cwd,
		);
		expectRefusedAndNothingInstalled(res, home);
	});
});

/**
 * Every bash on this machine, with its version. The piped-install bypass this guards against
 * depends on the shell: bash 5 reports BASH_SOURCE[0] as "bash" under `bash -s`, while bash 3.2
 * (macOS's /bin/bash) leaves it empty, so a regression test run only under 3.2 would pass
 * whatever the guard did. Looks in PATH and the usual package-manager directories.
 */
function installedBashes(): { path: string; version: string; major: number }[] {
	const candidates = new Set<string>();
	const dirs = [
		...PATH.split(":"),
		"/bin",
		"/usr/bin",
		"/usr/local/bin",
		"/opt/homebrew/bin",
		"/opt/local/bin",
		"/run/current-system/sw/bin",
		"/nix/var/nix/profiles/default/bin",
		"/home/linuxbrew/.linuxbrew/bin",
	];
	for (const dir of dirs) {
		if (!dir) continue;
		const candidate = join(dir, "bash");
		if (existsSync(candidate)) candidates.add(realpathSync(candidate));
	}
	const found: { path: string; version: string; major: number }[] = [];
	for (const path of candidates) {
		const probe = spawnSync(path, ["-c", 'printf "%s" "$BASH_VERSION"'], { encoding: "utf-8" });
		const version = (probe.stdout ?? "").trim();
		const major = Number.parseInt(version, 10);
		if (probe.status === 0 && Number.isFinite(major)) found.push({ path, version, major });
	}
	return found;
}

describe("setup-hooks.sh --statusline under every bash on this machine (the piped-install bypass)", () => {
	const bashes = installedBashes();

	test("the versions exercised are named, and there is at least one", () => {
		console.log(
			`bash versions exercised: ${bashes.map((b) => `${b.path} ${b.version}`).join("; ")}`,
		);
		expect(bashes.length, "no bash found at all").toBeGreaterThan(0);
	});

	for (const bash of bashes) {
		test(`bash ${bash.version} (${bash.path}): piped in, with a file named like the shell beside a planted statusline.sh, nothing is installed`, async () => {
			const home = scratch("ap-sl-home-");
			const cwd = scratch("ap-sl-cwd-");
			writeFileSync(join(cwd, "statusline.sh"), PLANTED);
			// the shell's own name under -s: bash 5 reports it as the script, so the planted file
			// must carry that exact name to be the thing a careless guard would trust
			// it carries the installer's own header line, as an attacker's would, so only the name keeps it out
			writeFileSync(join(cwd, "bash"), "# AgentPulse Hook Setup Script\nnot the shell\n");
			const res = await run(
				[bash.path, "-s", "--", ...ARGS],
				home,
				cwd,
				readFileSync(SETUP_HOOKS, "utf-8"),
			);
			expectRefusedAndNothingInstalled(res, home);
		});
	}
});

/**
 * A PATH on which the bare name `bash` resolves to this particular bash. The two shell quirks the
 * guards exist for only show when the shell is started by name: `bash -s` resolved through PATH
 * reports its script as "bash" (an absolute path would make it the binary's path), and
 * `bash -c <text> setup-hooks.sh` reports it as "setup-hooks.sh".
 */
function pathResolvingBashTo(bash: { path: string }): string {
	const dir = scratch("ap-sl-bashpath-");
	symlinkSync(bash.path, join(dir, "bash"));
	return `${dir}:${PATH}`;
}

describe("setup-hooks.sh --statusline under every bash, started by its bare name through PATH (where the quirks that need the guards appear)", () => {
	const bashes = installedBashes();
	const exercised: { version: string; major: number; form: string }[] = [];

	for (const bash of bashes) {
		test(`bash ${bash.version}: bare \`bash -s\` with a file named bash and a planted statusline.sh beside it: nothing is installed`, async () => {
			const home = scratch("ap-sl-home-");
			const cwd = scratch("ap-sl-cwd-");
			writeFileSync(join(cwd, "statusline.sh"), PLANTED);
			writeFileSync(join(cwd, "bash"), "# AgentPulse Hook Setup Script\nnot the shell\n");
			const res = await run(
				["bash", "-s", "--", ...ARGS],
				home,
				cwd,
				readFileSync(SETUP_HOOKS, "utf-8"),
				pathResolvingBashTo(bash),
			);
			exercised.push({ version: bash.version, major: bash.major, form: "-s" });
			expectRefusedAndNothingInstalled(res, home);
		});

		test(`bash ${bash.version}: bare \`bash -c <text> setup-hooks.sh\` beside a lookalike setup-hooks.sh and a planted statusline.sh: nothing is installed`, async () => {
			const home = scratch("ap-sl-home-");
			const cwd = scratch("ap-sl-cwd-");
			writeFileSync(join(cwd, "statusline.sh"), PLANTED);
			writeFileSync(
				join(cwd, "setup-hooks.sh"),
				"# AgentPulse Hook Setup Script\nnot the installer\n",
			);
			const res = await run(
				["bash", "-c", readFileSync(SETUP_HOOKS, "utf-8"), "setup-hooks.sh", ...ARGS],
				home,
				cwd,
				undefined,
				pathResolvingBashTo(bash),
			);
			exercised.push({ version: bash.version, major: bash.major, form: "-c" });
			expectRefusedAndNothingInstalled(res, home);
		});
	}

	test("a bash 4 or newer was exercised in both forms whenever one exists on this machine (it fails, it does not skip)", () => {
		const modern = bashes.filter((b) => b.major >= 4);
		if (modern.length === 0) return;
		for (const form of ["-s", "-c"]) {
			expect(
				exercised.some((e) => e.major >= 4 && e.form === form),
				`no bash >= 4 ran the bare \`${form}\` form (machine has ${modern.map((b) => b.version).join(", ")})`,
			).toBe(true);
		}
	});
});

describe("setup-hooks.sh --statusline from a real file", () => {
	test("next to a real statusline.sh: installed (the control for the refusals above)", async () => {
		const home = scratch("ap-sl-home-");
		const dir = scratch("ap-sl-dir-");
		copyFileSync(SETUP_HOOKS, join(dir, "setup-hooks.sh"));
		copyFileSync(STATUSLINE, join(dir, "statusline.sh"));
		const res = await run(
			["bash", join(dir, "setup-hooks.sh"), ...ARGS],
			home,
			scratch("ap-sl-cwd-"),
		);
		expect(res.code, res.out).toBe(0);
		expect(readFileSync(installed(home), "utf-8")).toBe(readFileSync(STATUSLINE, "utf-8"));
	});

	test("the file is on disk but no statusline.sh sits beside it, while the working directory has one: refused", async () => {
		const home = scratch("ap-sl-home-");
		const dir = scratch("ap-sl-dir-");
		const cwd = scratch("ap-sl-cwd-");
		copyFileSync(SETUP_HOOKS, join(dir, "setup-hooks.sh"));
		writeFileSync(join(cwd, "statusline.sh"), PLANTED);
		const res = await run(["bash", join(dir, "setup-hooks.sh"), ...ARGS], home, cwd);
		expectRefusedAndNothingInstalled(res, home);
	});

	test("a copy of the installer under another file name, with a statusline.sh beside it: refused (only a file named setup-hooks.sh counts)", async () => {
		const home = scratch("ap-sl-home-");
		const dir = scratch("ap-sl-dir-");
		copyFileSync(SETUP_HOOKS, join(dir, "installer.sh"));
		copyFileSync(STATUSLINE, join(dir, "statusline.sh"));
		const res = await run(
			["bash", join(dir, "installer.sh"), ...ARGS],
			home,
			scratch("ap-sl-cwd-"),
		);
		expectRefusedAndNothingInstalled(res, home);
	});

	test("the statusline.sh beside it is a symlink: refused, the link target is not copied", async () => {
		const home = scratch("ap-sl-home-");
		const dir = scratch("ap-sl-dir-");
		const elsewhere = scratch("ap-sl-elsewhere-");
		copyFileSync(SETUP_HOOKS, join(dir, "setup-hooks.sh"));
		writeFileSync(join(elsewhere, "real.sh"), PLANTED);
		symlinkSync(join(elsewhere, "real.sh"), join(dir, "statusline.sh"));
		mkdirSync(join(home, ".claude"), { recursive: true });
		const res = await run(["bash", join(dir, "setup-hooks.sh"), ...ARGS], home, dir);
		expect(existsSync(installed(home))).toBe(false);
		expect(res.out).toContain("--statusline needs the installer to be a file");
	});
});
