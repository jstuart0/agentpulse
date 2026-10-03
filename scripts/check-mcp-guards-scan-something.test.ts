/**
 * The three guards that scan packages/agentpulse-mcp/src used to swallow a
 * failed directory read, so a moved or missing package directory meant "no
 * files, no violations, OK". Each case copies the real guard into a
 * throwaway tree and asserts a guard that scanned nothing fails.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BUN = process.execPath;
const SRC_DIR = "packages/agentpulse-mcp/src";
const trees: string[] = [];

afterEach(async () => {
	while (trees.length) await rm(trees.pop() as string, { recursive: true, force: true });
});

async function makeTree(script: string, files: Record<string, string>): Promise<string> {
	const tree = await mkdtemp(join(tmpdir(), "ap-mcp-guard-"));
	trees.push(tree);
	await mkdir(join(tree, "scripts"), { recursive: true });
	await copyFile(join(ROOT, "scripts", script), join(tree, "scripts", script));
	for (const [rel, content] of Object.entries(files)) {
		await mkdir(dirname(join(tree, rel)), { recursive: true });
		await writeFile(join(tree, rel), content);
	}
	return tree;
}

async function run(tree: string, script: string) {
	const proc = Bun.spawn([BUN, join(tree, "scripts", script)], {
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code: await proc.exited, stdout, stderr };
}

const GUARDS: { script: string; violation: string }[] = [
	{ script: "check-no-console-log-mcp.ts", violation: "console.log('x');\n" },
	{ script: "check-mcp-no-raw-register-tool.ts", violation: "server.registerTool('t', {}, f);\n" },
	{
		script: "check-mcp-no-cross-boundary-import.ts",
		violation: 'import { x } from "../server/thing.js";\n',
	},
];

describe.each(GUARDS)("$script", ({ script, violation }) => {
	test("a missing package directory fails instead of passing on zero files", async () => {
		const tree = await makeTree(script, {});
		const res = await run(tree, script);
		expect(res.code).not.toBe(0);
		expect(res.stdout).not.toContain("OK");
	});

	test("an empty package directory fails", async () => {
		const tree = await makeTree(script, {});
		await mkdir(join(tree, SRC_DIR), { recursive: true });
		expect((await run(tree, script)).code).not.toBe(0);
	});

	test("a clean file passes", async () => {
		const tree = await makeTree(script, { [`${SRC_DIR}/index.ts`]: "export const a = 1;\n" });
		const res = await run(tree, script);
		expect(res.code, res.stderr).toBe(0);
	});

	test("a violation fails", async () => {
		const tree = await makeTree(script, { [`${SRC_DIR}/index.ts`]: violation });
		expect((await run(tree, script)).code).not.toBe(0);
	});

	test.skipIf(process.getuid?.() === 0)(
		"an unreadable subdirectory fails the guard instead of being skipped",
		async () => {
			const tree = await makeTree(script, {
				[`${SRC_DIR}/index.ts`]: "export const a = 1;\n",
				[`${SRC_DIR}/tools/deep.ts`]: violation,
			});
			await chmod(join(tree, SRC_DIR, "tools"), 0o000);
			try {
				const res = await run(tree, script);
				expect(res.code).not.toBe(0);
				expect(res.stdout).not.toContain("OK");
			} finally {
				await chmod(join(tree, SRC_DIR, "tools"), 0o755);
			}
		},
	);

	test("the real repository passes", async () => {
		const res = await run(ROOT, script);
		expect(res.code, res.stderr).toBe(0);
	});
});

describe("files that are skipped do not count as scanned", () => {
	test("check-no-console-log-mcp.ts: a directory holding only allowlisted files fails", async () => {
		const script = "check-no-console-log-mcp.ts";
		const tree = await makeTree(script, {
			[`${SRC_DIR}/log.ts`]: "export const a = 1;\n",
			[`${SRC_DIR}/cli-commands.ts`]: "export const b = 2;\n",
		});
		const res = await run(tree, script);
		expect(res.code).not.toBe(0);
		expect(res.stdout).not.toContain("OK");
	});

	test("check-mcp-no-raw-register-tool.ts: a directory holding only the allowlisted file fails", async () => {
		const script = "check-mcp-no-raw-register-tool.ts";
		const tree = await makeTree(script, { [`${SRC_DIR}/server.ts`]: "export const a = 1;\n" });
		const res = await run(tree, script);
		expect(res.code).not.toBe(0);
		expect(res.stdout).not.toContain("OK");
	});
});
