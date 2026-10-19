import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SpawnCwdError,
	assertCwdTrusted,
	assertTrustedRootsExcludeAgentpulseDir,
	canonicalSpawnCwd,
} from "./spawn-cwd.js";

let home: string;
let trusted: string;
let project: string;
let secret: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "ap-spawn-cwd-")));
	trusted = join(home, "trusted");
	project = join(trusted, "project");
	secret = join(home, "secret", "deep");
	mkdirSync(project, { recursive: true });
	mkdirSync(secret, { recursive: true });
	mkdirSync(join(home, "secret", "trusted-twin"), { recursive: true });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("canonicalSpawnCwd", () => {
	test("returns the real path it checked, not the string it was given", async () => {
		const link = join(trusted, "alias");
		symlinkSync(project, link);
		expect(await canonicalSpawnCwd(link, [trusted])).toBe(project);
		expect(await canonicalSpawnCwd(`${project}/`, [trusted])).toBe(project);
	});

	test("a symlink inside a trusted root that points outside it is refused", async () => {
		const link = join(trusted, "escape");
		symlinkSync(join(home, "secret"), link);
		await expect(canonicalSpawnCwd(link, [trusted])).rejects.toThrow(
			"outside this host's trusted roots",
		);
		await expect(canonicalSpawnCwd(join(link, "deep"), [trusted])).rejects.toBeInstanceOf(
			SpawnCwdError,
		);
	});

	test("'..' after a symlink is refused up front, whether or not it would land inside", async () => {
		const link = join(trusted, "escape");
		symlinkSync(secret, link);
		// link/.. is home/secret (outside); link/../trusted-twin is a sibling of the link's target.
		for (const path of [`${link}/..`, `${link}/../trusted-twin`, `${project}/../project`, "../x"]) {
			await expect(canonicalSpawnCwd(path, [trusted])).rejects.toThrow("'..'");
			await expect(assertCwdTrusted(path, [trusted])).rejects.toThrow("'..'");
		}
	});

	test("a directory that doesn't exist, or is outside every root, is refused", async () => {
		await expect(canonicalSpawnCwd(join(trusted, "nope"), [trusted])).rejects.toThrow(
			"doesn't exist",
		);
		await expect(canonicalSpawnCwd(secret, [trusted])).rejects.toThrow(
			"outside this host's trusted roots",
		);
		await expect(canonicalSpawnCwd(trusted, [])).rejects.toThrow("outside");
	});

	test("a sibling that merely shares a prefix with a root is outside it", async () => {
		const sibling = join(home, "trusted-evil");
		mkdirSync(sibling);
		await expect(canonicalSpawnCwd(sibling, [trusted])).rejects.toThrow("outside");
	});
});

describe("assertCwdTrusted", () => {
	test("a directory that doesn't exist yet is fine under a trusted root (a prelaunch action may create it)", async () => {
		await expect(
			assertCwdTrusted(join(project, "new", "child"), [trusted]),
		).resolves.toBeUndefined();
	});

	test("a missing directory under a symlink that leaves the root is refused", async () => {
		const link = join(trusted, "escape");
		symlinkSync(join(home, "secret"), link);
		await expect(assertCwdTrusted(join(link, "not-yet"), [trusted])).rejects.toThrow("outside");
	});
});

describe("assertTrustedRootsExcludeAgentpulseDir", () => {
	let previousHome: string | undefined;
	beforeEach(() => {
		previousHome = process.env.HOME;
		process.env.HOME = join(home, "userhome");
		mkdirSync(join(home, "userhome", ".agentpulse"), { recursive: true });
	});
	afterEach(() => {
		process.env.HOME = previousHome;
	});

	test("a root that is the home directory, or an ancestor of it, or the state directory itself, is refused", async () => {
		for (const root of [join(home, "userhome"), home, join(home, "userhome", ".agentpulse")]) {
			await expect(assertTrustedRootsExcludeAgentpulseDir([trusted, root])).rejects.toThrow(
				"narrower trusted root",
			);
		}
	});

	test("a symlinked root that resolves to an ancestor of the state directory is refused", async () => {
		const link = join(home, "root-link");
		symlinkSync(join(home, "userhome"), link);
		await expect(assertTrustedRootsExcludeAgentpulseDir([link])).rejects.toThrow("narrower");
	});

	test("when HOME is itself a symlink, a root given as the real path is still refused", async () => {
		const real = join(home, "real-home");
		mkdirSync(join(real, ".agentpulse"), { recursive: true });
		const linkedHome = join(home, "linked-home");
		symlinkSync(real, linkedHome);
		process.env.HOME = linkedHome;
		await expect(assertTrustedRootsExcludeAgentpulseDir([real])).rejects.toThrow("narrower");
	});

	test("roots beside or below the home directory, not containing the state directory, are fine", async () => {
		mkdirSync(join(home, "userhome", "dev"), { recursive: true });
		await expect(
			assertTrustedRootsExcludeAgentpulseDir([join(home, "userhome", "dev"), trusted]),
		).resolves.toBeUndefined();
	});
});
