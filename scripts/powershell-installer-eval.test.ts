/**
 * scripts/powershell-installer-eval.ts runs the few statements the hook-command
 * builders in scripts/install-local.ps1 are made of, so a parity test can compare
 * what they build with the generator's text without a PowerShell host (none runs
 * here: everything below is by reading, never executed on Windows). Its safety
 * is in what it REFUSES: a construct it does not model the way PowerShell does
 * must make it THROW, never silently produce a different string, or a future
 * edit to the builders could pass the parity test by accident.
 */
import { describe, expect, test } from "bun:test";
import { evalExpr, runPsBuilder } from "./powershell-installer-eval.ts";

const run = (statement: string, scope: Record<string, string | boolean> = {}) =>
	runPsBuilder(`  ${statement}\n  return $x\n`, scope);

describe("the PowerShell evaluator: what it models (never executed)", () => {
	test("double-quoted interpolation of a string variable and of a script-scoped one", () => {
		expect(run('$x = "a $Name b"', { Name: "N" }).x).toBe("a N b");
		expect(run('$x = "a $script:Piece b"', { "script:Piece": "P" }).x).toBe("a P b");
	});

	test("single-quoted strings, concatenation, the backtick escapes", () => {
		expect(run("$x = 'a' + 'b'").x).toBe("ab");
		expect(run('$x = "line`nnext`t`""').x).toBe('line\nnext\t"');
		expect(evalExpr("'it''s'", {})).toBe("it's");
	});
});

describe("the PowerShell evaluator refuses what it does not model like PowerShell does (never executed)", () => {
	test("a subexpression $( ) inside a double-quoted string", () => {
		expect(() => run('$x = "a $(Get-Date) b"')).toThrow(/subexpression/i);
		expect(() => run('$x = "a $(1 + 1) b"', {})).toThrow(/subexpression/i);
	});

	test("doubled quotes inside a double-quoted string (PowerShell reads them as one literal quote)", () => {
		expect(() => run('$x = "say ""hi"""')).toThrow(/doubled/i);
	});

	test("a variable followed by a colon that is not the script: scope ($env:X, $global:X, $var: )", () => {
		expect(() => run('$x = "$env:TEMP\\x"')).toThrow(/scope|colon/i);
		expect(() => run('$x = "$global:Y"', { global: "g" })).toThrow(/scope|colon/i);
		expect(() => run('$x = "$Name: text"', { Name: "N" })).toThrow(/scope|colon/i);
	});

	test("a braced variable ${name}", () => {
		expect(() => run('$x = "${Name}"', { Name: "N" })).toThrow(/braced/i);
	});

	test("a boolean interpolated into a string (PowerShell prints True/False, the evaluator would print true/false)", () => {
		expect(() => run('$x = "flag=$Direct"', { Direct: true })).toThrow(/boolean/i);
		expect(() => run('$x = "flag=$script:Flag"', { "script:Flag": false })).toThrow(/boolean/i);
	});

	test("array, format, call and operator expressions", () => {
		for (const statement of [
			"$x = @('a','b')",
			'$x = "{0}" -f $Name',
			"$x = Get-Date",
			"$x = $Name.ToUpper()",
			"$x = $Name -replace 'a','b'",
			"$x = [guid]::NewGuid()",
		]) {
			expect(() => run(statement, { Name: "n" }), statement).toThrow(
				/outside the evaluator's subset/,
			);
		}
	});

	test("a here-string is not a string literal", () => {
		expect(() => run('$x = @"\nbody\n"@')).toThrow();
	});
});

describe("the base-URL validation the evaluator skips is checked, not trusted (never executed)", () => {
	const VALIDATION = `  if ($BaseUrl -notmatch '^https?://([A-Za-z0-9.-]+|\\[[0-9A-Fa-f:]+\\])(:[0-9]{1,5})?$') {
    throw "invalid AgentPulse base URL for a hook command: $BaseUrl"
  }
`;
	const BODY = `  $x = "u=$BaseUrl"\n  return $x\n`;

	test("the known validation is skipped, as before", () => {
		expect(runPsBuilder(`${VALIDATION}${BODY}`, { BaseUrl: "http://localhost:4000" }).x).toBe(
			"u=http://localhost:4000",
		);
	});

	test("a validation whose pattern differs from the generator's is refused", () => {
		const changed = VALIDATION.replace("[A-Za-z0-9.-]+", "[A-Za-z0-9.-]*");
		expect(() => runPsBuilder(`${changed}${BODY}`, { BaseUrl: "http://localhost" })).toThrow(
			/validation/i,
		);
	});

	test("a validation that no longer throws is refused", () => {
		const weakened = VALIDATION.replace(/throw "[^"]*"/, "Write-Host x");
		expect(() => runPsBuilder(`${weakened}${BODY}`, { BaseUrl: "http://localhost" })).toThrow(
			/validation/i,
		);
	});

	test("a different -notmatch check is outside the subset", () => {
		const other = `  if ($Other -notmatch 'x') {\n    throw "y"\n  }\n`;
		expect(() => runPsBuilder(`${other}${BODY}`, { BaseUrl: "u", Other: "o" })).toThrow(
			/outside the evaluator's subset/,
		);
	});
});
