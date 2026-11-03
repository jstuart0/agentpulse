import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	closeSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	SESSION_ID_PATTERN,
	isPrivateOwnEntry,
	isPrivateOwnStat,
	isTrustedDirectoryStat,
	isTrustedStateFileStat,
	readBoundedText,
	readPrivateFileNoFollow,
	trustedDirectory,
} from "./private-store.js";

const ROOT = mkdtempSync(join(tmpdir(), "ap-private-store-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function privateDir(name: string): string {
	const dir = join(ROOT, name);
	mkdirSync(dir, { mode: 0o700 });
	chmodSync(dir, 0o700);
	return dir;
}

function privateFile(dir: string, name: string, text: string, mode = 0o600): string {
	const file = join(dir, name);
	writeFileSync(file, text, { mode });
	chmodSync(file, mode);
	return file;
}

describe("stat predicates", () => {
	const me = 501;
	const dir = (over = {}) => ({ isDirectory: () => true, uid: me, mode: 0o40700, ...over });
	const file = (over = {}) => ({
		isFile: () => true,
		nlink: 1,
		size: 10,
		uid: me,
		mode: 0o100600,
		...over,
	});

	test("isTrustedDirectoryStat", () => {
		expect(isTrustedDirectoryStat(dir(), me)).toBe(true);
		expect(isTrustedDirectoryStat(dir({ uid: me + 1 }), me)).toBe(false);
		expect(isTrustedDirectoryStat(dir({ mode: 0o40770 }), me)).toBe(false);
		expect(isTrustedDirectoryStat(dir({ isDirectory: () => false }), me)).toBe(false);
	});

	test("isTrustedStateFileStat takes the size bound", () => {
		expect(isTrustedStateFileStat(file({ size: 100 }), me, 100)).toBe(true);
		expect(isTrustedStateFileStat(file({ size: 101 }), me, 100)).toBe(false);
		expect(isTrustedStateFileStat(file({ nlink: 2 }), me, 100)).toBe(false);
		expect(isTrustedStateFileStat(file({ mode: 0o100640 }), me, 100)).toBe(false);
	});

	test("isPrivateOwnStat: the right kind, this user, private, not a symlink", () => {
		const entry = (over = {}) => ({
			uid: me,
			mode: 0o40700,
			isSymbolicLink: () => false,
			isDirectory: () => true,
			isSocket: () => false,
			...over,
		});
		expect(isPrivateOwnStat(entry(), "directory", me)).toBe(true);
		expect(isPrivateOwnStat(entry({ isSymbolicLink: () => true }), "directory", me)).toBe(false);
		expect(isPrivateOwnStat(entry(), "socket", me)).toBe(false);
		expect(isPrivateOwnStat(entry({ mode: 0o40750 }), "directory", me)).toBe(false);
	});

	test("SESSION_ID_PATTERN", () => {
		expect(SESSION_ID_PATTERN.test("abc_DEF-123")).toBe(true);
		for (const bad of ["", "a/b", "..", "a b", "x".repeat(129)]) {
			expect(SESSION_ID_PATTERN.test(bad), bad).toBe(false);
		}
	});
});

describe("on disk", () => {
	test("trustedDirectory and isPrivateOwnEntry", async () => {
		const dir = privateDir("trusted");
		expect(trustedDirectory(dir)).toBe(true);
		expect(await isPrivateOwnEntry(dir, "directory")).toBe(true);
		const open = join(ROOT, "open");
		mkdirSync(open, { mode: 0o777 });
		chmodSync(open, 0o777);
		expect(trustedDirectory(open)).toBe(false);
		expect(await isPrivateOwnEntry(open, "directory")).toBe(false);
		expect(await isPrivateOwnEntry(join(ROOT, "missing"), "directory")).toBe(false);
		const link = join(ROOT, "link");
		symlinkSync(dir, link);
		expect(trustedDirectory(link), "a symlink is not a directory we trust").toBe(false);
		expect(await isPrivateOwnEntry(link, "directory")).toBe(false);
	});

	test("readPrivateFileNoFollow: ok, absent and each way of being untrusted", () => {
		const dir = privateDir("read");
		const file = privateFile(dir, "f.json", '{"a":1}');
		expect(readPrivateFileNoFollow(file, 1024)).toEqual({ kind: "ok", text: '{"a":1}' });
		expect(readPrivateFileNoFollow(join(dir, "none.json"), 1024)).toEqual({ kind: "absent" });
		expect(readPrivateFileNoFollow(join(ROOT, "no-dir", "f.json"), 1024)).toEqual({
			kind: "absent",
		});

		const big = privateFile(dir, "big.json", "x".repeat(50));
		expect(readPrivateFileNoFollow(big, 49).kind).toBe("untrusted");
		expect(readPrivateFileNoFollow(big, 50).kind).toBe("ok");

		const loose = privateFile(dir, "loose.json", "{}", 0o644);
		expect(readPrivateFileNoFollow(loose, 1024).kind).toBe("untrusted");

		const linked = join(dir, "linked.json");
		symlinkSync(file, linked);
		expect(readPrivateFileNoFollow(linked, 1024).kind, "a symlink is never followed").toBe(
			"untrusted",
		);

		const twin = join(dir, "twin.json");
		linkSync(file, twin);
		expect(readPrivateFileNoFollow(file, 1024).kind, "a second hard link").toBe("untrusted");
	});

	test("a file larger than allowed is rejected by its size", () => {
		const dir = privateDir("grow");
		const exactly = privateFile(dir, "exactly.json", "x".repeat(100));
		expect(readPrivateFileNoFollow(exactly, 100)).toMatchObject({ kind: "ok" });
		const over = privateFile(dir, "over.json", "x".repeat(101));
		expect(readPrivateFileNoFollow(over, 100)).toMatchObject({ kind: "untrusted" });
	});

	test("readBoundedText reads at most maxBytes + 1: a file bigger than the bound is refused however the size check went", () => {
		const dir = privateDir("bounded");
		const file = privateFile(dir, "big.txt", "z".repeat(5_000));
		const readWith = (max: number) => {
			const fd = openSync(file, "r");
			try {
				return readBoundedText(fd, max);
			} finally {
				closeSync(fd);
			}
		};
		expect(readWith(100), "5,000 bytes, bound 100").toBeNull();
		expect(readWith(4_999)).toBeNull();
		const exact = openSync(file, "r");
		try {
			expect(readBoundedText(exact, 5_000)?.length, "exactly the bound is fine").toBe(5_000);
		} finally {
			closeSync(exact);
		}
		const empty = privateFile(dir, "empty.txt", "");
		const emptyFd = openSync(empty, "r");
		try {
			expect(readBoundedText(emptyFd, 10)).toBe("");
		} finally {
			closeSync(emptyFd);
		}
	});

	test("a file in a directory others can write into is untrusted, and no file there is absent", () => {
		const open = join(ROOT, "open-read");
		mkdirSync(open, { mode: 0o777 });
		chmodSync(open, 0o777);
		const file = join(open, "f.json");
		expect(readPrivateFileNoFollow(file, 1024)).toEqual({ kind: "absent" });
		writeFileSync(file, "{}", { mode: 0o600 });
		expect(readPrivateFileNoFollow(file, 1024)).toMatchObject({
			kind: "untrusted",
			why: "its directory is not private to this account",
		});
	});
});
