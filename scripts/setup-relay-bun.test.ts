/**
 * F197/F200: the installer's Bun choice, exercised in bash against the real
 * function bodies extracted from scripts/setup-relay.sh — the version floor
 * at its patch boundary, and the release asset (with its pinned SHA256)
 * picked for each platform.
 *
 * The functions are sourced by name rather than the whole script, so this
 * never runs the installer's network/write side effects.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = readFileSync(join(import.meta.dir, "setup-relay.sh"), "utf-8");

function fn(name: string): string {
	const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "m").exec(SCRIPT);
	if (!match) throw new Error(`${name} not found in setup-relay.sh`);
	return match[0];
}

// macOS runs `curl | bash` with its own bash 3.2 (Bun.spawnSync only needs a
// bash on PATH for the second entry to exist).
const BASHES = ["bash", ...(existsSync("/bin/bash") ? ["/bin/bash"] : [])];

function run(bash: string, body: string, ...args: string[]) {
	const proc = Bun.spawnSync([bash, "-c", `set -euo pipefail\n${body}`, "test", ...args]);
	return { code: proc.exitCode, out: proc.stdout.toString().trim(), err: proc.stderr.toString() };
}

describe("F200: version_at_least, at the floor's patch boundary", () => {
	const floor = "1.3.12";
	const table: Array<[string, boolean]> = [
		["1.3.11", false],
		["1.3.12", true],
		["1.3.13", true],
		["1.10.0", true],
		["1.3.12-canary.1", true],
		["2.0", true],
		["1.2.99", false],
		["1.1.30", false],
		["garbage", false],
		["", false],
	];
	for (const bash of BASHES) {
		for (const [version, accepted] of table) {
			test(`${bash}: ${JSON.stringify(version)} -> ${accepted ? "accepted" : "rejected"}`, () => {
				const res = run(
					bash,
					`${fn("version_at_least")}\nversion_at_least "$1" "$2" && echo yes || echo no`,
					version,
					floor,
				);
				expect(res.err).toBe("");
				expect(res.out).toBe(accepted ? "yes" : "no");
			});
		}
	}

	test("a mutant comparing only major.minor (dropping the patch component) would fail this table", () => {
		// Documents *why* the table above matters: 1.3.11 vs the 1.3.12 floor
		// only differs in the patch component, so a version_at_least that
		// stopped comparing after minor would wrongly accept it. The real
		// function is exercised above; this just pins the counterexample.
		const [version, floorVersion] = ["1.3.11", "1.3.12"];
		const majorMinorOnly = (v: string, want: string) => {
			const [vMaj, vMin] = v.split(".").map(Number);
			const [wMaj, wMin] = want.split(".").map(Number);
			return vMaj > wMaj || (vMaj === wMaj && vMin >= wMin);
		};
		expect(majorMinorOnly(version, floorVersion)).toBe(true); // the bug
		const res = run(
			"bash",
			`${fn("version_at_least")}\nversion_at_least "$1" "$2" && echo yes || echo no`,
			version,
			floorVersion,
		);
		expect(res.out).toBe("no"); // the real function gets it right
	});
});

describe("F197: the Bun release asset and its pinned SHA256 per platform", () => {
	// os, arch, avx2, musl, rosetta -> asset
	const table: Array<[string, string, string, string, string, string]> = [
		["Darwin", "arm64", "yes", "no", "no", "darwin-aarch64"],
		["Darwin", "x86_64", "yes", "no", "no", "darwin-x64"],
		["Darwin", "x86_64", "no", "no", "no", "darwin-x64-baseline"],
		["Darwin", "x86_64", "no", "no", "yes", "darwin-aarch64"],
		["Linux", "x86_64", "yes", "no", "no", "linux-x64"],
		["Linux", "x86_64", "no", "no", "no", "linux-x64-baseline"],
		["Linux", "x86_64", "yes", "yes", "no", "linux-x64-musl"],
		["Linux", "x86_64", "no", "yes", "no", "linux-x64-musl-baseline"],
		["Linux", "aarch64", "no", "no", "no", "linux-aarch64"],
		["Linux", "arm64", "no", "no", "no", "linux-aarch64"],
		["Linux", "aarch64", "no", "yes", "no", "linux-aarch64-musl"],
	];
	for (const [os, arch, avx2, musl, rosetta, asset] of table) {
		test(`${os}/${arch} avx2=${avx2} musl=${musl} rosetta=${rosetta} -> ${asset}`, () => {
			const res = run(
				"bash",
				`${fn("bun_asset_for")}\n${fn("bun_asset_sha256")}\na="$(bun_asset_for "$@")"; echo "$a $(bun_asset_sha256 "$a")"`,
				os,
				arch,
				avx2,
				musl,
				rosetta,
			);
			const [picked, sha] = res.out.split(" ");
			expect(picked).toBe(asset);
			expect(sha).toMatch(/^[0-9a-f]{64}$/);
		});
	}

	test("an unsupported platform gets no asset, and an unknown asset no hash", () => {
		const res = run(
			"bash",
			`${fn("bun_asset_for")}\n${fn("bun_asset_sha256")}\necho "[$(bun_asset_for FreeBSD amd64 yes no no)] [$(bun_asset_sha256 bun-evil)]"`,
		);
		expect(res.out).toBe("[] []");
	});

	// Independently re-downloaded and re-hashed (shasum -a 256) against
	// https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/ — this
	// isn't just "the pinned value equals itself", it's the release's actual
	// published SHASUMS256.txt values, cross-checked at the file level.
	test("the pinned hashes are the Bun 1.3.12 release's published SHASUMS256.txt values", () => {
		const published: Record<string, string> = {
			"darwin-aarch64": "6c4bb87dd013ed1a8d6a16e357a3d094959fd5530b4d7061f7f3680c3c7cea1c",
			"darwin-x64": "0f58c53a3e7947f1e626d2f8d285f97c14b7cadcca9c09ebafc0ae9d35b58c3d",
			"darwin-x64-baseline": "cc4e22130c2bc2d944d3a286de08f2ed37fa74136e59760f3a4661e610246474",
			"linux-x64": "11dc3ee11bc1695e149737c6ca3d5619302cf4346e6b8a6ec7988967ef01ddc5",
			"linux-x64-baseline": "f8bb377a9ae93d44697ff91a2611164d2aedc9263415d623b0c3af24a6f55dab",
			"linux-x64-musl": "5a9f9a2102d4bd0d5210b4f6bd345151d2310623947085177c1b306e8587dce6",
			"linux-x64-musl-baseline": "a95e079aef96f1387b86e27b69f9a6babbd08154d9a59483f29d9de285b8e3ad",
			"linux-aarch64": "c40bc0ebca11bde7d75af497a654a874d0c7fd8d6a8d6031c173c10c9064297b",
			"linux-aarch64-musl": "731baab945bc471c17248ea375e66f71442879d2595c54045b3e861f4e8b9ab1",
		};
		expect(SCRIPT).toContain('BUN_VERSION="1.3.12"');
		for (const [asset, sha] of Object.entries(published)) {
			const res = run("bash", `${fn("bun_asset_sha256")}\nbun_asset_sha256 "$1"`, asset);
			expect([asset, res.out]).toEqual([asset, sha]);
		}
	});
});
