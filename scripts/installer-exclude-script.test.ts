/**
 * The shell installers (scripts/setup-hooks.sh, scripts/setup-relay.sh and the
 * /setup.sh the server renders) each carry `ap_install_exclude_script`, which
 * writes the exclusion check to ~/.agentpulse/exclude-check.sh. This sources
 * that REAL function from each installer (never a reimplementation) and runs
 * it against a throwaway HOME: the file equals the generator's script, is
 * mode 0500, is written atomically and never through a link, creates
 * ~/.agentpulse as 0700 and never loosens an existing one, and refuses (with
 * a message, exit 0) a directory or target it can't safely use.
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
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import "../src/server/db/__test_db.js";
import { buildBashExcludeScript } from "../src/shared/hook-command.js";

// Each case runs a real installer in a subprocess; leave room for a loaded machine.
setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const START = "# >>> agentpulse-hook-cmd";
const END = "# <<< agentpulse-hook-cmd";
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ap-installer-script-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let runIndex = 0;

function blockOf(source: string): string {
	const start = source.indexOf(START);
	const end = source.indexOf(END);
	if (start === -1 || end === -1) throw new Error("hook-command block markers not found");
	return source.slice(start, end + END.length);
}

async function renderedSetupSh(): Promise<string> {
	const { setup } = await import("../src/server/routes/setup.ts");
	const app = new Hono().route("/", setup);
	const res = await app.request("http://localhost/setup.sh", {
		headers: { Host: "localhost:3000" },
	});
	return res.text();
}

const SITES: { name: string; source: () => Promise<string> }[] = [
	{
		name: "scripts/setup-hooks.sh",
		source: async () => readFileSync(join(ROOT, "scripts/setup-hooks.sh"), "utf-8"),
	},
	{
		name: "scripts/setup-relay.sh",
		source: async () => readFileSync(join(ROOT, "scripts/setup-relay.sh"), "utf-8"),
	},
	{ name: "the rendered GET /setup.sh", source: renderedSetupSh },
];

function newHome(): string {
	const home = join(scratch, `home-${++runIndex}`);
	mkdirSync(home);
	return home;
}

async function runInstall(source: string, home: string | undefined, pathPrefix?: string) {
	const script = `${blockOf(source)}\nap_install_exclude_script`;
	const basePath = process.env.PATH ?? "/usr/bin:/bin";
	const env: Record<string, string> = { PATH: pathPrefix ? `${pathPrefix}:${basePath}` : basePath };
	if (home !== undefined) env.HOME = home;
	const proc = Bun.spawn(["bash", "-c", script], { stdout: "pipe", stderr: "pipe", env });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { code: proc.exitCode, stdout, stderr };
}

const mode = (path: string) => lstatSync(path).mode & 0o777;

for (const site of SITES) {
	describe(`ap_install_exclude_script in ${site.name}`, () => {
		test("a fresh HOME: the script equals the generator's, mode 0500; ~/.agentpulse is created 0700", async () => {
			const source = await site.source();
			const home = newHome();
			const res = await runInstall(source, home);
			expect(res.code).toBe(0);
			const file = join(home, ".agentpulse", "exclude-check.sh");
			expect(readFileSync(file, "utf-8")).toBe(buildBashExcludeScript());
			expect(mode(file)).toBe(0o500);
			expect(mode(join(home, ".agentpulse"))).toBe(0o700);
			expect(res.stdout).toContain("Exclusion check installed");
			expect(readdirSync(join(home, ".agentpulse"))).toEqual(["exclude-check.sh"]);
		});

		test("an existing directory is never loosened or tightened", async () => {
			const source = await site.source();
			const home = newHome();
			mkdirSync(join(home, ".agentpulse"));
			chmodSync(join(home, ".agentpulse"), 0o750);
			await runInstall(source, home);
			expect(mode(join(home, ".agentpulse"))).toBe(0o750);
			expect(existsSync(join(home, ".agentpulse", "exclude-check.sh"))).toBe(true);
		});

		test("a stale copy (even a read-only one) is replaced", async () => {
			const source = await site.source();
			const home = newHome();
			mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
			const file = join(home, ".agentpulse", "exclude-check.sh");
			writeFileSync(file, "#!/bin/sh\nexit 0\n");
			chmodSync(file, 0o500);
			await runInstall(source, home);
			expect(readFileSync(file, "utf-8")).toBe(buildBashExcludeScript());
			expect(mode(file)).toBe(0o500);
		});

		test("a symlink at the script's path is refused: its target is untouched, a message says so, exit 0", async () => {
			const source = await site.source();
			const home = newHome();
			mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
			const victim = join(home, "victim");
			writeFileSync(victim, "keep");
			symlinkSync(victim, join(home, ".agentpulse", "exclude-check.sh"));
			const res = await runInstall(source, home);
			expect(res.code).toBe(0);
			expect(readFileSync(victim, "utf-8")).toBe("keep");
			expect(lstatSync(join(home, ".agentpulse", "exclude-check.sh")).isSymbolicLink()).toBe(true);
			expect(res.stderr).toContain("Exclusion check not installed");
		});

		test("a directory where the script goes is refused, not moved into", async () => {
			const source = await site.source();
			const home = newHome();
			mkdirSync(join(home, ".agentpulse", "exclude-check.sh"), { recursive: true, mode: 0o700 });
			const res = await runInstall(source, home);
			expect(res.code).toBe(0);
			expect(res.stderr).toContain("Exclusion check not installed");
			expect(readdirSync(join(home, ".agentpulse", "exclude-check.sh"))).toEqual([]);
		});

		test("a group-writable ~/.agentpulse is refused: nothing is written", async () => {
			const source = await site.source();
			const home = newHome();
			mkdirSync(join(home, ".agentpulse"));
			chmodSync(join(home, ".agentpulse"), 0o770);
			const res = await runInstall(source, home);
			chmodSync(join(home, ".agentpulse"), 0o700);
			expect(res.code).toBe(0);
			expect(res.stderr).toContain("Exclusion check not installed");
			expect(readdirSync(join(home, ".agentpulse"))).toEqual([]);
		});

		test("a symlinked ~/.agentpulse that points at a private directory is used, and the target gets the file", async () => {
			const source = await site.source();
			const home = newHome();
			const target = join(home, "dotfiles-agentpulse");
			mkdirSync(target, { mode: 0o700 });
			symlinkSync(target, join(home, ".agentpulse"));
			const res = await runInstall(source, home);
			expect(res.code).toBe(0);
			expect(readFileSync(join(target, "exclude-check.sh"), "utf-8")).toBe(
				buildBashExcludeScript(),
			);
			expect(lstatSync(join(home, ".agentpulse")).isSymbolicLink()).toBe(true);
		});

		test("a dangling ~/.agentpulse link installs nothing and says so", async () => {
			const source = await site.source();
			const home = newHome();
			symlinkSync(join(home, "nowhere"), join(home, ".agentpulse"));
			const res = await runInstall(source, home);
			expect(res.code).toBe(0);
			expect(res.stderr).toContain("Exclusion check not installed");
			expect(existsSync(join(home, "nowhere"))).toBe(false);
		});

		test("what was moved into place is read back: a truncated result is removed, with a message", async () => {
			const source = await site.source();
			const home = newHome();
			const stubs = join(scratch, `mv-stub-${++runIndex}`);
			mkdirSync(stubs);
			// Simulates the outcome of a crash between the rename and the data reaching the disk.
			writeFileSync(join(stubs, "mv"), '#!/bin/sh\nfor a; do last=$a; done\n: > "$last"\nexit 0\n');
			chmodSync(join(stubs, "mv"), 0o755);
			const res = await runInstall(source, home, stubs);
			expect(res.code).toBe(0);
			expect(res.stderr).toContain("Exclusion check not installed");
			expect(res.stderr).toContain("verif");
			expect(res.stdout).not.toContain("Exclusion check installed");
			expect(existsSync(join(home, ".agentpulse", "exclude-check.sh"))).toBe(false);
		});

		test("the data is flushed before the rename", async () => {
			const source = await site.source();
			const home = newHome();
			const stubs = join(scratch, `order-stub-${++runIndex}`);
			mkdirSync(stubs);
			const log = join(stubs, "order.log");
			writeFileSync(join(stubs, "sync"), `#!/bin/sh\necho sync >> "${log}"\nexit 0\n`);
			writeFileSync(join(stubs, "mv"), `#!/bin/sh\necho mv >> "${log}"\nexec /bin/mv "$@"\n`);
			chmodSync(join(stubs, "sync"), 0o755);
			chmodSync(join(stubs, "mv"), 0o755);
			const res = await runInstall(source, home, stubs);
			expect(res.code).toBe(0);
			expect(readFileSync(log, "utf-8").trim().split("\n")).toEqual(["sync", "mv"]);
			expect(readFileSync(join(home, ".agentpulse", "exclude-check.sh"), "utf-8")).toBe(
				buildBashExcludeScript(),
			);
		});

		test("an empty HOME installs nothing and says so", async () => {
			const source = await site.source();
			const res = await runInstall(source, "");
			expect(res.code).toBe(0);
			expect(res.stderr).toContain("HOME is not set");
		});
	});
}
