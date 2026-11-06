/**
 * AGEN-117 drift guards that are cheap to hold in the unit suite (the verification section holds them as
 * `! grep` too):
 *  - AgentPulse never reads the value of a Claude login: no `process.env.ANTHROPIC_API_KEY`,
 *    `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` (under `process.env`, `Bun.env` or a copied `env`)
 *    and no `apiKeyHelper:` setting written, in any shipped file. The child inherits the login through the
 *    environment the person put in the supervisor's; it is never read, stored, forwarded or moved. Tests
 *    are exempt (the env-strip test must name the variables that survive).
 *  - The Claude Agent SDK is not a dependency of the app or the MCP package.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CREDENTIAL_READ =
	/(process\.env|Bun\.env|(^|[^A-Za-z0-9_.])env) *(\.|\[ *.)(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN)|apiKeyHelper"? *[:=]/;

function shipped(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
			out.push(...shipped(full));
		} else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
	}
	return out;
}

describe("AgentPulse never reads a credential's value", () => {
	test("no shipped file matches the credential-read pattern", () => {
		const offenders: string[] = [];
		for (const dir of ["src", "packages/agentpulse-mcp/src", "bin"]) {
			for (const file of shipped(join(ROOT, dir))) {
				const lines = readFileSync(file, "utf8").split("\n");
				lines.forEach((line, i) => {
					if (CREDENTIAL_READ.test(line)) offenders.push(`${file.slice(ROOT.length)}:${i + 1}`);
				});
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the pattern sees every way of reading one (so an empty scan above means something)", () => {
		for (const line of [
			"const t = process.env.CLAUDE_CODE_OAUTH_TOKEN;",
			'const t = process.env["ANTHROPIC_API_KEY"];',
			"const t = Bun.env.ANTHROPIC_AUTH_TOKEN;",
			"const { env } = process; env.ANTHROPIC_API_KEY;",
			'const settings = { apiKeyHelper: "x" };',
		]) {
			expect(CREDENTIAL_READ.test(line), line).toBe(true);
		}
		for (const line of [
			"// the child inherits CLAUDE_CODE_OAUTH_TOKEN through the environment",
			'"CLAUDE_CODE_OAUTH_TOKEN",',
			"describeLoginForLog(account)",
		]) {
			expect(CREDENTIAL_READ.test(line), line).toBe(false);
		}
	});
});

describe("no Claude Agent SDK", () => {
	test("is not in package.json, bun.lock or the MCP package", () => {
		for (const file of ["package.json", "bun.lock", "packages/agentpulse-mcp/package.json"]) {
			expect(readFileSync(join(ROOT, file), "utf8"), file).not.toContain("claude-agent-sdk");
		}
	});
});

describe("the keep-alive watchdog counts the forks (AGEN-117 T17)", () => {
	test("src/supervisor/index.ts hands the watchdog headlessRuntimeCount() + claudeStreamRuntimeCount()", () => {
		const text = readFileSync(join(ROOT, "src/supervisor/index.ts"), "utf8");
		expect(text).toMatch(/headlessRuntimeCount\(\)\s*\+\s*claudeStreamRuntimeCount\(\)/);
		expect(text).toMatch(/shouldExitOnStaleHeartbeat\(\{[\s\S]*?headless,/);
	});
});
