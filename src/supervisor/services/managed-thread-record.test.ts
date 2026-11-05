import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
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
import { MAX_THREAD_RECORD_ENTRIES, createManagedThreadRecord } from "./managed-thread-record.js";

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "thread-record-"));
	chmodSync(dir, 0o700);
	file = join(dir, "managed-threads.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const record = (
	extra: Parameters<typeof createManagedThreadRecord>[0] extends infer T ? Partial<T> : never = {},
) =>
	createManagedThreadRecord({
		path: file,
		now: () => Date.parse("2026-11-05T10:00:00.000Z"),
		...extra,
	});

describe("managed thread record (recovery's proof)", () => {
	test("no file: nothing is known, and reading writes nothing", () => {
		expect(record().lookup("launch-1")).toBeNull();
		expect(existsSync(file)).toBe(false);
	});

	test("write then lookup; the file is 0600 and holds createdAt, fixed when first written", () => {
		const r = record();
		r.write("launch-1", "thread-1");
		const later = createManagedThreadRecord({
			path: file,
			now: () => Date.parse("2026-11-06T00:00:00.000Z"),
		});
		later.write("launch-2", "thread-2");
		expect(record().lookup("launch-1")).toBe("thread-1");
		expect(record().lookup("launch-2")).toBe("thread-2");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8")).createdAt).toBe("2026-11-05T10:00:00.000Z");
		expect(record().createdAt()).toBe("2026-11-05T10:00:00.000Z");
	});

	test("another launch's thread id is not this launch's", () => {
		record().write("launch-1", "thread-1");
		expect(record().lookup("launch-2")).toBeNull();
		expect(record().lookup("launch-1")).not.toBe("thread-2");
	});

	test("keeps 1024 entries, newest first: the 1025th evicts the oldest", () => {
		const r = record();
		for (let i = 0; i < MAX_THREAD_RECORD_ENTRIES + 1; i++) r.write(`l-${i}`, `t-${i}`);
		const fresh = record();
		expect(fresh.lookup("l-0")).toBeNull();
		expect(fresh.lookup("l-1")).toBe("t-1");
		expect(fresh.lookup(`l-${MAX_THREAD_RECORD_ENTRIES}`)).toBe(`t-${MAX_THREAD_RECORD_ENTRIES}`);
		expect(JSON.parse(readFileSync(file, "utf8")).entries.length).toBe(MAX_THREAD_RECORD_ENTRIES);
	});

	test("rewriting a launch moves it to the front and keeps one entry", () => {
		const r = record();
		r.write("l-1", "t-1");
		r.write("l-2", "t-2");
		r.write("l-1", "t-1b");
		expect(JSON.parse(readFileSync(file, "utf8")).entries[0]).toMatchObject({
			launchRequestId: "l-1",
			threadId: "t-1b",
		});
		expect(JSON.parse(readFileSync(file, "utf8")).entries.length).toBe(2);
	});

	test("a file that is a symlink, group-readable, or invalid JSON reads as empty (no createdAt either)", () => {
		const real = join(dir, "real.json");
		writeFileSync(
			real,
			JSON.stringify({
				version: 1,
				createdAt: "2020-01-01T00:00:00.000Z",
				entries: [{ launchRequestId: "l", threadId: "t", at: "x" }],
			}),
			{ mode: 0o600 },
		);
		symlinkSync(real, file);
		expect(record().lookup("l")).toBeNull();
		expect(record().createdAt()).toBeNull();
		rmSync(file);

		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				createdAt: "2020-01-01T00:00:00.000Z",
				entries: [{ launchRequestId: "l", threadId: "t", at: "x" }],
			}),
			{ mode: 0o644 },
		);
		chmodSync(file, 0o644);
		expect(record().lookup("l")).toBeNull();
		expect(record().createdAt()).toBeNull();

		writeFileSync(file, "{not json", { mode: 0o600 });
		expect(record().lookup("l")).toBeNull();
	});

	test("a directory others can write into is untrusted", () => {
		chmodSync(dir, 0o777);
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				createdAt: "2020-01-01T00:00:00.000Z",
				entries: [{ launchRequestId: "l", threadId: "t", at: "x" }],
			}),
			{ mode: 0o600 },
		);
		expect(record().lookup("l")).toBeNull();
	});

	test("a write that fails never throws (a launch must not fail for it) and leaves no partial file", () => {
		const blocked = createManagedThreadRecord({
			path: join(dir, "missing", "deep", "x.json"),
			now: Date.now,
			log: () => {},
		});
		mkdirSync(join(dir, "ro"), { mode: 0o500 });
		const ro = createManagedThreadRecord({
			path: join(dir, "ro", "x.json"),
			now: Date.now,
			log: () => {},
		});
		expect(() => ro.write("l", "t")).not.toThrow();
		expect(ro.lookup("l")).toBeNull();
		expect(existsSync(join(dir, "ro", "x.json"))).toBe(false);
		expect(() => blocked.write("l", "t")).not.toThrow();
		chmodSync(join(dir, "ro"), 0o700);
	});

	test("an oversized or malformed entry list reads as empty", () => {
		writeFileSync(
			file,
			JSON.stringify({ version: 1, createdAt: "2020-01-01T00:00:00.000Z", entries: "nope" }),
			{ mode: 0o600 },
		);
		expect(record().lookup("l")).toBeNull();
	});

	test("a file that exists but can't be trusted is replaced with a 'none' marker: no thread qualifies for the pre-upgrade path afterwards", () => {
		const untrusted = JSON.stringify({
			version: 1,
			createdAt: "2020-01-01T00:00:00.000Z",
			entries: [],
		});
		for (const make of [
			() => writeFileSync(file, untrusted, { mode: 0o644 }),
			() => writeFileSync(file, "{not json", { mode: 0o600 }),
		]) {
			rmSync(file, { force: true });
			make();
			chmodSync(file, statSync(file).mode & 0o777);
			const r = record();
			r.write("launch-1", "thread-1");
			expect(JSON.parse(readFileSync(file, "utf8")).createdAt).toBe("none");
			expect(r.createdAt()).toBeNull();
			// The entry itself is still recorded, so a recovery of THIS launch works.
			expect(r.lookup("launch-1")).toBe("thread-1");
			// And a later write doesn't turn the marker into a date.
			r.write("launch-2", "thread-2");
			expect(r.createdAt()).toBeNull();
		}
	});

	test("an absent file still gets a real createdAt (the control)", () => {
		const r = record();
		r.write("launch-1", "thread-1");
		expect(r.createdAt()).toBe("2026-11-05T10:00:00.000Z");
	});
});
