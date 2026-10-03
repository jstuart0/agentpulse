/**
 * F194: checkNoPlainRelayModuleImport (scripts/check-installers.ts) must
 * catch a plain relay.ts import missing its "?module" suffix even when the
 * import is extensionless, written as require(), or sitting in bin/ or a
 * workspace package's src/ — not just an exact "relay.ts"/"relay.js" import
 * under scripts/ or src/.
 *
 * The function scans the real repo tree (ROOT = repo root), so each case
 * plants a throwaway offending file, asserts, then removes it — never left
 * behind, never committed. The offending fixture text is assembled at
 * runtime from REL ("re" + "lay") rather than spelled out directly: this
 * file itself lives under scripts/**\/*.ts, one of the scanned globs, so a
 * literal offending import string in its own source would make the checker
 * flag *this file*.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	checkNoPlainRelayModuleImport,
	mustInclude,
	scanPathForPlainRelayImport,
} from "./check-installers.js";

const ROOT = join(import.meta.dir, "..");
const REL = "re" + "lay";
const planted: string[] = [];

async function plant(relPath: string, content: string) {
	const abs = join(ROOT, relPath);
	await mkdir(join(abs, ".."), { recursive: true });
	await writeFile(abs, content);
	planted.push(abs);
}

afterEach(async () => {
	while (planted.length) await rm(planted.pop() as string, { force: true });
});

// A full-repo glob scan under host contention can outrun bun's default 5s
// per-test timeout (AGEN-18); every test below that calls
// checkNoPlainRelayModuleImport gets an explicit, generous one.
const SCAN_TIMEOUT_MS = 20_000;

test(
	"the real repo tree passes as-is",
	async () => {
		await expect(checkNoPlainRelayModuleImport()).resolves.toBeUndefined();
	},
	SCAN_TIMEOUT_MS,
);

describe("catches a plain import missing '?module', wherever it appears", () => {
	// Descriptions avoid spelling out the offending syntax too: this test
	// file is itself under scripts/**/*.ts, one of the scanned globs.
	test(
		"an import with no file extension at all",
		async () => {
			await plant("scripts/__f194_offender_extensionless.ts", `import x from "./${REL}";\n`);
			await expect(checkNoPlainRelayModuleImport()).rejects.toThrow(/relay\.ts\?module/);
		},
		SCAN_TIMEOUT_MS,
	);

	test(
		"a CommonJS-style module load with an extension",
		async () => {
			await plant("src/__f194_offender_require.ts", `const x = require("../scripts/${REL}.ts");\n`);
			await expect(checkNoPlainRelayModuleImport()).rejects.toThrow(/relay\.ts\?module/);
		},
		SCAN_TIMEOUT_MS,
	);

	test(
		"a CommonJS-style module load with no extension",
		async () => {
			await plant("bin/__f194_offender_require_ext.ts", `const x = require("./${REL}");\n`);
			await expect(checkNoPlainRelayModuleImport()).rejects.toThrow(/relay\.ts\?module/);
		},
		SCAN_TIMEOUT_MS,
	);

	test(
		"bin/ is scanned",
		async () => {
			await plant("bin/__f194_offender.ts", `import x from "./${REL}.ts";\n`);
			await expect(checkNoPlainRelayModuleImport()).rejects.toThrow(/relay\.ts\?module/);
		},
		SCAN_TIMEOUT_MS,
	);

	test(
		"a workspace package's src/ is scanned",
		async () => {
			await plant(
				"packages/agentpulse-mcp/src/__f194_offender.ts",
				`import x from "./${REL}.js";\n`,
			);
			await expect(checkNoPlainRelayModuleImport()).rejects.toThrow(/relay\.ts\?module/);
		},
		SCAN_TIMEOUT_MS,
	);
});

describe("F196: the PUBLIC_URL placeholder literals are pinned", () => {
	// setup.ts's `.replace('PUBLIC_URL=""', ...)` is a silent no-op on a
	// drifted placeholder — no exception, no served URL either — so main()
	// pins the exact literal with mustInclude. Exercised here two ways:
	// mustInclude's own pass/fail behavior against a throwaway fixture (never
	// touches the real, tracked install-local.sh/.ps1), and a static check
	// that main() actually calls it with these two exact strings.
	test("mustInclude resolves when the expected text is present", async () => {
		const path = join(ROOT, "scripts", "__f196_fixture_present.txt");
		await writeFile(path, 'before PUBLIC_URL="" after\n');
		planted.push(path);
		await expect(
			mustInclude("scripts/__f196_fixture_present.txt", 'PUBLIC_URL=""'),
		).resolves.toBeUndefined();
	});

	test("mustInclude rejects when the expected text is missing (drift is caught, not silently ignored)", async () => {
		const path = join(ROOT, "scripts", "__f196_fixture_drifted.txt");
		await writeFile(path, "before PUBLIC_URL='' after\n");
		planted.push(path);
		await expect(
			mustInclude("scripts/__f196_fixture_drifted.txt", 'PUBLIC_URL=""'),
		).rejects.toThrow(/missing expected content/);
	});

	test("main() is wired to pin both real placeholders", async () => {
		const source = await readFile(join(ROOT, "scripts", "check-installers.ts"), "utf8");
		expect(source).toContain(`mustInclude("scripts/install-local.sh", 'PUBLIC_URL=""')`);
		expect(source).toContain(`mustInclude("scripts/install-local.ps1", '[string]$PublicUrl = ""')`);
	});
});

describe("F206: a path that disappears between listing and reading doesn't crash the scan", () => {
	test("a nonexistent path is skipped, not thrown (ENOENT from a raced concurrent scan)", async () => {
		const offenders: string[] = [];
		await expect(
			scanPathForPlainRelayImport("scripts/__f206_never_existed.ts", offenders),
		).resolves.toBeUndefined();
		expect(offenders).toEqual([]);
	});

	test("a real, still-present offender is still caught (ENOENT-only skip, not silent-everything)", async () => {
		await plant("scripts/__f206_real_offender.ts", `import x from "./${REL}";\n`);
		const offenders: string[] = [];
		await scanPathForPlainRelayImport("scripts/__f206_real_offender.ts", offenders);
		expect(offenders).toEqual([`scripts/__f206_real_offender.ts:1: import x from "./${REL}";`]);
	});

	test("a non-ENOENT read failure still throws (a real permissions/corruption problem isn't swallowed)", async () => {
		// "scripts" is a real directory, not a file — readFile on it throws
		// EISDIR, not ENOENT, and must still propagate.
		await expect(scanPathForPlainRelayImport("scripts", [])).rejects.toThrow();
	});
});

describe("does not false-positive", () => {
	test(
		"an unrelated identifier sharing the 'relay' prefix",
		async () => {
			await plant("scripts/__f194_ok_prefix.ts", 'import { relayEvent } from "./relayEvent.js";\n');
			await expect(checkNoPlainRelayModuleImport()).resolves.toBeUndefined();
		},
		SCAN_TIMEOUT_MS,
	);

	test(
		"the existing ?module import",
		async () => {
			await plant("scripts/__f194_ok_module.ts", 'const R = await import("./relay.ts?module");\n');
			await expect(checkNoPlainRelayModuleImport()).resolves.toBeUndefined();
		},
		SCAN_TIMEOUT_MS,
	);

	test(
		"a typeof import (type-only, never evaluated)",
		async () => {
			await plant(
				"scripts/__f194_ok_typeof.ts",
				'type RelayModule = typeof import("./relay.ts");\n',
			);
			await expect(checkNoPlainRelayModuleImport()).resolves.toBeUndefined();
		},
		SCAN_TIMEOUT_MS,
	);
});

describe("the check:installers script syntax-checks every shell installer", () => {
	test("setup-hooks.sh, setup-relay.sh and install-local.sh are each passed to bash -n", async () => {
		const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf-8"));
		const script: string = pkg.scripts["check:installers"];
		for (const installer of ["install-local.sh", "setup-relay.sh", "setup-hooks.sh"]) {
			expect(script, installer).toContain(`bash -n scripts/${installer}`);
		}
	});
});
