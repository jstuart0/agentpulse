import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "../supervisor/services/private-store.js";
import {
	readPrivateFileNoFollow,
	readPrivateFileNoFollowForTests,
	trustedDirectory,
	trustedDirectoryForTests,
} from "./private-read.js";

const ROOT = mkdtempSync(join(tmpdir(), "ap-private-read-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function privateDir(name: string): string {
	const dir = join(ROOT, name);
	mkdirSync(dir, { mode: 0o700 });
	chmodSync(dir, 0o700);
	return dir;
}
function put(dir: string, name: string, text: string, mode = 0o600): string {
	const file = join(dir, name);
	writeFileSync(file, text, { mode });
	chmodSync(file, mode);
	return file;
}
const myUid = process.getuid?.();
const posixOnly = process.platform === "win32" ? test.skip : test;

describe("readPrivateFileNoFollow (hoisted from the supervisor's private store)", () => {
	test("private-store re-exports the same functions", () => {
		expect(store.readPrivateFileNoFollow).toBe(readPrivateFileNoFollow);
		expect(store.trustedDirectory).toBe(trustedDirectory);
	});

	test("reads a private file", () => {
		const file = put(privateDir("ok"), "a.json", '{"a":1}');
		expect(readPrivateFileNoFollow(file, 100)).toEqual({ kind: "ok", text: '{"a":1}' });
	});

	test("a missing file is absent, a missing directory is absent", () => {
		expect(readPrivateFileNoFollow(join(privateDir("empty"), "nope"), 100)).toEqual({
			kind: "absent",
		});
		expect(readPrivateFileNoFollow(join(ROOT, "no-dir", "x"), 100)).toEqual({ kind: "absent" });
	});

	posixOnly("a file readable by others is untrusted", () => {
		const file = put(privateDir("open"), "a", "x", 0o644);
		expect(readPrivateFileNoFollow(file, 100).kind).toBe("untrusted");
	});

	posixOnly("a symlinked file is untrusted, never followed", () => {
		const dir = privateDir("link");
		const target = put(dir, "target", "x");
		symlinkSync(target, join(dir, "alias"));
		expect(readPrivateFileNoFollow(join(dir, "alias"), 100).kind).toBe("untrusted");
	});

	test("a file over the bound is untrusted", () => {
		const file = put(privateDir("big"), "a", "x".repeat(50));
		expect(readPrivateFileNoFollow(file, 10).kind).toBe("untrusted");
	});

	posixOnly("a world-writable directory makes its file untrusted", () => {
		const dir = join(ROOT, "writable");
		mkdirSync(dir, { mode: 0o777 });
		chmodSync(dir, 0o777);
		const file = put(dir, "a", "x");
		expect(readPrivateFileNoFollow(file, 100).kind).toBe("untrusted");
		expect(trustedDirectory(dir)).toBe(false);
	});

	posixOnly(
		"an injected owner uid that isn't ours reads as wrong-owner (file and directory)",
		() => {
			const dir = privateDir("owner");
			const file = put(dir, "a", "x");
			expect(readPrivateFileNoFollowForTests(file, 100, myUid as number).kind).toBe("ok");
			expect(readPrivateFileNoFollowForTests(file, 100, (myUid as number) + 1).kind).toBe(
				"untrusted",
			);
			expect(trustedDirectoryForTests(dir, myUid)).toBe(true);
			expect(trustedDirectoryForTests(dir, (myUid as number) + 1)).toBe(false);
		},
	);
});
