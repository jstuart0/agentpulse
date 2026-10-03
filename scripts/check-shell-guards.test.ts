/**
 * The two shell architecture guards (check-no-raw-fetch.sh,
 * check-no-sync-transcript-io.sh) used to shell out to `rg` inside
 * `$(... || true)`: where ripgrep isn't installed they printed
 * "rg: command not found", swallowed it and reported OK, checking nothing.
 *
 * Each case copies the real script into a throwaway tree (the scripts cd to
 * their own parent directory, so the copy scans the planted tree), plants or
 * omits a violation, and asserts on the exit code. The last block runs both
 * scripts against the real repository.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BASH = Bun.which("bash") ?? "/bin/bash";
const trees: string[] = [];

afterEach(async () => {
	while (trees.length) await rm(trees.pop() as string, { recursive: true, force: true });
});

async function makeTree(script: string, files: Record<string, string>): Promise<string> {
	const tree = await mkdtemp(join(tmpdir(), "ap-shell-guard-"));
	trees.push(tree);
	await mkdir(join(tree, "scripts"), { recursive: true });
	await copyFile(join(ROOT, "scripts", script), join(tree, "scripts", script));
	await chmod(join(tree, "scripts", script), 0o755);
	for (const [rel, content] of Object.entries(files)) {
		await mkdir(dirname(join(tree, rel)), { recursive: true });
		await writeFile(join(tree, rel), content);
	}
	return tree;
}

async function run(tree: string, script: string, env: Record<string, string> = {}) {
	const proc = Bun.spawn([BASH, join(tree, "scripts", script)], {
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { code, stdout, stderr, output: stdout + stderr };
}

/** A PATH holding only `dirname` (the one tool the old scripts needed before
 * reaching the search tool), so any search tool the script relies on is
 * genuinely missing. */
async function pathWithoutSearchTools(): Promise<string> {
	const bin = await mkdtemp(join(tmpdir(), "ap-shell-guard-bin-"));
	trees.push(bin);
	const dirnameBin = Bun.which("dirname");
	if (dirnameBin) await symlink(dirnameBin, join(bin, "dirname"));
	return bin;
}

const CLEAN_WEB = {
	"src/web/pages/HomePage.tsx": "export const x = 1;\n",
	"src/web/components/Card.tsx": "export const y = 2;\n",
};

describe("check-no-raw-fetch.sh", () => {
	const script = "check-no-raw-fetch.sh";

	test("a clean tree passes", async () => {
		const tree = await makeTree(script, CLEAN_WEB);
		const res = await run(tree, script);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("OK");
	});

	test("a raw fetch( in pages fails and names the file", async () => {
		const tree = await makeTree(script, {
			...CLEAN_WEB,
			"src/web/pages/BadPage.tsx": "const r = await fetch('/api/v1/x');\n",
		});
		const res = await run(tree, script);
		expect(res.code).not.toBe(0);
		expect(res.output).toContain("src/web/pages/BadPage.tsx");
	});

	test("a raw fetch( in components fails", async () => {
		const tree = await makeTree(script, {
			...CLEAN_WEB,
			"src/web/components/Bad.tsx": "void fetch('/api/v1/x');\n",
		});
		const res = await run(tree, script);
		expect(res.code).not.toBe(0);
		expect(res.output).toContain("src/web/components/Bad.tsx");
	});

	test("a missing search tool fails the guard instead of reporting OK", async () => {
		const tree = await makeTree(script, {
			...CLEAN_WEB,
			"src/web/pages/BadPage.tsx": "const r = await fetch('/api/v1/x');\n",
		});
		const res = await run(tree, script, { PATH: await pathWithoutSearchTools() });
		expect(res.code).not.toBe(0);
		expect(res.stdout).not.toContain("OK");
	});

	test("a missing directory to scan fails instead of scanning nothing", async () => {
		const tree = await makeTree(script, { "src/web/pages/HomePage.tsx": "export const x = 1;\n" });
		const res = await run(tree, script);
		expect(res.code).not.toBe(0);
		expect(res.stdout).not.toContain("OK");
	});

	test("the login/signup call is the one allowed exception, and only that call", async () => {
		const allowed = "const res = await fetch(endpoint, {\n";
		const tree = await makeTree(script, {
			...CLEAN_WEB,
			"src/web/pages/LoginPage.tsx": allowed,
		});
		expect((await run(tree, script)).code).toBe(0);

		const second = await makeTree(script, {
			...CLEAN_WEB,
			"src/web/pages/LoginPage.tsx": `${allowed}await fetch('/api/v1/other');\n`,
		});
		const res = await run(second, script);
		expect(res.code).not.toBe(0);
		expect(res.output).toContain("/api/v1/other");

		const elsewhere = await makeTree(script, {
			...CLEAN_WEB,
			"src/web/pages/OtherPage.tsx": allowed,
		});
		expect((await run(elsewhere, script)).code).not.toBe(0);
	});

	describe("an allow rule matches the whole source line, once per file", () => {
		const allowed = "const res = await fetch(endpoint, {";
		const cases: [string, string][] = [
			["the allowed text inside a longer line", `${allowed} method: "GET" });\n`],
			["the allowed text in a trailing comment", `${allowed} // login\n`],
			["the allowed text after other code on the line", `void 0; ${allowed}\n`],
			["a second identical call in the same file", `${allowed}\n${allowed}\n`],
		];
		for (const [label, content] of cases) {
			test(`${label} fails the guard`, async () => {
				const tree = await makeTree(script, {
					...CLEAN_WEB,
					"src/web/pages/LoginPage.tsx": content,
				});
				const res = await run(tree, script);
				expect(res.code).not.toBe(0);
				expect(res.stdout).not.toContain("OK");
			});
		}

		test("the exact line passes even when indented", async () => {
			const tree = await makeTree(script, {
				...CLEAN_WEB,
				"src/web/pages/LoginPage.tsx": `function f() {\n\t\t\t${allowed}\n}\n`,
			});
			expect((await run(tree, script)).code).toBe(0);
		});
	});

	test("the ask-stream call is the one allowed exception, and only that call", async () => {
		const allowed = "res = await fetch(`${APP_API_BASE}/ai/ask/stream`, {\n";
		const tree = await makeTree(script, { ...CLEAN_WEB, "src/web/pages/AskPage.tsx": allowed });
		expect((await run(tree, script)).code).toBe(0);

		const second = await makeTree(script, {
			...CLEAN_WEB,
			"src/web/pages/AskPage.tsx": `${allowed}await fetch('/api/v1/other');\n`,
		});
		expect((await run(second, script)).code).not.toBe(0);
	});
});

describe("check-no-sync-transcript-io.sh", () => {
	const script = "check-no-sync-transcript-io.sh";
	const target = "src/server/services/transcript-sync.ts";

	test("a clean file passes", async () => {
		const tree = await makeTree(script, {
			[target]: "import { readFile } from 'node:fs/promises';\n",
		});
		const res = await run(tree, script);
		expect(res.code).toBe(0);
		expect(res.stdout).toContain("OK");
	});

	for (const fn of ["readFileSync", "statSync", "existsSync"]) {
		test(`${fn} fails and shows the line`, async () => {
			const tree = await makeTree(script, { [target]: `const a = ${fn}('/x');\n` });
			const res = await run(tree, script);
			expect(res.code).not.toBe(0);
			expect(res.output).toContain(fn);
		});
	}

	test("a missing search tool fails the guard instead of reporting OK", async () => {
		const tree = await makeTree(script, { [target]: "const a = readFileSync('/x');\n" });
		const res = await run(tree, script, { PATH: await pathWithoutSearchTools() });
		expect(res.code).not.toBe(0);
		expect(res.stdout).not.toContain("OK");
	});

	test("a missing target file fails instead of scanning nothing", async () => {
		const tree = await makeTree(script, {});
		const res = await run(tree, script);
		expect(res.code).not.toBe(0);
		expect(res.stdout).not.toContain("OK");
	});
});

const RUNNING_AS_ROOT = process.getuid?.() === 0;

describe("scanning nothing, or failing partway, is a failure", () => {
	test("check-no-raw-fetch.sh: scan directories that exist but hold no files fail", async () => {
		const script = "check-no-raw-fetch.sh";
		const tree = await makeTree(script, {});
		await mkdir(join(tree, "src/web/pages"), { recursive: true });
		await mkdir(join(tree, "src/web/components"), { recursive: true });
		const res = await run(tree, script);
		expect(res.code).not.toBe(0);
		expect(res.stdout).not.toContain("OK");
	});

	test.skipIf(RUNNING_AS_ROOT)(
		"check-no-raw-fetch.sh: an unreadable file makes the guard fail, not pass",
		async () => {
			const script = "check-no-raw-fetch.sh";
			const tree = await makeTree(script, CLEAN_WEB);
			await writeFile(join(tree, "src/web/pages/Secret.tsx"), "export const z = 3;\n");
			await chmod(join(tree, "src/web/pages/Secret.tsx"), 0o000);
			const res = await run(tree, script);
			expect(res.code).not.toBe(0);
			expect(res.stdout).not.toContain("OK");
		},
	);

	test.skipIf(RUNNING_AS_ROOT)(
		"check-no-sync-transcript-io.sh: an unreadable target fails, not passes",
		async () => {
			const script = "check-no-sync-transcript-io.sh";
			const target = "src/server/services/transcript-sync.ts";
			const tree = await makeTree(script, { [target]: "const a = 1;\n" });
			await chmod(join(tree, target), 0o000);
			const res = await run(tree, script);
			expect(res.code).not.toBe(0);
			expect(res.stdout).not.toContain("OK");
		},
	);
});

describe("both guards on the real repository", () => {
	test("check-no-raw-fetch.sh passes", async () => {
		const res = await run(ROOT, "check-no-raw-fetch.sh");
		expect(res.code, res.output).toBe(0);
	});

	test("check-no-sync-transcript-io.sh passes", async () => {
		const res = await run(ROOT, "check-no-sync-transcript-io.sh");
		expect(res.code, res.output).toBe(0);
	});
});
