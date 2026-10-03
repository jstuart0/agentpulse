/**
 * Line endings and escaped characters that must not drift between the
 * installers that write the same hook files.
 *
 *  - `.gitattributes` forces LF for shell and PowerShell sources (a Windows
 *    checkout that turned them into CRLF would put a carriage return into
 *    the carried shell text and into every script an installer writes);
 *  - no tracked shell or PowerShell file holds a carriage return;
 *  - the PowerShell installer writes the hook files in the same escaped form
 *    as the other writers (ConvertTo-Json escapes `'`, `<`, `>` and `&` as
 *    \uXXXX and leaves other non-ASCII characters raw; the TypeScript and
 *    Python writers do the opposite, so the same hooks would compare as
 *    "changed" across installers and ask for approval again). The
 *    PowerShell is never executed here: its two patterns are read out of the
 *    source and applied in JavaScript to what ConvertTo-Json would produce.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCodexHooksFile, buildCopilotHooksFile } from "../src/shared/hook-command.js";

const ROOT = join(import.meta.dir, "..");
const PS1 = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");

describe(".gitattributes", () => {
	const readAttributes = (): string[] => {
		try {
			return readFileSync(join(ROOT, ".gitattributes"), "utf-8").split("\n");
		} catch {
			return [];
		}
	};

	test("forces LF for shell and PowerShell files", () => {
		const attributes = readAttributes();
		expect(attributes).toContain("*.sh text eol=lf");
		expect(attributes).toContain("*.ps1 text eol=lf");
	});

	test("no tracked shell or PowerShell file holds a carriage return", async () => {
		const proc = Bun.spawn(["git", "ls-files", "*.sh", "*.ps1"], {
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		const files = (await new Response(proc.stdout).text()).split("\n").filter(Boolean);
		await proc.exited;
		expect(files.length).toBeGreaterThan(3);
		const withCr = files.filter((f) => readFileSync(join(ROOT, f)).includes(0x0d));
		expect(withCr).toEqual([]);
	});
});

/** The two patterns ConvertTo-ApHooksJson applies, as written in install-local.ps1. */
function extractNormalisationPatterns(): { unescapeHtml: RegExp; escapeNonAscii: RegExp } {
	const fn = PS1.slice(
		PS1.indexOf("function ConvertTo-ApHooksJson"),
		PS1.indexOf("function New-ApCodexHooksFile"),
	);
	const patterns = [...fn.matchAll(/\[regex\]::Replace\(\$json, '([^']+)'/g)].map(
		(m) => m[1] as string,
	);
	expect(patterns, "two Replace calls").toHaveLength(2);
	return {
		unescapeHtml: new RegExp(patterns[0] as string, "gi"),
		escapeNonAscii: new RegExp(patterns[1] as string, "g"),
	};
}

/** What ConvertTo-Json emits for the same data: two-space indent, with ' < > & written as \uXXXX and other characters raw. */
function asConvertToJson(canonical: string): string {
	return canonical
		.replace(/\\u([0-9a-f]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(/'/g, "\\u0027")
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026");
}

function normalise(json: string): string {
	const { unescapeHtml, escapeNonAscii } = extractNormalisationPatterns();
	return json
		.replace(unescapeHtml, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
		.replace(escapeNonAscii, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

describe("install-local.ps1 writes hook JSON in the shared escaped form (PowerShell never executed)", () => {
	test("one function normalises ConvertTo-Json output, and both hook-file builders use it", () => {
		expect(PS1).toContain("function ConvertTo-ApHooksJson");
		const codex = PS1.slice(
			PS1.indexOf("function New-ApCodexHooksFile"),
			PS1.indexOf("function New-ApCopilotBashHookCommand"),
		);
		const copilot = PS1.slice(
			PS1.indexOf("function New-ApCopilotHooksFile"),
			PS1.indexOf("function Test-ApReparsePoint"),
		);
		for (const body of [codex, copilot]) {
			expect(body).toContain("ConvertTo-ApHooksJson");
			expect(body).not.toMatch(/\| ConvertTo-Json/);
		}
	});

	test("what ConvertTo-Json would write for the Codex and Copilot files normalises back to the generators' text byte for byte", () => {
		for (const direct of [false, true]) {
			const codex = buildCodexHooksFile({ baseUrl: "http://localhost:4000", direct });
			expect(`${normalise(asConvertToJson(codex).trimEnd())}\n`, `codex direct=${direct}`).toBe(
				codex,
			);
			const copilot = buildCopilotHooksFile({
				baseUrl: "http://localhost:4000",
				direct,
				includePowerShell: true,
			});
			expect(`${normalise(asConvertToJson(copilot).trimEnd())}\n`, `copilot direct=${direct}`).toBe(
				copilot,
			);
		}
	});

	test("a raw U+FEFF, a raw accented letter and a raw DEL come out as lowercase \\uXXXX, exactly like the other writers", () => {
		const raw = JSON.stringify({ c: "a﻿bé\u007fc'd" }, null, 2);
		const out = normalise(asConvertToJson(raw));
		expect(out).toContain("a\\ufeffb\\u00e9\\u007fc'd");
		expect(/[^\x20-\x7e\n]/.test(out)).toBe(false);
	});

	test("the ending newline is added once, after normalising", () => {
		const fn = PS1.slice(
			PS1.indexOf("function ConvertTo-ApHooksJson"),
			PS1.indexOf("function New-ApCodexHooksFile"),
		);
		expect(fn).toContain('return $json + "`n"');
	});
});
