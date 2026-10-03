/**
 * F207: writePrivateFileSyncNoFollow must never follow a symlink at the
 * destination, and must always leave the file at 0600 regardless of what
 * mode it (or a pre-existing file at that path) started at.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	tightenPrivateFilePermissionsSync,
	writeConfigFileSyncNoFollow,
	writePrivateFileAtomicNoFollow,
	writePrivateFileSyncNoFollow,
} from "./private-file.js";

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

	test("AGEN-21 (xander): a multiply hard-linked path is refused, the other link's data untouched", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-file-"));
		const original = join(dir, "original-secret");
		writeFileSync(original, "should never change\n", { mode: 0o644 });
		const target = join(dir, "secret");
		linkSync(original, target);
		expect(() => writePrivateFileSyncNoFollow(target, "attacker-controlled\n")).toThrow(
			/refusing to write through hardlink/,
		);
		expect(readFileSync(original, "utf-8")).toBe("should never change\n");
	});

	test("F241: a symlinked parent directory is refused, its target untouched", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-file-"));
		const realDir = join(dir, "real-dir");
		mkdirSync(realDir);
		const symlinkedDir = join(dir, "symlinked-dir");
		symlinkSync(realDir, symlinkedDir);
		const target = join(symlinkedDir, "secret");
		expect(() => writePrivateFileSyncNoFollow(target, "attacker-controlled\n")).toThrow(
			/refusing to write into a symlinked directory/,
		);
		expect(statSync(realDir).isDirectory()).toBe(true);
		expect(() => statSync(join(realDir, "secret"))).toThrow();
	});
});

/**
 * F232 (xander, Medium): the same symlink-refusal guarantee as
 * writePrivateFileSyncNoFollow above, but at 0644 — for config files a CLI
 * tool needs to read back (Codex/Copilot hooks.json and their backups),
 * where a 0600 lockdown would just break the tool being configured.
 */
describe("writePrivateFileAtomicNoFollow", () => {
	test("writes content and leaves the file at 0600", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-"));
		const target = join(dir, "exclude");
		writePrivateFileAtomicNoFollow(target, "/a/work\n");
		expect(readFileSync(target, "utf-8")).toBe("/a/work\n");
		expect(fileMode(target)).toBe(0o600);
	});

	test("refuses a symlinked parent directory", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-"));
		const realDir = join(dir, "real");
		mkdirSync(realDir);
		const linkedDir = join(dir, "linked");
		symlinkSync(realDir, linkedDir);
		expect(() => writePrivateFileAtomicNoFollow(join(linkedDir, "exclude"), "x\n")).toThrow(
			/symlinked directory/,
		);
	});

	test("overwrites existing content correctly", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-"));
		const target = join(dir, "exclude");
		writePrivateFileAtomicNoFollow(target, "/a/first\n");
		writePrivateFileAtomicNoFollow(target, "/a/first\n/a/second\n");
		expect(readFileSync(target, "utf-8")).toBe("/a/first\n/a/second\n");
	});

	// The core guarantee: a failure injected between the temp write and the
	// rename must never leave the real target empty or partially written —
	// it must still hold whatever it held before this call started.
	test("a failure between write and rename leaves the original target intact, never empty", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-"));
		const target = join(dir, "exclude");
		writePrivateFileAtomicNoFollow(target, "/a/original\n");
		expect(readFileSync(target, "utf-8")).toBe("/a/original\n");

		expect(() =>
			writePrivateFileAtomicNoFollow(target, "/a/original\n/a/new\n", {
				rename: () => {
					throw new Error("simulated crash between write and rename");
				},
			}),
		).toThrow(/simulated crash/);

		// The target is untouched — still the ORIGINAL content, never empty,
		// never the new content either (the rename that would have swapped
		// it in never happened).
		expect(readFileSync(target, "utf-8")).toBe("/a/original\n");
	});

	test("a failure between write and rename doesn't leak the temp file", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-"));
		const target = join(dir, "exclude");
		expect(() =>
			writePrivateFileAtomicNoFollow(target, "/a/new\n", {
				rename: () => {
					throw new Error("simulated crash between write and rename");
				},
			}),
		).toThrow();
		const entries = readdirSync(dir);
		expect(entries).toEqual([]);
	});

	test("a short write is continued until every byte is on disk", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-"));
		const target = join(dir, "exclude");
		const content = "/a/one\n/a/two\n/a/three\n";
		let calls = 0;
		writePrivateFileAtomicNoFollow(target, content, {
			write: (fd, buffer, offset, length) => {
				calls++;
				return writeSync(fd, buffer, offset, Math.min(length, 5));
			},
		});
		expect(readFileSync(target, "utf-8")).toBe(content);
		expect(calls).toBeGreaterThan(1);
	});

	test("a write that makes no progress fails instead of looping, and leaves the original", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-"));
		const target = join(dir, "exclude");
		writePrivateFileAtomicNoFollow(target, "/a/original\n");
		expect(() => writePrivateFileAtomicNoFollow(target, "/a/new\n", { write: () => 0 })).toThrow(
			/no progress|short write/i,
		);
		expect(readFileSync(target, "utf-8")).toBe("/a/original\n");
		expect(readdirSync(dir)).toEqual(["exclude"]);
	});

	test("the real rename is used by default and actually renames (not a copy left behind)", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-private-"));
		const target = join(dir, "exclude");
		writePrivateFileAtomicNoFollow(target, "/a/work\n");
		expect(readdirSync(dir)).toEqual(["exclude"]);
	});
});

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

	test("F241: a symlinked parent directory is refused, its target untouched", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-config-file-"));
		const realDir = join(dir, "real-dir");
		mkdirSync(realDir);
		const symlinkedDir = join(dir, "symlinked-dir");
		symlinkSync(realDir, symlinkedDir);
		const target = join(symlinkedDir, "hooks.json");
		expect(() => writeConfigFileSyncNoFollow(target, "attacker-controlled\n")).toThrow(
			/refusing to write into a symlinked directory/,
		);
		expect(statSync(realDir).isDirectory()).toBe(true);
		expect(() => statSync(join(realDir, "hooks.json"))).toThrow();
	});
});

/**
 * AGEN-21: tightenPrivateFilePermissionsSync is the startup self-heal for a
 * secret-bearing file left over-permissive by an installer or a pre-fix
 * writer — currently ~/.agentpulse/supervisor.json. Never follows a
 * symlink; never creates a missing file (nothing to tighten on first run,
 * since writePrivateFileSyncNoFollow already creates at 0600).
 */
describe("tightenPrivateFilePermissionsSync (AGEN-21)", () => {
	test("a missing path is a no-op", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-tighten-"));
		const target = join(dir, "supervisor.json");
		expect(tightenPrivateFilePermissionsSync(target)).toEqual({
			tightened: false,
			reason: "missing",
		});
	});

	test("a pre-existing 0644 file is tightened to 0600", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-tighten-"));
		const target = join(dir, "supervisor.json");
		writeFileSync(target, '{"serverUrl":"http://localhost:3000"}\n', { mode: 0o644 });
		expect(fileMode(target)).toBe(0o644);

		const result = tightenPrivateFilePermissionsSync(target);

		expect(result).toEqual({ tightened: true, previousMode: 0o644 });
		expect(fileMode(target)).toBe(0o600);
		expect(readFileSync(target, "utf-8")).toBe('{"serverUrl":"http://localhost:3000"}\n');
	});

	test("an already-0600 file is a no-op (content and mode both untouched)", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-tighten-"));
		const target = join(dir, "supervisor.json");
		writeFileSync(target, "already private\n", { mode: 0o600 });

		expect(tightenPrivateFilePermissionsSync(target)).toEqual({
			tightened: false,
			reason: "already-private",
		});
		expect(fileMode(target)).toBe(0o600);
		expect(readFileSync(target, "utf-8")).toBe("already private\n");
	});

	test("a symlink at the path is refused, not followed — target mode and content untouched", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-tighten-"));
		const real = join(dir, "outside-target");
		writeFileSync(real, "should never change\n", { mode: 0o644 });
		const target = join(dir, "supervisor.json");
		symlinkSync(real, target);

		expect(tightenPrivateFilePermissionsSync(target)).toEqual({
			tightened: false,
			reason: "symlink",
		});
		expect(readFileSync(real, "utf-8")).toBe("should never change\n");
		expect(fileMode(real)).toBe(0o644);
	});

	test("AGEN-21 (xander): a multiply hard-linked path is refused, not fchmod'd via the other link", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-tighten-"));
		const original = join(dir, "original-supervisor.json");
		writeFileSync(original, '{"serverUrl":"http://localhost:3000"}\n', { mode: 0o644 });
		const target = join(dir, "supervisor.json");
		linkSync(original, target);

		expect(tightenPrivateFilePermissionsSync(target)).toEqual({
			tightened: false,
			reason: "hardlink",
		});
		expect(fileMode(original)).toBe(0o644);
		expect(fileMode(target)).toBe(0o644);
	});

	test("refuses a directory at the path rather than fchmod'ing it", () => {
		dir = mkdtempSync(join(tmpdir(), "ap-tighten-"));
		const target = join(dir, "a-directory");
		mkdirSync(target, { mode: 0o755 });

		expect(tightenPrivateFilePermissionsSync(target)).toEqual({
			tightened: false,
			reason: "not-a-file",
		});
	});
});
