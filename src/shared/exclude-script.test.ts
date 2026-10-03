/**
 * The installed PowerShell twin, `~/.agentpulse/exclude-check.ps1`: installed and
 * inspected by the same functions as the shell check (a `kind` argument picks the
 * file). Windows PowerShell 5.1 writes a byte order mark when asked for UTF-8,
 * which would make the installed text differ from the generator's, so nothing
 * here may write one. These run on any host; the Windows runs of the PowerShell
 * script itself are separate and never executed here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectExcludeScript, installExcludeScript } from "./exclude-script.js";
import { buildBashExcludeScript, buildPowerShellExcludeScript } from "./hook-command.js";

const made: string[] = [];
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function newHome(): string {
	const home = mkdtempSync(join(tmpdir(), "ap-exclude-script-"));
	made.push(home);
	return home;
}

describe("the PowerShell check, installed next to the shell one", () => {
	test("is written byte for byte as generated, with no byte order mark, next to (not over) the shell check", () => {
		const home = newHome();
		const result = installExcludeScript(home, buildPowerShellExcludeScript(), "ps1");
		expect(result.status).toBe("installed");
		const file = join(home, ".agentpulse", "exclude-check.ps1");
		const bytes = readFileSync(file);
		expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
		expect(bytes.toString("utf-8")).toBe(buildPowerShellExcludeScript());
		expect(installExcludeScript(home).status).toBe("installed");
		expect(readFileSync(join(home, ".agentpulse", "exclude-check.sh"), "utf-8")).toBe(
			buildBashExcludeScript(),
		);
		expect(readFileSync(file, "utf-8")).toBe(buildPowerShellExcludeScript());
	});

	test("inspect says missing, current, stale and untrusted for the .ps1 independently of the .sh", () => {
		const home = newHome();
		expect(inspectExcludeScript(home, undefined, "ps1").state).toBe("missing");
		installExcludeScript(home);
		expect(inspectExcludeScript(home).state).toBe("current");
		expect(inspectExcludeScript(home, undefined, "ps1").state).toBe("missing");
		installExcludeScript(home, undefined, "ps1");
		expect(inspectExcludeScript(home, undefined, "ps1").state).toBe("current");
		const file = join(home, ".agentpulse", "exclude-check.ps1");
		chmodSync(file, 0o600);
		writeFileSync(file, "# agentpulse-exclude-check 00000000000000\nexit 0\n");
		chmodSync(file, 0o500);
		expect(inspectExcludeScript(home, undefined, "ps1").state).toBe("stale");
		expect(inspectExcludeScript(home).state).toBe("current");
		chmodSync(file, 0o777);
		expect(inspectExcludeScript(home, undefined, "ps1").state).toBe("untrusted");
	});

	test("a refusal for the .ps1 names the .ps1 path", () => {
		const home = newHome();
		mkdirSync(join(home, ".agentpulse", "exclude-check.ps1"), { recursive: true });
		const result = installExcludeScript(home, undefined, "ps1");
		expect(result.status).toBe("skipped");
		expect(result.path).toBe(join(home, ".agentpulse", "exclude-check.ps1"));
	});
});
