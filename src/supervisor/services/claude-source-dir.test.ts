/**
 * Where an observed Claude session started, proved from its own transcript (AGEN-117 T7). The encoding
 * vectors were computed outside this code (a separate implementation of the measured rule: every character
 * outside [A-Za-z0-9] becomes `-`; 201 characters or more are cut to 200, then `-` and the base-36 absolute
 * Java string hash of the original path), so the function is held to numbers, not to itself.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixtures from "../providers/__fixtures__/claude-2.1.318/s-head.json";
import {
	SCAN_MAX_CWDS,
	encodeProjectDirName,
	findSourceDirectory,
	firstTopLevelCwd,
	scanAllCwds,
} from "./claude-source-dir.js";

const S = "11111111-1111-4111-8111-111111111111";

describe("the project directory's name", () => {
	test.each([
		["/srv/work/my.proj", "-srv-work-my-proj"],
		["/srv/work/my_proj", "-srv-work-my-proj"],
		["/srv/work/my proj", "-srv-work-my-proj"],
		["/srv/work/.hidden", "-srv-work--hidden"],
		["/srv/work/café-日本-ü", "-srv-work-caf------"],
	])("%s", (cwd, expected) => {
		expect(encodeProjectDirName(cwd)).toBe(expected);
	});

	test("200 characters are kept whole; 201 are cut to 200 with a hash (signed hash positive)", () => {
		const at200 = `/srv/work/${"p".repeat(190)}`;
		expect(at200.length).toBe(200);
		expect(encodeProjectDirName(at200)).toBe(`-srv-work-${"p".repeat(190)}`);
		const at201 = `/srv/work/${"p".repeat(191)}`;
		const out = encodeProjectDirName(at201);
		expect(out).toBe(`-srv-work-${"p".repeat(190)}-xdg5o9`);
		expect(out.length).toBe(207);
	});

	test("a path whose signed hash is negative uses the absolute value", () => {
		const cwd = `/srv/work/${"q".repeat(120)}/${"r".repeat(120)}`;
		const out = encodeProjectDirName(cwd);
		expect(out.endsWith("-ei41fs")).toBe(true);
		expect(out.length).toBe(207);
	});
});

describe("the first top-level cwd", () => {
	const head = (...lines: unknown[]) =>
		Buffer.from(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

	test("the first user line's cwd, after the queue lines", () => {
		expect(
			firstTopLevelCwd(
				head({ type: "queue-operation" }, { type: "user", cwd: "/a/b" }, { cwd: "/c" }),
			),
		).toBe("/a/b");
	});

	test("a cwd only inside another value never counts, including a last prompt", () => {
		expect(
			firstTopLevelCwd(
				head(
					{ type: "user", message: { content: '"cwd":"/evil"' }, lastPrompt: '{"cwd":"/evil"}' },
					{ type: "x", nested: { cwd: "/evil" } },
				),
			),
		).toBeNull();
	});

	test("a line cut in the middle is not a line, and an empty cwd is none", () => {
		expect(firstTopLevelCwd(Buffer.from('{"type":"user","cwd":"/a'))).toBeNull();
		expect(firstTopLevelCwd(head({ cwd: "" }, { cwd: 3 }))).toBeNull();
	});
});

describe("finding the directory", () => {
	let root: string;
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "ap-src-dir-")));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	function put(project: string, cwd: string | null) {
		const dir = join(root, "projects", project);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${S}.jsonl`),
			`${JSON.stringify({ type: "user", ...(cwd ? { cwd } : {}) })}\n`,
		);
	}

	test("one transcript, the right encoding, a candidate inside: the directory", () => {
		put(encodeProjectDirName("/srv/work/a"), "/srv/work/a");
		expect(
			findSourceDirectory({ configDir: root, sessionId: S, candidate: "/srv/work/a/src" }),
		).toMatchObject({
			ok: true,
			dir: "/srv/work/a",
		});
	});

	test("a candidate outside is rejected; none is missing; two are rejected; a bad encoding is rejected; no cwd is missing", () => {
		put(encodeProjectDirName("/srv/work/a"), "/srv/work/a");
		expect(
			findSourceDirectory({ configDir: root, sessionId: S, candidate: "/srv/work/b" }),
		).toEqual({
			ok: false,
			kind: "rejected",
		});
		expect(
			findSourceDirectory({
				configDir: root,
				sessionId: "22222222-2222-4222-8222-222222222222",
				candidate: "/srv/work/a",
			}),
		).toEqual({ ok: false, kind: "missing" });
		put("-second", "/srv/work/a");
		expect(
			findSourceDirectory({ configDir: root, sessionId: S, candidate: "/srv/work/a" }),
		).toEqual({
			ok: false,
			kind: "rejected",
		});
		rmSync(join(root, "projects"), { recursive: true });
		put("-wrong", "/srv/work/a");
		expect(
			findSourceDirectory({ configDir: root, sessionId: S, candidate: "/srv/work/a" }).ok,
		).toBe(false);
		rmSync(join(root, "projects"), { recursive: true });
		put(encodeProjectDirName("/srv/work/a"), null);
		expect(
			findSourceDirectory({ configDir: root, sessionId: S, candidate: "/srv/work/a" }),
		).toEqual({
			ok: false,
			kind: "missing",
		});
	});

	test("an unknown config directory and an id that isn't a UUID are rejected", () => {
		expect(findSourceDirectory({ configDir: null, sessionId: S, candidate: "/a" }).ok).toBe(false);
		expect(findSourceDirectory({ configDir: root, sessionId: "../x", candidate: "/a" }).ok).toBe(
			false,
		);
	});
});

describe("the recorded Claude Code 2.1.318 heads (P0 s_head)", () => {
	let root: string;
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "ap-src-fixtures-")));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("there are twelve, and every one is found: the encoding, the first cwd and the transcript agree with the real files", () => {
		expect(fixtures.length).toBe(12);
		expect(
			fixtures.filter((e) => e.encodedLength <= 200 && e.cwdLength <= 200).length,
		).toBeGreaterThanOrEqual(7);
		for (const entry of fixtures) {
			// The name Claude really gave the project directory is the one the function must reproduce. The long-path
			// entries were shortened when the fixture was sanitized, so their recorded name no longer matches their
			// recorded path; the long-path rule is held by the computed vectors above instead.
			if (entry.encodedLength > 200 || entry.cwdLength > 200) continue;
			expect(encodeProjectDirName(entry.cwd)).toBe(entry.encodedDir);
			const dir = join(root, "projects", entry.encodedDir);
			mkdirSync(dir, { recursive: true });
			const id = entry.sessionId;
			writeFileSync(join(dir, `${id}.jsonl`), `${entry.head.join("\n")}\n`);
			const found = findSourceDirectory({ configDir: root, sessionId: id, candidate: entry.cwd });
			expect(found, entry.label).toMatchObject({ ok: true, dir: entry.cwd });
			rmSync(join(root, "projects"), { recursive: true });
		}
	});

	test("a recorded head whose project directory is renamed is rejected", () => {
		const entry = fixtures[0];
		const dir = join(root, "projects", "-not-the-encoding");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${entry.sessionId}.jsonl`), `${entry.head.join("\n")}\n`);
		expect(
			findSourceDirectory({ configDir: root, sessionId: entry.sessionId, candidate: entry.cwd }),
		).toEqual({ ok: false, kind: "rejected" });
	});
});

describe("every directory the session worked in (P5-X1)", () => {
	let root: string;
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "ap-src-cwds-")));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	const write = (lines: unknown[]) => {
		const file = join(root, "t.jsonl");
		writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		return file;
	};

	test("distinct top-level cwds in first-seen order; a nested value is not one", () => {
		const file = write([
			{ type: "user", cwd: "/a" },
			{ type: "user", cwd: "/a/b" },
			{ type: "user", cwd: "/a" },
			{ type: "x", nested: { cwd: "/evil" }, message: '"cwd":"/evil2"' },
		]);
		expect(scanAllCwds(file)).toEqual(["/a", "/a/b"]);
	});

	test("more distinct directories than the bound refuses; so does a missing file", () => {
		const lines = Array.from({ length: SCAN_MAX_CWDS + 1 }, (_, i) => ({
			type: "user",
			cwd: `/d/${i}`,
		}));
		expect(scanAllCwds(write(lines))).toBeNull();
		expect(scanAllCwds(join(root, "nope.jsonl"))).toBeNull();
	});

	test("findSourceDirectory hands every cwd to the caller", () => {
		const dir = join(root, "projects", encodeProjectDirName("/srv/work/a"));
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${S}.jsonl`),
			`${JSON.stringify({ type: "user", cwd: "/srv/work/a" })}\n${JSON.stringify({ type: "user", cwd: "/srv/secret" })}\n`,
		);
		expect(
			findSourceDirectory({ configDir: root, sessionId: S, candidate: "/srv/work/a" }),
		).toMatchObject({
			ok: true,
			cwds: ["/srv/work/a", "/srv/secret"],
		});
	});
});
