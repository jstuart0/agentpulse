/**
 * AGEN-141 Phase 3 review fixes that don't belong to one installer site: the /setup.sh key-file guard (M1), the
 * backup mover (L4), and the PowerShell step, which can't run here and is read as text (L2, L3, L4, L5).
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveToBackups } from "../src/shared/opencode-install.ts";
import { pathWithout, renderedSetupSh } from "./lib/installer-test-utils.ts";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "ap-oc-hardening-"));
const GOOD_HEADER = "Authorization: Bearer ap_existing_key\n";

describe("M1: an install with no key never overwrites the hook-auth-header file", () => {
	test("/setup.sh with OpenCode present and no key leaves a good header alone and still installs the exclude script", async () => {
		const root = join(scratch, "m1");
		const home = join(root, "home");
		const bin = join(root, "bin");
		const agentpulse = join(home, ".agentpulse");
		mkdirSync(join(root, "xdg", "opencode"), { recursive: true });
		mkdirSync(agentpulse, { recursive: true, mode: 0o700 });
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(agentpulse, "hook-auth-header"), GOOD_HEADER, { mode: 0o600 });
		const script = await renderedSetupSh();
		const proc = Bun.spawn(
			["bash", "-s", "--", "--url", "http://localhost:3000", "--no-auth-check"],
			{
				cwd: ROOT,
				env: {
					HOME: home,
					XDG_CONFIG_HOME: join(root, "xdg"),
					XDG_DATA_HOME: join(root, "xdg-data"),
					XDG_STATE_HOME: join(root, "xdg-state"),
					XDG_CACHE_HOME: join(root, "xdg-cache"),
					TMPDIR: root,
					PATH: `${bin}:${pathWithout(["opencode"], undefined, root)}`,
					AGENTPULSE_KEY: "",
				},
				stdin: new TextEncoder().encode(script),
				stdout: "pipe",
				stderr: "pipe",
				timeout: 50_000,
				killSignal: "SIGKILL",
			},
		);
		const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
		await proc.exited;
		expect(out).toContain("OpenCode plugin");
		expect(readFileSync(join(agentpulse, "hook-auth-header"), "utf8")).toBe(GOOD_HEADER);
		expect(existsSync(join(agentpulse, "exclude-check.sh"))).toBe(true);
	});

	test("setup-hooks.sh guards both of its OpenCode header writes with a non-empty key", () => {
		const text = readFileSync(join(ROOT, "scripts/setup-hooks.sh"), "utf8");
		const writes = text.match(
			/ap_write_private_no_follow "[^"]*hook-auth-header|ap_write_private_no_follow "\$AP_AUTH_HEADER_FILE"/g,
		);
		expect(writes?.length).toBeGreaterThanOrEqual(2);
		for (const m of text.matchAll(
			/ap_write_private_no_follow "\$HOME\/\.agentpulse\/hook-auth-header"[^\n]*/g,
		)) {
			const before = text.slice(Math.max(0, (m.index ?? 0) - 260), m.index);
			expect(before).toContain('[[ -n "$AGENTPULSE_KEY" ]]');
		}
	});
});

describe("L4: moveToBackups", () => {
	test("a second backup of the same name and stamp gets its own name, for a file and for a folder", () => {
		const root = mkdtempSync(join(scratch, "mv-"));
		const backups = join(root, "backups");
		const make = (name: string, body: string) => {
			writeFileSync(join(root, name), body);
			return join(root, name);
		};
		const a = moveToBackups(make("x", "one"), backups, "S");
		const b = moveToBackups(make("x", "two"), backups, "S");
		expect(a).not.toBe(b);
		expect(readFileSync(a, "utf8")).toBe("one");
		expect(readFileSync(b, "utf8")).toBe("two");
		mkdirSync(join(root, "d"));
		writeFileSync(join(root, "d", "f"), "in dir");
		const c = moveToBackups(join(root, "d"), backups, "S");
		mkdirSync(join(root, "d"));
		const d = moveToBackups(join(root, "d"), backups, "S");
		expect(new Set([a, b, c, d]).size).toBe(4);
		expect(readFileSync(join(c, "f"), "utf8")).toBe("in dir");
	});

	test("EXDEV from rename falls back to copy and remove; any other error is thrown", () => {
		const root = mkdtempSync(join(scratch, "xdev-"));
		const backups = join(root, "backups");
		writeFileSync(join(root, "f"), "file");
		mkdirSync(join(root, "d"));
		writeFileSync(join(root, "d", "inner"), "inner");
		const exdev = () => {
			throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
		};
		const f = moveToBackups(join(root, "f"), backups, "S", exdev);
		const d = moveToBackups(join(root, "d"), backups, "S", exdev);
		expect(readFileSync(f, "utf8")).toBe("file");
		expect(readFileSync(join(d, "inner"), "utf8")).toBe("inner");
		expect(existsSync(join(root, "f"))).toBe(false);
		expect(existsSync(join(root, "d"))).toBe(false);
		writeFileSync(join(root, "g"), "g");
		const eperm = () => {
			throw Object.assign(new Error("nope"), { code: "EPERM" });
		};
		expect(() => moveToBackups(join(root, "g"), backups, "S", eperm)).toThrow("nope");
		expect(readFileSync(join(root, "g"), "utf8")).toBe("g");
		expect(readdirSync(backups)).toHaveLength(2);
		chmodSync(backups, 0o700);
	});
});

describe("PowerShell OpenCode step (read as text: pwsh is not available here, and it has never run on Windows)", () => {
	const template = readFileSync(join(ROOT, "scripts/opencode-installer/install.ps1"), "utf8");
	const embedded = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf8");
	const install = (text: string) => text.slice(text.indexOf("function Install-ApOpenCode"));

	for (const [name, text] of [
		["template", template],
		["install-local.ps1", embedded],
	] as const) {
		describe(name, () => {
			const fn = install(text);
			test("L2: the base URL check ends at \\z and rejects quote, backslash, @@ and line breaks by name", () => {
				const line = fn.split("\n").find((l) => l.includes("-notmatch '^https?://"));
				expect(line).toBeDefined();
				expect(line).toContain("\\z'");
				expect(line).not.toMatch(/\)\?\$'/);
				expect(line).toContain(`-match '["\\\\\\r\\n]'`);
				expect(line).toContain(".Contains('@@')");
			});
			test("L3: the link pre-check covers every entry (flat files too), and the work is inside a try that reports and returns false", () => {
				expect(fn).toMatch(
					/\$script:ApOcEntries \| ForEach-Object \{ Join-Path \$plugins \$_\.Name \}/,
				);
				expect(fn).not.toMatch(/Where-Object \{ \$_\.Kind -eq 'dir' \}/);
				expect(fn).not.toContain("Nothing was written or removed");
				const tryAt = fn.indexOf("  try {");
				const catchAt = fn.indexOf("  } catch {");
				expect(tryAt).toBeGreaterThan(fn.indexOf("Test-ApOcLink -Path $p"));
				expect(catchAt).toBeGreaterThan(fn.indexOf("Write-ApOcEntry -Plugins"));
				expect(fn.slice(catchAt)).toContain("return $false");
			});
			test("L4: a backup never reuses a name", () => {
				const mover = text.slice(
					text.indexOf("function Move-ApOcToBackups"),
					text.indexOf("function Remove-ApOcOurs"),
				);
				expect(mover).toMatch(/while \(Test-Path -LiteralPath \$to\)/);
			});
			test("L5: a config folder that is empty or a bare drive is refused before anything else", () => {
				const refuse = fn.indexOf("refusing to use a drive or filesystem root");
				expect(refuse).toBeGreaterThan(0);
				expect(refuse).toBeLessThan(fn.indexOf("Test-ApOcDetected"));
			});
		});
	}
});
