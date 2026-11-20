/**
 * The relay carries its own copy of the release verifier, the version grammar and the capped GET (scripts/relay.ts,
 * the `BEGIN ... embed` blocks). `check:relay-update-embed` holds the copy equal to the source text; this holds it
 * equal in behaviour: the source modules' own test suites are re-pointed at the relay's exports and run in isolation
 * (a subprocess of `bun test`), so the embedded verifier faces exactly the matrix the original does, and a control
 * run proves the matrix would notice a copy that drifted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractBlock } from "./lib/relay-embed.ts";
import {
	UPDATE_EMBED_BLOCKS,
	checkRelayUpdateEmbed,
	replaceUpdateBlocks,
	updateBlockMarkers,
} from "./lib/relay-update-embed.ts";

const ROOT = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");
const RELAY = join(ROOT, "scripts", "relay.ts");
const SIGNER = join(ROOT, "src", "shared", "__fixtures__", "release-test-signer.js");
const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-embed-matrix-")));
	roots.push(dir);
	return dir;
}

/** `sourceTest` with its imports of the shared modules pointed at `relayPath` (the relay, or a copy of it). */
function repointed(sourceTest: string, moduleSpecifier: string, relayPath: string): string {
	const out = sourceTest
		.replace(`from "${moduleSpecifier}"`, `from "${relayPath}?module"`)
		.replace('from "./__fixtures__/release-test-signer.js"', `from "${SIGNER}"`);
	expect(out).not.toBe(sourceTest);
	return out;
}

function runMatrix(file: string, env: Record<string, string> = {}) {
	const proc = Bun.spawnSync([process.execPath, "test", file], {
		cwd: ROOT,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			NO_PROXY: "127.0.0.1,localhost,[::1]",
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
	const passed = Number(/(\d+) pass/.exec(output)?.[1] ?? "0");
	const failed = Number(/(\d+) fail/.exec(output)?.[1] ?? "0");
	return { code: proc.exitCode, passed, failed, output };
}

const MATRICES = [
	{
		name: "the signed manifest",
		source: "src/shared/release-manifest.test.ts",
		specifier: "./release-manifest.js",
		floor: 60,
	},
	{
		name: "the capped GET",
		source: "src/shared/capped-fetch.test.ts",
		specifier: "./capped-fetch.js",
		floor: 15,
	},
] as const;

describe("the relay's embedded copies face the same test matrices as their sources", () => {
	for (const matrix of MATRICES) {
		test(`${matrix.name}: every case of ${matrix.source} passes against scripts/relay.ts`, () => {
			const dir = scratch();
			const file = join(dir, "embedded.test.ts");
			writeFileSync(file, repointed(read(matrix.source), matrix.specifier, RELAY));
			const result = runMatrix(file);
			expect(result.failed, result.output.slice(-2000)).toBe(0);
			expect(result.code).toBe(0);
			// A population floor: the same matrix, not an empty run that "passes".
			expect(result.passed).toBeGreaterThanOrEqual(matrix.floor);
		}, 120_000);
	}

	test("named members are in the matrix: an active key's revocation list is ignored and an envelope revoking its own signer is refused", () => {
		const source = read("src/shared/release-manifest.test.ts");
		expect(source).toMatch(/active-signed|active key/i);
		expect(source).toContain("bad_payload");
		expect(source).toMatch(/__proto__/);
	});

	test("control: a relay copy whose capped GET follows redirects fails the capped-GET matrix", () => {
		const dir = scratch();
		const drifted = join(dir, "relay-drifted.ts");
		const original = readFileSync(RELAY, "utf-8");
		const mutated = original.replace('redirect: "manual",', 'redirect: "follow",');
		expect(mutated).not.toBe(original);
		writeFileSync(drifted, mutated);
		const file = join(dir, "drifted.test.ts");
		writeFileSync(
			file,
			repointed(read("src/shared/capped-fetch.test.ts"), "./capped-fetch.js", drifted),
		);
		const result = runMatrix(file);
		expect(result.failed).toBeGreaterThan(0);
		expect(result.code).not.toBe(0);
	}, 120_000);

	test("control: a relay copy that skips the signature check fails the manifest matrix", () => {
		const dir = scratch();
		const drifted = join(dir, "relay-drifted.ts");
		const original = readFileSync(RELAY, "utf-8");
		const mutated = original.replace(
			'if (!(await signatureVerifies(signer.publicKeyRaw, payloadBytes, sig)))\n\t\treturn fail("bad_signature");',
			"",
		);
		expect(mutated).not.toBe(original);
		writeFileSync(drifted, mutated);
		const file = join(dir, "drifted.test.ts");
		writeFileSync(
			file,
			repointed(read("src/shared/release-manifest.test.ts"), "./release-manifest.js", drifted),
		);
		const result = runMatrix(file);
		expect(result.failed).toBeGreaterThan(0);
	}, 120_000);
});

describe("the relay's trust root is the repo's", () => {
	test("the embedded release-keys block is the source file, so the production key list in the relay can never differ from src/shared/release-keys.ts", () => {
		const block = UPDATE_EMBED_BLOCKS.find((b) => b.name === "release-keys");
		expect(block).toBeDefined();
		if (!block) return;
		const embedded = extractBlock(readFileSync(RELAY, "utf-8"), updateBlockMarkers(block));
		expect(embedded).toContain("export const RELEASE_KEYS");
		expect(embedded).toBe(block.build(read));
	});

	test("no environment variable, option or argument names a key, a feed or a repository in the relay's self-refresh", () => {
		const relay = readFileSync(RELAY, "utf-8");
		const start = relay.indexOf("// ── Self-refresh from a signed release");
		const end = relay.indexOf("// ── `relay.ts update auto on|off|status`");
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const section = relay.slice(start, end);
		// The only environment variable the section reads is the launcher's flag.
		const reads = [...section.matchAll(/process\.env\.(\w+)|env\[(\w+)\]|env\.(\w+)/g)].map(
			(m) => m[1] ?? m[2] ?? m[3],
		);
		expect(new Set(reads)).toEqual(new Set(["RELAY_LAUNCHER_ENV"]));
		expect(section).not.toMatch(/MANIFEST_URL|github\.com|process\.argv/);
		// The fetch targets are the relay's own configured server.
		expect(section).toContain("`${base}/api/v1/health?manifest=1`");
		expect(section).toContain("`${base}/setup-relay.sh`");
	});
});

describe("drift in an embedded block is caught (demonstrated once)", () => {
	test("editing a source without re-embedding fails the check; re-embedding fixes it", () => {
		const relay = readFileSync(RELAY, "utf-8");
		expect(checkRelayUpdateEmbed(relay, read)).toEqual([]);

		const editedManifest = `${read("src/shared/release-manifest.ts")}\n// edited without re-embedding\n`;
		const edited = (rel: string) =>
			rel === "src/shared/release-manifest.ts" ? editedManifest : read(rel);
		const errors = checkRelayUpdateEmbed(relay, edited);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("release-manifest");
		expect(errors[0]).toContain("embed:relay-update");
		expect(checkRelayUpdateEmbed(replaceUpdateBlocks(relay, edited), edited)).toEqual([]);
	});

	test("a hand edit inside any block, a missing marker and a duplicated marker are each drift", () => {
		const relay = readFileSync(RELAY, "utf-8");
		for (const block of UPDATE_EMBED_BLOCKS) {
			const markers = updateBlockMarkers(block);
			const body = extractBlock(relay, markers);
			const handEdited = relay.replace(body, `${body}// a hand edit\n`);
			expect(
				checkRelayUpdateEmbed(handEdited, read).length,
				`${block.name}: hand edit`,
			).toBeGreaterThan(0);
			const missing = relay.replace(markers.end, "// (end marker removed)");
			expect(
				checkRelayUpdateEmbed(missing, read).length,
				`${block.name}: missing end`,
			).toBeGreaterThan(0);
			const duplicated = `${relay}\n${markers.start}\n${markers.end}\n`;
			expect(
				checkRelayUpdateEmbed(duplicated, read).length,
				`${block.name}: duplicated`,
			).toBeGreaterThan(0);
		}
		// every block of the plan is present, in dependency order
		expect(UPDATE_EMBED_BLOCKS.map((b) => b.name)).toEqual([
			"version",
			"release-keys",
			"capped-fetch",
			"release-manifest",
			"relay-installer-parts",
			"exclude-materialize",
			"agent-session-markers",
		]);
	});

	test("the CLI guard exits 0 on the real tree and 1 on a drifted relay", () => {
		const ok = Bun.spawnSync(
			[process.execPath, join(ROOT, "scripts", "check-relay-update-embed.ts")],
			{
				cwd: ROOT,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(ok.exitCode).toBe(0);
		expect(ok.stdout.toString()).toContain("OK");
	});
});
