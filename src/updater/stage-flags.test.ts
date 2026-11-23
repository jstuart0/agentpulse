/**
 * The install flags that make fetched code safe to stage: no lifecycle script ever runs, and a lockfile that
 * doesn't match package.json is a failure, not a resolution. Offline: the dependency is a `file:` package.
 * The control runs `bun install` without `--ignore-scripts` on the same tree and does see the sentinel, so
 * a test that passed only because Bun happened to block the script would show.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRun } from "./exec.js";
import { buildStaged } from "./stage.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ap-flags-"));
	mkdirSync(join(root, "dep"));
	writeFileSync(
		join(root, "dep", "package.json"),
		JSON.stringify({
			name: "dep",
			version: "1.0.0",
			scripts: { postinstall: "echo ran > ../sentinel" },
		}),
	);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			name: "fixture",
			version: "0.2.0",
			dependencies: { dep: "file:./dep" },
			trustedDependencies: ["dep"],
			scripts: { build: "echo built" },
		}),
	);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// Each test's own scratch directory is its HOME, so nothing here can reach the real one.
const deps = () => ({ run: defaultRun, env: { PATH: process.env.PATH, HOME: root }, home: root });
const sentinel = () => existsSync(join(root, "node_modules", "sentinel"));

/** The instrument fails loudly when it can't make its lockfile: the cases below measure nothing without one. */
async function makeLockfile() {
	const proc = Bun.spawn([process.execPath, "install", "--ignore-scripts"], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
	expect({ code, output: code === 0 ? "" : output }).toEqual({ code: 0, output: "" });
	expect(existsSync(join(root, "bun.lock"))).toBe(true);
	rmSync(join(root, "node_modules"), { recursive: true, force: true });
}

describe("stage flags", () => {
	test("control: without --ignore-scripts the trusted dependency's postinstall runs", async () => {
		await makeLockfile();
		// The precondition: nothing has run the script yet, so a sentinel after the install is the install's.
		expect(sentinel()).toBe(false);
		const proc = Bun.spawn([process.execPath, "install", "--frozen-lockfile"], {
			cwd: root,
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(await proc.exited).toBe(0);
		expect(existsSync(join(root, "node_modules", "dep"))).toBe(true);
		expect(sentinel()).toBe(true);
	});

	test("buildStaged leaves no sentinel", async () => {
		await makeLockfile();
		const result = await buildStaged(deps(), { staging: root, bunBin: process.execPath });
		expect(result).toEqual({ ok: true });
		expect(existsSync(join(root, "node_modules", "dep"))).toBe(true);
		expect(sentinel()).toBe(false);
	});

	test("a lockfile that is out of sync is install_failed", async () => {
		await makeLockfile();
		mkdirSync(join(root, "dep2"));
		writeFileSync(
			join(root, "dep2", "package.json"),
			JSON.stringify({ name: "dep2", version: "1.0.0" }),
		);
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "fixture",
				version: "0.2.0",
				dependencies: { dep: "file:./dep", dep2: "file:./dep2" },
				trustedDependencies: ["dep"],
				scripts: { build: "echo built" },
			}),
		);
		expect(await buildStaged(deps(), { staging: root, bunBin: process.execPath })).toEqual({
			ok: false,
			code: "install_failed",
		});
	});

	test("a tree with no bun.lock is install_failed, and nothing is installed", async () => {
		expect(existsSync(join(root, "bun.lock"))).toBe(false);
		expect(await buildStaged(deps(), { staging: root, bunBin: process.execPath })).toEqual({
			ok: false,
			code: "install_failed",
		});
		expect(existsSync(join(root, "node_modules"))).toBe(false);
	});

	test("a bun.lock that is a link or a directory is install_failed", async () => {
		await makeLockfile();
		renameSync(join(root, "bun.lock"), join(root, "real.lock"));
		symlinkSync(join(root, "real.lock"), join(root, "bun.lock"));
		expect(await buildStaged(deps(), { staging: root, bunBin: process.execPath })).toEqual({
			ok: false,
			code: "install_failed",
		});
		rmSync(join(root, "bun.lock"));
		mkdirSync(join(root, "bun.lock"));
		expect(await buildStaged(deps(), { staging: root, bunBin: process.execPath })).toEqual({
			ok: false,
			code: "install_failed",
		});
		expect(existsSync(join(root, "node_modules"))).toBe(false);
	});

	test("a build that fails is build_failed", async () => {
		await makeLockfile();
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "fixture",
				version: "0.2.0",
				dependencies: { dep: "file:./dep" },
				trustedDependencies: ["dep"],
				scripts: { build: "exit 3" },
			}),
		);
		expect(await buildStaged(deps(), { staging: root, bunBin: process.execPath })).toEqual({
			ok: false,
			code: "build_failed",
		});
	});
});
