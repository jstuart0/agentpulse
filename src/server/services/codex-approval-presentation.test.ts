/**
 * What a person is shown for a Codex approval: built, redacted and hashed by the
 * server. Anything that had to change makes the request unapprovable, so what is
 * approved is exactly what was shown.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	CODEX_APPROVAL_LIMITS,
	COMMAND_APPROVAL_PARAMS,
	FILE_CHANGE_APPROVAL_PARAMS,
	NOT_APPROVABLE_REASONS,
	type NotApprovableReason,
} from "../../shared/codex-approvals.js";
import { commandReport, fileChangeReport } from "../test-utils/codex-approvals-harness.js";
import {
	buildPresentation,
	buildPreview,
	canonicalJson,
	changesOutsideCwd,
	hashPresentation,
} from "./codex-approval-presentation.js";

const SECRET = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BIDI = "‮evil";
const ZERO_WIDTH = "a​b";
const LINE_SEP = "line1 line2";
const KIB = 1024;

function reasonOf(report: Parameters<typeof buildPresentation>[0]): NotApprovableReason | null {
	return buildPresentation(report).notApprovableReason;
}

describe("approvable only when nothing changed", () => {
	test("a plain command and a plain file change are approvable", () => {
		expect(buildPresentation(commandReport())).toMatchObject({
			approvable: true,
			notApprovableReason: null,
		});
		expect(buildPresentation(fileChangeReport())).toMatchObject({
			approvable: true,
			notApprovableReason: null,
		});
	});

	test("each text field, run through secret, bidi, zero-width and U+2028 cases", () => {
		const cases: Array<[string, (value: string) => Parameters<typeof buildPresentation>[0]]> = [
			["command", (v) => commandReport({ command: `echo ${v}` })],
			["cwd", (v) => commandReport({ cwd: `/work/${v}` })],
			["reason", (v) => commandReport({ reason: `because ${v}` })],
			[
				"path",
				(v) =>
					fileChangeReport({
						changes: [{ path: `/work/${v}`, kind: "add", movePath: null, diff: "+x\n" }],
					}),
			],
			[
				"movePath",
				(v) =>
					fileChangeReport({
						changes: [{ path: "/work/a", kind: "update", movePath: `/work/${v}`, diff: "+x\n" }],
					}),
			],
			[
				"diff",
				(v) =>
					fileChangeReport({
						changes: [{ path: "/work/a", kind: "add", movePath: null, diff: `+${v}\n` }],
					}),
			],
		];
		for (const [field, make] of cases) {
			expect(reasonOf(make(SECRET)), `${field} secret`).toBe("redacted");
			expect(reasonOf(make(BIDI)), `${field} bidi`).toBe("invisible_chars");
			expect(reasonOf(make(ZERO_WIDTH)), `${field} zero-width`).toBe("invisible_chars");
			expect(reasonOf(make(LINE_SEP)), `${field} U+2028`).toBe("invisible_chars");
			expect(buildPresentation(make(SECRET)).approvable, `${field} approvable`).toBe(false);
		}
	});

	test("a carriage return is a change too (CRLF can't be shown as it would run)", () => {
		expect(reasonOf(commandReport({ command: "echo a\r\necho b" }))).toBe("invisible_chars");
	});

	test("the redacted text never contains the secret and the stored JSON holds only the cleaned text", () => {
		const built = buildPresentation(commandReport({ command: `echo ${SECRET}` }));
		expect(built.presentationJson).not.toContain(SECRET);
		expect(JSON.stringify(built)).not.toContain(SECRET);
	});
});

describe("bounds", () => {
	test("command: 4 KiB is the most that can be approved; up to 16 KiB is kept whole, past that cut", () => {
		const at = "x".repeat(CODEX_APPROVAL_LIMITS.approvableCommandChars);
		expect(CODEX_APPROVAL_LIMITS.approvableCommandChars).toBe(4 * KIB);
		expect(CODEX_APPROVAL_LIMITS.command).toBe(16 * KIB);
		expect(reasonOf(commandReport({ command: at }))).toBeNull();
		expect(reasonOf(commandReport({ command: `${at}x` }))).toBe("too_long");

		// Between 4 KiB and 16 KiB the whole command is stored and shown: not approvable, not cut.
		const midway = buildPresentation(commandReport({ command: "y".repeat(10 * KIB) }));
		expect(midway.notApprovableReason).toBe("too_long");
		if (midway.presentation.requestKind !== "command") throw new Error("kind");
		expect(midway.presentation.command?.length).toBe(10 * KIB);

		// At the hard cap nothing is cut; one more is cut, and loses the secret margin.
		const hard = "z".repeat(CODEX_APPROVAL_LIMITS.command);
		const kept = buildPresentation(commandReport({ command: hard }));
		if (kept.presentation.requestKind !== "command") throw new Error("kind");
		expect(kept.presentation.command?.length).toBe(CODEX_APPROVAL_LIMITS.command);
		const cut = buildPresentation(commandReport({ command: `${hard}z` }));
		if (cut.presentation.requestKind !== "command") throw new Error("kind");
		expect(cut.notApprovableReason).toBe("too_long");
		expect(cut.presentation.command?.length).toBe(
			CODEX_APPROVAL_LIMITS.command - CODEX_APPROVAL_LIMITS.secretCutMargin,
		);
	});

	test("files: 200 pass, 201 are too_long and only 200 are kept", () => {
		const make = (n: number) =>
			fileChangeReport({
				changes: Array.from({ length: n }, (_, i) => ({
					path: `/work/f${i}`,
					kind: "add",
					movePath: null,
					diff: "+x\n",
				})),
			});
		expect(reasonOf(make(200))).toBeNull();
		const over = buildPresentation(make(201));
		expect(over.notApprovableReason).toBe("too_long");
		if (over.presentation.requestKind !== "file_change") throw new Error("kind");
		expect(over.presentation.changes).toHaveLength(200);
	});

	test("total diff: 256 KiB across files passes, one more is too_long", () => {
		const half = "y".repeat(128 * KIB);
		const make = (extra: string) =>
			fileChangeReport({
				changes: [
					{ path: "/work/a", kind: "add", movePath: null, diff: half },
					{ path: "/work/b", kind: "add", movePath: null, diff: `${half}${extra}` },
				],
			});
		expect(reasonOf(make(""))).toBeNull();
		expect(reasonOf(make("y"))).toBe("too_long");
	});

	test("path: 1,024 passes, 1,025 is too_long", () => {
		const path = (n: number) => `/${"p".repeat(n - 1)}`;
		const make = (n: number) =>
			fileChangeReport({ changes: [{ path: path(n), kind: "add", movePath: null, diff: "+x\n" }] });
		expect(reasonOf(make(1024))).toBeNull();
		expect(reasonOf(make(1025))).toBe("too_long");
	});

	test("a secret straddling a cut: the tail left after the cut is removed too", () => {
		const secretTail = "TAILOFASECRET0123456789abcdefghijkl";
		const filler = "z".repeat(CODEX_APPROVAL_LIMITS.command - 20);
		const command = `${filler} sk-ant-api03-${"B".repeat(8)}${secretTail}`;
		const built = buildPresentation(commandReport({ command }));
		expect(built.approvable).toBe(false);
		if (built.presentation.requestKind !== "command") throw new Error("kind");
		const shown = built.presentation.command ?? "";
		expect(shown).not.toContain("sk-ant");
		expect(shown).not.toContain("TAILOFASECRET");
		// The cut removed a margin from the end on top of the 16 KiB cut.
		expect(shown.length).toBeLessThanOrEqual(
			CODEX_APPROVAL_LIMITS.command - CODEX_APPROVAL_LIMITS.secretCutMargin,
		);
	});

	test("a report the supervisor says it truncated is too_long and loses the margin", () => {
		const built = buildPresentation(commandReport({ command: "a".repeat(1000), truncated: true }));
		expect(built.notApprovableReason).toBe("too_long");
		if (built.presentation.requestKind !== "command") throw new Error("kind");
		expect(built.presentation.command?.length).toBe(1000 - CODEX_APPROVAL_LIMITS.secretCutMargin);
	});
});

describe("one test per reason", () => {
	const make: Record<NotApprovableReason, () => Parameters<typeof buildPresentation>[0]> = {
		redacted: () => commandReport({ command: `echo ${SECRET}` }),
		invisible_chars: () => commandReport({ command: `echo ${ZERO_WIDTH}` }),
		padded_text: () => commandReport({ command: `echo a${" ".repeat(41)}b` }),
		lookalike_text: () => commandReport({ command: "npm i l\u043edash" }),
		too_long: () => commandReport({ command: "x".repeat(CODEX_APPROVAL_LIMITS.command + 1) }),
		no_diff: () => fileChangeReport({ changes: [] }),
		no_command: () => commandReport({ command: null }),
		no_cwd: () => commandReport({ cwd: null }),
		write_stdin: () => commandReport({ declineOnly: ["write_stdin"] }),
		network: () => commandReport({ declineOnly: ["network"] }),
		grant_root: () => fileChangeReport({ grantRoot: "/work" }),
		unknown_param: () => commandReport({ declineOnly: ["unknown_param"] }),
		accept_not_offered: () => commandReport({ declineOnly: ["accept_not_offered"] }),
	};

	for (const reason of NOT_APPROVABLE_REASONS) {
		test(reason, () => {
			const built = buildPresentation(make[reason]());
			expect(built.approvable).toBe(false);
			expect(built.notApprovableReason).toBe(reason);
		});
	}

	test("the table covers every reason", () => {
		expect(Object.keys(make).sort()).toEqual([...NOT_APPROVABLE_REASONS].sort());
	});

	test("a blank command and an undefined command are no_command; a missing diff is no_diff", () => {
		expect(reasonOf(commandReport({ command: "   " }))).toBe("no_command");
		expect(reasonOf(commandReport({ command: undefined }))).toBe("no_command");
		expect(
			reasonOf(
				fileChangeReport({
					changes: [{ path: "/work/a", kind: "add", movePath: null, diff: null }],
				}),
			),
		).toBe("no_diff");
	});

	test("a file change needs no cwd of its own", () => {
		expect(reasonOf(fileChangeReport({ cwd: null }))).toBeNull();
	});

	test("an unknown reason from the host is ignored, not trusted into the row", () => {
		const built = buildPresentation(
			commandReport({ declineOnly: ["bogus" as NotApprovableReason] }),
		);
		expect(built.approvable).toBe(true);
	});

	test("when several apply, the one the host already knew comes first", () => {
		expect(reasonOf(commandReport({ command: `echo ${SECRET}`, declineOnly: ["network"] }))).toBe(
			"network",
		);
	});
});

// ── text that hides or imitates other text ──────────────────────────────────

const CYRILLIC_O = "\u043e";
const GREEK_OMICRON = "\u03bf";
const NBSP = "\u00a0";
const IDEOGRAPHIC_SPACE = "\u3000";
const BRAILLE_BLANK = "\u2800";
const FULLWIDTH_S = "\uff53";

function pathChange(path: string, movePath: string | null = null) {
	return fileChangeReport({
		changes: [{ path, kind: movePath ? "update" : "add", movePath, diff: "+x\n" }],
	});
}

describe("padding that pushes text out of sight", () => {
	test("a run of 40 spaces or tabs is approvable, 41 is padded_text", () => {
		for (const unit of [" ", "\t"]) {
			expect(reasonOf(commandReport({ command: `echo a${unit.repeat(40)}b` })), unit).toBeNull();
			expect(reasonOf(commandReport({ command: `echo a${unit.repeat(41)}b` })), unit).toBe(
				"padded_text",
			);
		}
		// Spaces and tabs together are one run.
		expect(reasonOf(commandReport({ command: `echo a${" ".repeat(20)}${"\t".repeat(21)}b` }))).toBe(
			"padded_text",
		);
		// Two runs of 40 with a character between them are two runs.
		expect(
			reasonOf(commandReport({ command: `echo a${" ".repeat(40)}x${" ".repeat(40)}b` })),
		).toBeNull();
	});

	test("10 blank lines in a row are approvable, 11 are padded_text", () => {
		expect(reasonOf(commandReport({ command: `echo a${"\n".repeat(11)}echo b` }))).toBeNull();
		expect(reasonOf(commandReport({ command: `echo a${"\n".repeat(12)}echo b` }))).toBe(
			"padded_text",
		);
		// A line of only spaces is blank too.
		expect(reasonOf(commandReport({ command: `echo a${"\n  ".repeat(12)}\necho b` }))).toBe(
			"padded_text",
		);
		// Blank lines split by a real line are separate runs.
		const split = `a${"\n".repeat(11)}b${"\n".repeat(11)}c`;
		expect(reasonOf(commandReport({ command: split }))).toBeNull();
	});

	test("the same rules hold for cwd and for every path", () => {
		const wide = " ".repeat(41);
		expect(reasonOf(commandReport({ cwd: `/work/a${wide}b` }))).toBe("padded_text");
		expect(reasonOf(commandReport({ cwd: `/work/a${" ".repeat(40)}b` }))).toBeNull();
		expect(reasonOf(pathChange(`/work/a${wide}b`))).toBe("padded_text");
		expect(reasonOf(pathChange("/work/a", `/work/b${wide}c`))).toBe("padded_text");
		expect(reasonOf(commandReport({ cwd: `/work${"\n".repeat(12)}x` }))).toBe("padded_text");
		expect(reasonOf(pathChange(`/work/a${"\n".repeat(12)}x`))).toBe("padded_text");
	});

	test("a diff is not a path: its own blank lines and indentation are fine", () => {
		const diff = `+a\n${"\n".repeat(20)}+${" ".repeat(60)}b\n`;
		expect(
			reasonOf(
				fileChangeReport({ changes: [{ path: "/work/a", kind: "add", movePath: null, diff }] }),
			),
		).toBeNull();
	});
});

describe("lookalike text", () => {
	test("a Cyrillic letter inside a Latin word is refused", () => {
		const command = `npm i l${CYRILLIC_O}dash`;
		expect(command).not.toBe("npm i lodash");
		expect(reasonOf(commandReport({ command }))).toBe("lookalike_text");
		expect(reasonOf(commandReport({ command: "npm i lodash" }))).toBeNull();
	});

	test("so are a Greek letter and a fullwidth form inside a Latin token", () => {
		expect(reasonOf(commandReport({ command: `npm i l${GREEK_OMICRON}dash` }))).toBe(
			"lookalike_text",
		);
		expect(reasonOf(commandReport({ command: `${FULLWIDTH_S}udo ls` }))).toBe("lookalike_text");
		expect(reasonOf(commandReport({ command: `ls${FULLWIDTH_S}` }))).toBe("lookalike_text");
	});

	test("a space that is not U+0020, a format character and the braille blank are refused", () => {
		for (const [name, ch] of [
			["no-break space", NBSP],
			["ideographic space", IDEOGRAPHIC_SPACE],
			["en quad", "\u2000"],
			["braille blank", BRAILLE_BLANK],
		] as const) {
			const reason = reasonOf(commandReport({ command: `rm${ch}-rf x` }));
			expect(reason, name).not.toBeNull();
			expect(buildPresentation(commandReport({ command: `rm${ch}-rf x` })).approvable, name).toBe(
				false,
			);
		}
		expect(reasonOf(commandReport({ command: `rm${BRAILLE_BLANK}-rf x` }))).toBe("lookalike_text");
		expect(reasonOf(commandReport({ command: `rm${IDEOGRAPHIC_SPACE}-rf x` }))).toBe(
			"lookalike_text",
		);
		// Format characters were already refused as invisible; they stay refused.
		expect(reasonOf(commandReport({ command: `echo ${ZERO_WIDTH}` }))).toBe("invisible_chars");
	});

	test("the same checks hold for cwd, a path and a move target", () => {
		expect(reasonOf(commandReport({ cwd: `/work/l${CYRILLIC_O}dash` }))).toBe("lookalike_text");
		expect(reasonOf(commandReport({ cwd: `/work${BRAILLE_BLANK}/x` }))).toBe("lookalike_text");
		expect(reasonOf(pathChange(`/work/l${CYRILLIC_O}dash/index.js`))).toBe("lookalike_text");
		expect(reasonOf(pathChange("/work/a", `/work/l${GREEK_OMICRON}dash`))).toBe("lookalike_text");
		expect(reasonOf(pathChange(`/work/a${NBSP}b`))).toBe("lookalike_text");
	});

	test("a path is judged by segment, a command by whitespace-separated token", () => {
		// Latin in one segment and Cyrillic in the next: two segments, each a single script.
		expect(reasonOf(pathChange("/work/project/\u043f\u0430\u043f\u043a\u0430/x.txt"))).toBeNull();
		// The same two scripts in one command token (a path as an argument) mix.
		expect(
			reasonOf(commandReport({ command: "cat /work/\u043f\u0430\u043f\u043a\u0430/x.txt" })),
		).toBe("lookalike_text");
		// In separate tokens they do not.
		expect(
			reasonOf(commandReport({ command: "echo \u043f\u0440\u0438\u0432\u0435\u0442" })),
		).toBeNull();
	});

	test("a wholly CJK path or command stays approvable, flagged nonAscii", () => {
		const cjkPath = pathChange("/work/\u9879\u76ee/\u6587\u4ef6.txt");
		const built = buildPresentation(cjkPath);
		expect(built).toMatchObject({ approvable: true, notApprovableReason: null });
		expect(buildPreview(built.presentation).nonAscii).toBe(true);

		const cjkCwd = buildPresentation(
			commandReport({ cwd: "/\u5de5\u4f5c/\u9879\u76ee", command: "echo \u4f60\u597d" }),
		);
		expect(cjkCwd).toMatchObject({ approvable: true, notApprovableReason: null });
		expect(buildPreview(cjkCwd.presentation).nonAscii).toBe(true);

		const japanese = buildPresentation(
			commandReport({ cwd: "/work/\u30c6\u30b9\u30c8", command: "cd \u30c6\u30b9\u30c8" }),
		);
		expect(japanese.approvable).toBe(true);
		// Fullwidth punctuation next to CJK text is not a Latin lookalike.
		expect(
			buildPresentation(commandReport({ command: "echo \u4f60\u597d\uff0c\u4e16\u754c" }))
				.approvable,
		).toBe(true);
	});
});

describe("every field of the presentation is in the hash", () => {
	const base = () =>
		fileChangeReport({
			cwd: "/work/project",
			reason: "why",
			grantRoot: null,
			changes: [
				{
					path: "/work/project/a.txt",
					kind: "update",
					movePath: "/work/project/b.txt",
					diff: "+a\n",
				},
				{ path: "/work/project/c.txt", kind: "add", movePath: null, diff: "+c\n" },
			],
		});
	const hashOf = (report: Parameters<typeof buildPresentation>[0]) =>
		buildPresentation(report).hash;
	const [first, second] = base().changes ?? [];
	if (!first || !second) throw new Error("fixture");

	test("each variation gives a different hash from the base, and from every other", () => {
		const variants: Record<string, Parameters<typeof buildPresentation>[0]> = {
			base: base(),
			cwd: { ...base(), cwd: "/work/other" },
			reason: { ...base(), reason: "different" },
			grantRoot: { ...base(), grantRoot: "/work" },
			path: { ...base(), changes: [{ ...first, path: "/work/project/z.txt" }, second] },
			kind: { ...base(), changes: [{ ...first, kind: "delete" }, second] },
			movePath: { ...base(), changes: [{ ...first, movePath: "/work/project/z.txt" }, second] },
			noMovePath: { ...base(), changes: [{ ...first, movePath: null }, second] },
			diff: { ...base(), changes: [{ ...first, diff: "+b\n" }, second] },
			order: { ...base(), changes: [second, first] },
			fewer: { ...base(), changes: [first] },
			more: { ...base(), changes: [first, second, { ...second, path: "/work/project/d.txt" }] },
			requestKind: commandReport({ cwd: "/work/project", reason: "why", command: "x" }),
		};
		const hashes = Object.entries(variants).map(
			([name, report]) => [name, hashOf(report)] as const,
		);
		expect(hashes.length).toBeGreaterThanOrEqual(13);
		const distinct = new Set(hashes.map(([, hash]) => hash));
		expect(distinct.size).toBe(hashes.length);
		// Positive control: the same report twice is the same hash, so a difference above is a real one.
		expect(hashOf(base())).toBe(hashOf(base()));
	});

	test("a command's hash covers its command, cwd, reason and grantRoot", () => {
		const hash = (o: Parameters<typeof commandReport>[0]) => hashOf(commandReport(o));
		const hashes = [
			hash({}),
			hash({ command: "npm run x" }),
			hash({ cwd: "/work/other" }),
			hash({ reason: "r" }),
			hash({ grantRoot: "/work" }),
		];
		expect(new Set(hashes).size).toBe(hashes.length);
	});
});

describe("the hash", () => {
	test("stable across key order, and one changed character changes it", () => {
		const a = buildPresentation(commandReport({ command: "npm test" }));
		const reordered = canonicalJson({
			cwd: a.presentation.cwd,
			command: "npm test",
			v: 1,
			requestKind: "command",
			reason: null,
			grantRoot: null,
		});
		expect(reordered).toBe(a.presentationJson);
		expect(buildPresentation(commandReport({ command: "npm tesT" })).hash).not.toBe(a.hash);
		expect(buildPresentation(commandReport({ command: "npm test" })).hash).toBe(a.hash);
		expect(hashPresentation(a.presentation)).toBe(a.hash);
	});

	test("the reason is part of the hash", () => {
		const a = buildPresentation(commandReport({ reason: "one" }));
		const b = buildPresentation(commandReport({ reason: "two" }));
		expect(a.hash).not.toBe(b.hash);
	});

	test("canonicalJson sorts keys at every depth", () => {
		expect(canonicalJson({ b: [{ z: 1, a: 2 }], a: null })).toBe('{"a":null,"b":[{"a":2,"z":1}]}');
	});
});

describe("the preview", () => {
	test("is bounded to 4 KiB and keeps the tail of a long command", () => {
		const command = `${"head ".repeat(2000)}\nlast line`;
		const built = buildPresentation(
			commandReport({ command: command.slice(0, CODEX_APPROVAL_LIMITS.command) }),
		);
		const preview = buildPreview(built.presentation);
		expect(JSON.stringify(preview).length).toBeLessThan(CODEX_APPROVAL_LIMITS.previewBytes);
		expect(preview.commandHead?.length).toBeLessThanOrEqual(1200);
		expect(preview.lastLines?.length).toBeLessThanOrEqual(1200);
	});

	test("a file change lists the first five paths and flags one outside the working directory", () => {
		const changes = Array.from({ length: 8 }, (_, i) => ({
			path: `/work/project/f${i}`,
			kind: "add",
			movePath: null,
			diff: "+x\n",
		}));
		const inside = buildPreview(buildPresentation(fileChangeReport({ changes })).presentation);
		expect(inside).toMatchObject({ fileCount: 8, pathOutsideCwd: false });
		expect(inside.paths).toHaveLength(5);
		const outside = buildPreview(
			buildPresentation(
				fileChangeReport({
					changes: [
						{ path: "/work/project/../other/x", kind: "add", movePath: null, diff: "+x\n" },
					],
				}),
			).presentation,
		);
		expect(outside.pathOutsideCwd).toBe(true);
		const elsewhere = buildPreview(
			buildPresentation(
				fileChangeReport({
					changes: [{ path: "/etc/passwd", kind: "update", movePath: null, diff: "+x\n" }],
				}),
			).presentation,
		);
		expect(elsewhere.pathOutsideCwd).toBe(true);
	});

	test("each changed file is flagged on its own, a move target counts, and the flags are not in the presentation", () => {
		const built = buildPresentation(
			fileChangeReport({
				changes: [
					{ path: "/work/project/a.txt", kind: "add", movePath: null, diff: "+x\n" },
					{ path: "/etc/passwd", kind: "update", movePath: null, diff: "+x\n" },
					{ path: "/work/project/b.txt", kind: "update", movePath: "/tmp/b.txt", diff: "+x\n" },
				],
			}),
		).presentation;
		if (built.requestKind !== "file_change") throw new Error("kind");
		expect(changesOutsideCwd(built)).toEqual([false, true, true]);
		expect(canonicalJson(built)).not.toContain("outsideCwd");
	});

	test("a home shortcut and a backslash path are never inside the working directory", () => {
		const outside = (path: string, cwd = "/work/project") =>
			buildPreview(
				buildPresentation(
					fileChangeReport({ cwd, changes: [{ path, kind: "add", movePath: null, diff: "+x\n" }] }),
				).presentation,
			).pathOutsideCwd;
		expect(outside("a/b.txt")).toBe(false);
		expect(outside("/work/project/a.txt")).toBe(false);
		expect(outside("~/a.txt")).toBe(true);
		expect(outside("~")).toBe(true);
		expect(outside("a\\b.txt")).toBe(true);
		expect(outside("..\\x")).toBe(true);
		expect(outside("C:\\work\\project\\a.txt")).toBe(true);
		expect(outside("/work/project/a.txt", "~/project")).toBe(true);
		// A move target is judged too.
		const moved = buildPreview(
			buildPresentation(
				fileChangeReport({
					changes: [{ path: "/work/project/a", kind: "update", movePath: "~/b", diff: "+x\n" }],
				}),
			).presentation,
		);
		expect(moved.pathOutsideCwd).toBe(true);
	});

	test("non-English letters are flagged", () => {
		expect(
			buildPreview(buildPresentation(commandReport({ command: "echo привет" })).presentation)
				.nonAscii,
		).toBe(true);
		expect(
			buildPreview(buildPresentation(commandReport({ command: "echo hi" })).presentation).nonAscii,
		).toBe(false);
	});
});

describe("the parameter allowlist (D5)", () => {
	const FIXTURES = join(import.meta.dir, "../../supervisor/providers/__fixtures__/codex-0.163");

	function schemaProperties(file: string): string[] {
		const schema = JSON.parse(readFileSync(join(FIXTURES, "schema", file), "utf8")) as {
			properties: Record<string, unknown>;
		};
		return Object.keys(schema.properties).sort();
	}

	test("equals the committed experimental schema's properties for the two request types", () => {
		const commandKeys = schemaProperties("CommandExecutionRequestApprovalParams.json");
		const fileKeys = schemaProperties("FileChangeRequestApprovalParams.json");
		expect(commandKeys.length).toBeGreaterThanOrEqual(10);
		expect(commandKeys).toContain("cwd");
		expect(Object.keys(COMMAND_APPROVAL_PARAMS).sort()).toEqual(commandKeys);
		expect(Object.keys(FILE_CHANGE_APPROVAL_PARAMS).sort()).toEqual(fileKeys);
	});

	test("every key a recorded request carried is in it", () => {
		let scanned = 0;
		for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith(".jsonl"))) {
			for (const line of readFileSync(join(FIXTURES, file), "utf8").split("\n")) {
				if (!line.trim()) continue;
				const entry = JSON.parse(line) as {
					frame?: { method?: string; params?: Record<string, unknown> };
				};
				const method = entry.frame?.method;
				if (method === "item/commandExecution/requestApproval") {
					scanned++;
					for (const key of Object.keys(entry.frame?.params ?? {}))
						expect(COMMAND_APPROVAL_PARAMS).toHaveProperty(key);
				}
				if (method === "item/fileChange/requestApproval") {
					scanned++;
					for (const key of Object.keys(entry.frame?.params ?? {}))
						expect(FILE_CHANGE_APPROVAL_PARAMS).toHaveProperty(key);
				}
			}
		}
		expect(scanned).toBeGreaterThanOrEqual(4);
	});
});
