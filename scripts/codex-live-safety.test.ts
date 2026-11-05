/**
 * The rules a live Codex canary keeps, held in CI with no Codex (AGEN-115, phase 5). Two halves: the helper
 * that refuses a CODEX_HOME that isn't throwaway, and a scan of `scripts/` for the ways a canary could touch
 * something that isn't its own. Every scan rule has a planted-string control: a temp fixture holding exactly
 * the thing the rule exists to catch, which the scan must flag (the scan detects its own detector).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	type Finding,
	PROCESS_SEARCH_FILE,
	assertThrowawayCodexHome,
	scanCanarySource,
	scanText,
} from "./lib/codex-canary-safety.js";
import { assertAllowedCodexArgs } from "./lib/codex-canary-spawn.js";

const ROOT = join(import.meta.dir, "..");

describe("assertThrowawayCodexHome", () => {
	let scratch: string;
	let fakeHome: string;
	beforeAll(() => {
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "codex-safety-")));
		fakeHome = join(scratch, "person");
		mkdirSync(join(fakeHome, ".codex"), { recursive: true });
		mkdirSync(join(scratch, "run", "codex-home"), { recursive: true });
		mkdirSync(join(scratch, "run2"), { recursive: true });
	});
	afterAll(() => rmSync(scratch, { recursive: true, force: true }));

	test("a home strictly inside the scratch directory passes, and is returned as given", () => {
		const home = join(scratch, "run", "codex-home");
		expect(assertThrowawayCodexHome(home, join(scratch, "run"), fakeHome)).toBe(home);
	});

	test("unset or empty is refused", () => {
		expect(() => assertThrowawayCodexHome(undefined, scratch, fakeHome)).toThrow("not set");
		expect(() => assertThrowawayCodexHome("", scratch, fakeHome)).toThrow("not set");
	});

	test("a relative path is refused", () => {
		expect(() => assertThrowawayCodexHome("codex-home", scratch, fakeHome)).toThrow("absolute");
	});

	test("the person's home and their .codex, and anything inside or above the latter, are refused", () => {
		for (const bad of [fakeHome, join(fakeHome, ".codex"), join(fakeHome, ".codex", "sessions")]) {
			expect(() => assertThrowawayCodexHome(bad, scratch, fakeHome)).toThrow();
		}
	});

	test("a link inside the scratch directory that points into the real .codex is refused", () => {
		const link = join(scratch, "run", "sneaky");
		symlinkSync(join(fakeHome, ".codex"), link);
		expect(() => assertThrowawayCodexHome(link, join(scratch, "run"), fakeHome)).toThrow("link");
	});

	test("a path that only shares a prefix with the scratch directory is a different directory, and refused", () => {
		expect(() =>
			assertThrowawayCodexHome(join(scratch, "run2", "h"), join(scratch, "run"), fakeHome),
		).toThrow("scratch");
		expect(() =>
			assertThrowawayCodexHome(join(scratch, "run"), join(scratch, "run"), fakeHome),
		).toThrow("scratch");
	});
});

describe("assertAllowedCodexArgs: the spawner's allowlist", () => {
	test("exec, app-server, --version, and the three daemon subcommands pass", () => {
		for (const args of [
			["exec", "--json", "x"],
			["app-server"],
			["--version"],
			["daemon", "start"],
			["daemon", "stop"],
			["daemon", "version"],
		]) {
			expect(() => assertAllowedCodexArgs(args)).not.toThrow();
		}
	});
	test("no subcommand (a TUI), another daemon subcommand, and anything else are refused", () => {
		for (const args of [
			[],
			["daemon"],
			["daemon", "bootstrap"],
			["daemon", "restart"],
			["update"],
			["resume"],
		]) {
			expect(() => assertAllowedCodexArgs(args)).toThrow();
		}
	});
});

function repoScripts(): Array<{ path: string; text: string }> {
	const out: Array<{ path: string; text: string }> = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, name.name);
			if (name.isDirectory()) {
				if (name.name !== "node_modules") walk(full);
			} else if (/\.(ts|mjs|js|sh)$/.test(name.name) && !/\.test\.ts$/.test(name.name)) {
				out.push({ path: relative(ROOT, full), text: readFileSync(full, "utf-8") });
			}
		}
	};
	walk(join(ROOT, "scripts"));
	return out;
}

const rules = (findings: Finding[]) => findings.map((f) => f.rule);

describe("the scan of scripts/", () => {
	test("finds nothing in the scripts as they are", () => {
		const files = repoScripts();
		expect(files.length).toBeGreaterThan(5);
		expect(files.some((f) => f.path === "scripts/codex-approvals-live.ts")).toBe(true);
		expect(scanCanarySource(files)).toEqual([]);
	});

	test("(a) a Codex spawn outside the spawner is flagged; in the spawner it isn't", () => {
		const planted = 'import { spawn } from "node:child_process";\nspawn("codex", ["exec", "x"]);';
		expect(rules(scanText("scripts/rogue.ts", planted))).toContain("codex-spawn");
		expect(rules(scanText("scripts/rogue.ts", 'spawnSync("codex", ["--version"])'))).toContain(
			"codex-spawn",
		);
		expect(rules(scanText("scripts/rogue.ts", 'Bun.spawn(["codex", "exec"])'))).toContain(
			"codex-spawn",
		);
		expect(scanText("scripts/lib/codex-canary-spawn.ts", planted)).toEqual([]);
	});

	test("(b) a planted `daemon bootstrap` is named; start, stop and version aren't", () => {
		const found = scanText("scripts/rogue.ts", 'runCodex(["daemon", "bootstrap"]);');
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({ rule: "daemon-subcommand" });
		expect(found[0]?.detail).toContain("bootstrap");
		for (const sub of ["update", "restart", "uninstall"]) {
			expect(rules(scanText("scripts/rogue.ts", `x("codex daemon ${sub}")`))).toContain(
				"daemon-subcommand",
			);
		}
		for (const ok of ["start", "stop", "version"]) {
			expect(scanText("scripts/rogue.ts", `x(["daemon", "${ok}"])`)).toEqual([]);
		}
	});

	test("(c) a kill by name pattern is flagged", () => {
		for (const planted of [
			'spawnSync("pkill", ["-f", "codex"]);',
			'execSync("killall codex");',
			'sh("pgrep -f codex | xargs kill -9");',
			"sh('kill -9 $(pgrep codex)');",
		]) {
			expect(rules(scanText("scripts/rogue.ts", planted)), planted).toContain("kill-by-name");
		}
	});

	test("(d) searching for processes by name outside the one helper is flagged; the helper itself isn't", () => {
		const planted = 'const pids = spawnSync("pgrep", ["-x", "codex"]).stdout;';
		expect(rules(scanText("scripts/rogue.ts", planted))).toContain("process-search");
		expect(scanText(PROCESS_SEARCH_FILE, planted)).toEqual([]);
	});

	test("(e) a terminal user interface is flagged", () => {
		for (const planted of [
			'import pty from "node-pty";',
			"pty.spawn(shell)",
			'spawn("script", ["-q", "/dev/null", "codex"])',
		]) {
			expect(rules(scanText("scripts/rogue.ts", planted)), planted).toContain("tui");
		}
	});

	test("a planted string in a comment is not a finding (the scan reads code)", () => {
		expect(
			scanText("scripts/ok.ts", '// spawn("codex", ["daemon", "bootstrap"]) pkill codex'),
		).toEqual([]);
	});

	test("the scan reaches a planted file written to disk, so it can't be satisfied by reading nothing", () => {
		const dir = mkdtempSync(join(tmpdir(), "codex-scan-"));
		try {
			const file = join(dir, "rogue.ts");
			require("node:fs").writeFileSync(file, 'spawnSync("pkill", ["-f", "codex"]);');
			const found = scanCanarySource([
				{ path: "scripts/rogue.ts", text: readFileSync(file, "utf-8") },
			]);
			expect(found.map((f) => f.rule)).toEqual(["kill-by-name"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
