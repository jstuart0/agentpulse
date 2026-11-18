/**
 * The `~/.agentpulse/bin/agentpulse` shim: what `ap_render_shim` (scripts/lib/shim.sh) writes and how it
 * behaves when run. Every case runs the rendered file under `env -i` with a PATH that holds only stub
 * `id` and `sh` tools, so a shim that looked `bun` up on PATH would fail with "bun: not found" instead of
 * reaching the recorded Bun. The install-time half (the installer writes exactly these bytes) is in
 * scripts/install-local-run.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASHES, extractMarkerBlock, spawnChecked } from "./lib/installer-test-utils.ts";

const LIB = readFileSync(join(import.meta.dir, "lib", "shim.sh"), "utf-8");
const INSTALLER = readFileSync(join(import.meta.dir, "install-local.sh"), "utf-8");
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "ap-shim-")));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A directory and a Bun path that both hold a space and a single quote. */
const INSTALL_DIR = join(ROOT, "in stall's dir");
const BUN_DIR = join(ROOT, "b un's dir");
const BUN_BIN = join(BUN_DIR, "bun");
const HOME = join(ROOT, "home");
const STUB_LOG = join(ROOT, "stub.log");
const PATH_DIR = join(ROOT, "path");
for (const d of [INSTALL_DIR, BUN_DIR, join(HOME, ".agentpulse"), PATH_DIR]) {
	mkdirSync(d, { recursive: true });
}
// The recorded Bun logs what it was given, using shell builtins only (there is no other tool on PATH).
writeFileSync(
	BUN_BIN,
	[
		"#!/bin/sh",
		'{ printf "argc=%s\\n" "$#"; for a in "$@"; do printf "arg=%s\\n" "$a"; done;',
		'printf "cwd=%s\\n" "$PWD"; printf "real=%s\\n" "${AGENTPULSE_UPDATER_REAL_SERVICES-unset}"; } > "$AP_STUB_LOG"',
		"",
	].join("\n"),
);
chmodSync(BUN_BIN, 0o755);
// Stub `id` (uid from AP_UID) and `sh`: all that is on PATH.
writeFileSync(
	join(PATH_DIR, "id"),
	'#!/bin/sh\nif [ "${1-}" = "-u" ]; then echo "${AP_UID-1000}"; fi\n',
);
chmodSync(join(PATH_DIR, "id"), 0o755);
symlinkSync("/bin/sh", join(PATH_DIR, "sh"));

function render(bash: string, bunBin = BUN_BIN, installDir = INSTALL_DIR): string {
	const proc = spawnChecked([
		Bun.which(bash) ?? bash,
		"-c",
		'set -euo pipefail\n. "$1"\nap_render_shim "$2" "$3"',
		"x",
		join(import.meta.dir, "lib", "shim.sh"),
		bunBin,
		installDir,
	]);
	expect(proc.exitCode).toBe(0);
	return proc.stdout.toString();
}

let shimCount = 0;
function writeShim(text: string): string {
	shimCount += 1;
	const file = join(ROOT, `shim-${shimCount}`);
	writeFileSync(file, text);
	chmodSync(file, 0o700);
	return file;
}

function runShimWith(shim: string, args: string[], extra: string[] = []) {
	writeFileSync(STUB_LOG, "");
	const proc = spawnChecked([
		"/usr/bin/env",
		"-i",
		`PATH=${PATH_DIR}`,
		`HOME=${HOME}`,
		`AP_STUB_LOG=${STUB_LOG}`,
		...extra,
		shim,
		...args,
	]);
	return {
		code: proc.exitCode,
		out: proc.stdout.toString(),
		err: proc.stderr.toString(),
		stub: readFileSync(STUB_LOG, "utf-8"),
	};
}

const BUNDLE = join(HOME, ".agentpulse", "updater", "current", "updater.js");

for (const { bash, label } of BASHES) {
	describe(`${label}: the rendered shim`, () => {
		const text = render(bash);

		test("is a POSIX sh script that records the Bun and the install directory as quoted literals", () => {
			expect(text.startsWith("#!/bin/sh\n")).toBe(true);
			expect(text.endsWith("\n")).toBe(true);
			expect(text).toContain(`BUN_BIN='${BUN_BIN.replace(/'/g, "'\\''")}'`);
			expect(text).toContain(`INSTALL_DIR='${INSTALL_DIR.replace(/'/g, "'\\''")}'`);
		});

		test("is deterministic", () => {
			expect(render(bash)).toBe(text);
		});

		test("`version` runs the CLI with the recorded Bun, no bun on PATH, and no updater variable", () => {
			const shim = writeShim(text);
			const r = runShimWith(shim, ["version"]);
			expect(r.code).toBe(0);
			expect(r.stub).toContain("argc=2\n");
			expect(r.stub).toContain(`arg=${INSTALL_DIR}/bin/cli.ts\n`);
			expect(r.stub).toContain("arg=version\n");
			expect(r.stub).toContain("real=unset\n");
		});

		test("every other subcommand also drops an updater variable the caller had set", () => {
			const shim = writeShim(text);
			const r = runShimWith(shim, ["version"], ["AGENTPULSE_UPDATER_REAL_SERVICES=1"]);
			expect(r.stub).toContain("real=unset\n");
		});

		test("`update` with a bundle present runs it with unsplit arguments, cwd ~/.agentpulse and the real-services variable", () => {
			mkdirSync(join(HOME, ".agentpulse", "updater", "current"), { recursive: true });
			writeFileSync(BUNDLE, "// bundle\n");
			try {
				const shim = writeShim(text);
				const r = runShimWith(shim, ["update", "--to", "v0.12.0", "a b"]);
				expect(r.code).toBe(0);
				const lines = r.stub.split("\n");
				expect(lines[0]).toBe("argc=5");
				expect(lines.slice(1, 6)).toEqual([
					`arg=${BUNDLE}`,
					"arg=update",
					"arg=--to",
					"arg=v0.12.0",
					"arg=a b",
				]);
				expect(r.stub).toContain(`cwd=${join(HOME, ".agentpulse")}\n`);
				expect(r.stub).toContain("real=1\n");
			} finally {
				rmSync(join(HOME, ".agentpulse", "updater"), { recursive: true, force: true });
			}
		});

		test("`update` with no bundle says updates arrive with 0.12.0, exits 0 and never runs Bun", () => {
			expect(existsSync(BUNDLE)).toBe(false);
			const shim = writeShim(text);
			const r = runShimWith(shim, ["update"]);
			expect(r.code).toBe(0);
			expect(r.out).toContain("updates arrive with 0.12.0");
			expect(r.stub).toBe("");
		});

		test("refuses uid 0 before doing anything else", () => {
			const shim = writeShim(text);
			for (const args of [["version"], ["update"]]) {
				const r = runShimWith(shim, args, ["AP_UID=0"]);
				expect(r.code).toBe(1);
				expect(r.err).toContain("Don't run agentpulse as root.");
				expect(r.stub).toBe("");
			}
		});
	});
}

describe("the shim text", () => {
	test("a path with a single quote is escaped, not refused, and a newline is refused", () => {
		const text = render("bash", "/odd/it's/bun", "/odd/it's/dir");
		expect(text).toContain("BUN_BIN='/odd/it'\\''s/bun'");
		const proc = spawnChecked([
			"bash",
			"-c",
			'. "$1"; ap_render_shim "$2" /ok',
			"x",
			join(import.meta.dir, "lib", "shim.sh"),
			"/bad\npath/bun",
		]);
		expect(proc.exitCode).not.toBe(0);
		expect(proc.stdout.toString()).toBe("");
	});

	test("the installer carries the same block as scripts/lib/shim.sh", () => {
		const block = extractMarkerBlock(INSTALLER, "agentpulse-shim", {
			minLines: 10,
			sentinel: "ap_render_shim() {",
		});
		expect(block).toBe(LIB.trimEnd());
	});

	test("the shim file mode the installer sets is private (0700) when written", () => {
		const file = writeShim("#!/bin/sh\n");
		expect(statSync(file).mode & 0o777).toBe(0o700);
	});
});
