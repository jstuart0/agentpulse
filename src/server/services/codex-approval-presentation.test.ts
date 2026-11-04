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
	test("command: 16 KiB passes, one more is too_long", () => {
		const at = "x".repeat(CODEX_APPROVAL_LIMITS.command);
		expect(reasonOf(commandReport({ command: at }))).toBeNull();
		expect(reasonOf(commandReport({ command: `${at}x` }))).toBe("too_long");
		expect(CODEX_APPROVAL_LIMITS.command).toBe(16 * KIB);
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
