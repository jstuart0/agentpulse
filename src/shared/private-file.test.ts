/**
 * F207: writePrivateFileSyncNoFollow must never follow a symlink at the
 * destination, and must always leave the file at 0600 regardless of what
 * mode it (or a pre-existing file at that path) started at.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfigFileSyncNoFollow, writePrivateFileSyncNoFollow } from "./private-file.js";

let dir: string;

function fileMode(path: string) {
	return statSync(path).mode & 0o777;
}

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("writePrivateFileSyncNoFollow", () => {
	test("creates a new file at 0600", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-file-"));
		const target = join(dir, "secret");
		writePrivateFileSyncNoFollow(target, "hello\n");
		expect(readFileSync(target, "utf-8")).toBe("hello\n");
		expect(fileMode(target)).toBe(0o600);
	});

	test("a pre-existing 0644 file ends up 0600", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-file-"));
		const target = join(dir, "secret");
		writeFileSync(target, "old\n", { mode: 0o644 });
		expect(fileMode(target)).toBe(0o644);
		writePrivateFileSyncNoFollow(target, "new\n");
		expect(readFileSync(target, "utf-8")).toBe("new\n");
		expect(fileMode(target)).toBe(0o600);
	});

	test("a symlink at the path is refused, not followed", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-file-"));
		const real = join(dir, "outside-target");
		writeFileSync(real, "should never change\n", { mode: 0o644 });
		const target = join(dir, "secret");
		symlinkSync(real, target);
		expect(() => writePrivateFileSyncNoFollow(target, "attacker-controlled\n")).toThrow(
			/refusing to write through symlink/,
		);
		expect(readFileSync(real, "utf-8")).toBe("should never change\n");
		expect(fileMode(real)).toBe(0o644);
	});

	test("truncates and replaces existing content rather than appending", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-file-"));
		const target = join(dir, "secret");
		writePrivateFileSyncNoFollow(target, "a very long first line that is longer\n");
		writePrivateFileSyncNoFollow(target, "short\n");
		expect(readFileSync(target, "utf-8")).toBe("short\n");
	});

	test("refuses to write through a directory", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-file-"));
		const target = join(dir, "a-directory");
		mkdirSync(target);
		expect(() => writePrivateFileSyncNoFollow(target, "x\n")).toThrow(
			/refusing to write through other/,
		);
	});
});

/**
 * F232 (xander, Medium): the same symlink-refusal guarantee as
 * writePrivateFileSyncNoFollow above, but at 0644 — for config files a CLI
 * tool needs to read back (Codex/Copilot hooks.json and their backups),
 * where a 0600 lockdown would just break the tool being configured.
 */
describe("writeConfigFileSyncNoFollow (F232)", () => {
	test("creates a new file at 0644, not 0600", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-config-file-"));
		const target = join(dir, "hooks.json");
		writeConfigFileSyncNoFollow(target, '{"hooks":{}}\n');
		expect(readFileSync(target, "utf-8")).toBe('{"hooks":{}}\n');
		expect(fileMode(target)).toBe(0o644);
	});

	test("a pre-existing 0600 file ends up 0644", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-config-file-"));
		const target = join(dir, "hooks.json");
		writeFileSync(target, "old\n", { mode: 0o600 });
		writeConfigFileSyncNoFollow(target, "new\n");
		expect(readFileSync(target, "utf-8")).toBe("new\n");
		expect(fileMode(target)).toBe(0o644);
	});

	test("a symlink at the hooks-file path is refused, not followed", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-config-file-"));
		const real = join(dir, "outside-target");
		writeFileSync(real, "should never change\n", { mode: 0o644 });
		const target = join(dir, "hooks.json");
		symlinkSync(real, target);
		expect(() => writeConfigFileSyncNoFollow(target, "attacker-controlled\n")).toThrow(
			/refusing to write through symlink/,
		);
		expect(readFileSync(real, "utf-8")).toBe("should never change\n");
	});

	test("a symlink at the backup-file path is refused, not followed (same primitive, a different path)", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-config-file-"));
		const real = join(dir, "outside-target");
		writeFileSync(real, "should never change\n", { mode: 0o644 });
		const backupPath = join(dir, "hooks.json.agentpulse-bak.20260929T000000Z");
		symlinkSync(real, backupPath);
		expect(() => writeConfigFileSyncNoFollow(backupPath, "old hooks content\n")).toThrow(
			/refusing to write through symlink/,
		);
		expect(readFileSync(real, "utf-8")).toBe("should never change\n");
	});

	test("truncates and replaces existing content rather than appending", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-config-file-"));
		const target = join(dir, "hooks.json");
		writeConfigFileSyncNoFollow(target, "a very long first line that is longer\n");
		writeConfigFileSyncNoFollow(target, "short\n");
		expect(readFileSync(target, "utf-8")).toBe("short\n");
	});
});
