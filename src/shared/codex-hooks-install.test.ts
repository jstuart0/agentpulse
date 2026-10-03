/**
 * The CLI's Codex hooks.json step: read, merge, back up, write atomically.
 * Every failure to read or write is reported as a skip with a plain message
 * and leaves the file and the directory exactly as they were.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCodexHooksFile } from "./codex-hooks-install.js";
import { buildCodexHooksFile } from "./hook-command.js";
import { writeConfigFileAtomicNoFollow } from "./private-file.js";

const OURS = buildCodexHooksFile({ baseUrl: "http://localhost:3000", direct: true });
const THEIRS = `${JSON.stringify({ "x-other-tool": 1, hooks: { Stop: [{ hooks: [{ type: "command", command: "theirs" }] }] } }, null, 2)}\n`;
const made: string[] = [];
afterAll(() => {
	for (const dir of made) {
		try {
			chmodSync(dir, 0o755);
		} catch {}
		rmSync(dir, { recursive: true, force: true });
	}
});

function scratch(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-codex-install-")));
	made.push(dir);
	return dir;
}

const failingWriter = (code: string) => (path: string, content: string) =>
	writeConfigFileAtomicNoFollow(path, content, {
		write: () => {
			throw Object.assign(new Error(`${code}: write failed`), { code });
		},
	});

describe("installCodexHooksFile", () => {
	test("no file: writes ours, mode 0644, nothing else left in the directory", () => {
		const dir = scratch();
		const path = join(dir, "hooks.json");
		expect(installCodexHooksFile(path, OURS)).toEqual({ status: "written", hadFile: false });
		expect(readFileSync(path, "utf-8")).toBe(OURS);
		expect(statSync(path).mode & 0o777).toBe(0o644);
		expect(readdirSync(dir)).toEqual(["hooks.json"]);
	});

	test("merges into another tool's file with a backup, then a re-run is unchanged and writes nothing", () => {
		const dir = scratch();
		const path = join(dir, "hooks.json");
		writeFileSync(path, THEIRS);
		const first = installCodexHooksFile(path, OURS);
		expect(first.status).toBe("written");
		const merged = JSON.parse(readFileSync(path, "utf-8"));
		expect(merged["x-other-tool"]).toBe(1);
		expect(merged.hooks.Stop[0].hooks[0].command).toBe("theirs");
		const backups = readdirSync(dir).filter((f) => f.includes("agentpulse-bak"));
		expect(backups).toHaveLength(1);
		expect(readFileSync(join(dir, backups[0] as string), "utf-8")).toBe(THEIRS);
		const ino = statSync(path).ino;
		expect(installCodexHooksFile(path, OURS)).toEqual({ status: "unchanged" });
		expect(statSync(path).ino).toBe(ino);
	});

	test("malformed JSON: skipped with a message naming the file, untouched, no backup", () => {
		const dir = scratch();
		const path = join(dir, "hooks.json");
		writeFileSync(path, "{nope");
		const r = installCodexHooksFile(path, OURS);
		expect(r.status).toBe("skipped");
		if (r.status === "skipped") {
			expect(r.message).toContain("Codex hooks not updated");
			expect(r.message).toContain(path);
			expect(r.message).toContain("is not valid JSON");
		}
		expect(readFileSync(path, "utf-8")).toBe("{nope");
		expect(readdirSync(dir)).toEqual(["hooks.json"]);
	});

	test("bytes that are not UTF-8 are not valid JSON and are never rewritten", () => {
		const dir = scratch();
		const path = join(dir, "hooks.json");
		const bytes = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
		writeFileSync(path, bytes);
		const r = installCodexHooksFile(path, OURS);
		expect(r.status).toBe("skipped");
		expect(readFileSync(path).equals(bytes)).toBe(true);
	});

	test("a directory where the file should be: skipped as unreadable, nothing created", () => {
		const dir = scratch();
		const path = join(dir, "hooks.json");
		mkdirSync(path);
		const r = installCodexHooksFile(path, OURS);
		expect(r.status).toBe("skipped");
		if (r.status === "skipped") expect(r.message).toContain("could not be read");
		expect(readdirSync(dir)).toEqual(["hooks.json"]);
		expect(readdirSync(path)).toEqual([]);
	});

	test("a read-only (0444) file: skipped, untouched, no backup", () => {
		const dir = scratch();
		const path = join(dir, "hooks.json");
		writeFileSync(path, THEIRS);
		chmodSync(path, 0o444);
		const r = installCodexHooksFile(path, OURS);
		expect(r.status).toBe("skipped");
		if (r.status === "skipped") expect(r.message).toContain("not writable");
		expect(readFileSync(path, "utf-8")).toBe(THEIRS);
		expect(readdirSync(dir)).toEqual(["hooks.json"]);
	});

	test("an unreadable (0000) file: skipped as unreadable", () => {
		if (process.getuid?.() === 0) return;
		const dir = scratch();
		const path = join(dir, "hooks.json");
		writeFileSync(path, THEIRS);
		chmodSync(path, 0o000);
		const r = installCodexHooksFile(path, OURS);
		expect(r.status).toBe("skipped");
		if (r.status === "skipped") expect(r.message).toContain("could not be read");
		chmodSync(path, 0o644);
		expect(readFileSync(path, "utf-8")).toBe(THEIRS);
	});

	test("a symlinked hooks.json is refused and its target untouched, even for an unusable target", () => {
		const dir = scratch();
		const decoy = join(dir, "decoy.json");
		writeFileSync(decoy, "should never change\n");
		symlinkSync(decoy, join(dir, "hooks.json"));
		expect(installCodexHooksFile(join(dir, "hooks.json"), OURS)).toEqual({
			status: "refused-symlink",
		});
		writeFileSync(decoy, THEIRS);
		expect(installCodexHooksFile(join(dir, "hooks.json"), OURS)).toEqual({
			status: "refused-symlink",
		});
		expect(readFileSync(decoy, "utf-8")).toBe(THEIRS);
		expect(lstatSync(join(dir, "hooks.json")).isSymbolicLink()).toBe(true);
	});

	test("a symlinked directory holding hooks.json: skipped as not writable-through, nothing written", () => {
		const dir = scratch();
		mkdirSync(join(dir, "real"));
		symlinkSync(join(dir, "real"), join(dir, "linked"));
		const r = installCodexHooksFile(join(dir, "linked", "hooks.json"), OURS);
		expect(r.status).toBe("skipped");
		if (r.status === "skipped") expect(r.message).toContain("could not be written");
		expect(readdirSync(join(dir, "real"))).toEqual([]);
	});

	test("a failing write (EFBIG, as under ulimit -f): the file is untouched, no backup, no temp file, message says so", () => {
		const dir = scratch();
		const path = join(dir, "hooks.json");
		writeFileSync(path, THEIRS);
		const r = installCodexHooksFile(path, OURS, failingWriter("EFBIG"));
		expect(r.status).toBe("skipped");
		if (r.status === "skipped") {
			expect(r.message).toContain("could not be written");
			expect(r.message).toContain("EFBIG");
		}
		expect(readFileSync(path, "utf-8")).toBe(THEIRS);
		expect(readdirSync(dir)).toEqual(["hooks.json"]);
	});

	test("the main write failing after the backup succeeded removes the backup again", () => {
		const dir = scratch();
		const path = join(dir, "hooks.json");
		writeFileSync(path, THEIRS);
		let calls = 0;
		const writer = (p: string, c: string) => {
			calls += 1;
			if (calls === 1) writeConfigFileAtomicNoFollow(p, c);
			else failingWriter("ENOSPC")(p, c);
		};
		const r = installCodexHooksFile(path, OURS, writer);
		expect(calls).toBe(2);
		expect(r.status).toBe("skipped");
		expect(readFileSync(path, "utf-8")).toBe(THEIRS);
		expect(readdirSync(dir)).toEqual(["hooks.json"]);
	});

	test("short writes are completed: the file is whole", () => {
		const dir = scratch();
		const path = join(dir, "hooks.json");
		const writer = (p: string, c: string) =>
			writeConfigFileAtomicNoFollow(p, c, {
				write: (fd, buffer, offset, length) => {
					const n = Math.min(length, 7);
					return require("node:fs").writeSync(fd, buffer, offset, n);
				},
			});
		expect(installCodexHooksFile(path, OURS, writer).status).toBe("written");
		expect(readFileSync(path, "utf-8")).toBe(OURS);
	});
});
