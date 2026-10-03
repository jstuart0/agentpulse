/**
 * `tsc --noEmit` with the root tsconfig covers src/** only, so bin/cli.ts (the
 * CLI the exclude rule's check, add and setup run through) was never
 * type-checked: dropping an import used on an untested branch passed typecheck,
 * lint and every test. The typecheck script also runs tsconfig.bin.json; these
 * pin that it exists, that it really lists bin/cli.ts, and that the script runs it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
/** Each of these spawns a whole TypeScript run; a loaded machine takes far longer than bun's 5 s default. */
const TSC_TIMEOUT_MS = 180_000;
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
	scripts: Record<string, string>;
};

describe("the typecheck script covers bin/", () => {
	test("package.json's typecheck runs tsconfig.bin.json, and the file exists", () => {
		expect(pkg.scripts.typecheck).toContain("tsconfig.bin.json");
		expect(existsSync(join(ROOT, "tsconfig.bin.json"))).toBe(true);
	});

	test(
		"tsc, asked to list the files of tsconfig.bin.json, lists bin/cli.ts and its test files",
		() => {
			const out = Bun.spawnSync(
				[process.execPath, "x", "tsc", "-p", "tsconfig.bin.json", "--listFilesOnly"],
				{
					cwd: ROOT,
					stdout: "pipe",
					stderr: "pipe",
					env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
				},
			);
			const listed = out.stdout.toString();
			expect(listed).toContain(join(ROOT, "bin", "cli.ts"));
			expect(listed).toContain(join(ROOT, "bin", "cli.exclude.test.ts"));
		},
		TSC_TIMEOUT_MS,
	);

	test(
		"an import that bin/cli.ts needs but lacks is caught: a copy of the CLI without one fails the same config",
		() => {
			// Nothing may be written under node_modules (a stray directory there outlives a killed run),
			// so the probe lives in a temp directory and borrows the repository's type roots.
			const nodeModules = join(ROOT, "node_modules");
			const modulesChangedAt = statSync(nodeModules).mtimeMs;
			const dir = mkdtempSync(join(tmpdir(), "ap-typecheck-probe-"));
			try {
				const source = readFileSync(join(ROOT, "bin", "cli.ts"), "utf-8");
				// drop the import of loadExcludeRules, which the exclude commands call
				const broken = source.replace(/\bloadExcludeRules,\n/, "");
				expect(broken).not.toBe(source);
				writeFileSync(
					join(dir, "cli-broken.ts"),
					broken.replaceAll('"../src/', `"${join(ROOT, "src")}/`),
				);
				writeFileSync(
					join(dir, "tsconfig.json"),
					JSON.stringify({
						extends: join(ROOT, "tsconfig.json"),
						compilerOptions: { typeRoots: [join(nodeModules, "@types")] },
						include: [join(dir, "cli-broken.ts"), join(ROOT, "src", "**", "*.d.ts")],
						exclude: [],
					}),
				);
				const out = Bun.spawnSync(
					[process.execPath, "x", "tsc", "-p", join(dir, "tsconfig.json")],
					{
						cwd: ROOT,
						stdout: "pipe",
						stderr: "pipe",
						env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
					},
				);
				expect(out.exitCode).not.toBe(0);
				expect(out.stdout.toString()).toContain("loadExcludeRules");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
			expect(statSync(nodeModules).mtimeMs).toBe(modulesChangedAt);
		},
		TSC_TIMEOUT_MS,
	);
});
