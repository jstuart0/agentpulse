/**
 * The shared installer blocks, `agentpulse-bun` and `agentpulse-pkg-hint`
 * (scripts/setup-relay.sh and its served copy): byte-equal across sites, the
 * pins, the platform table, the checksum-tool matrix, the download, the
 * acceptance rules for a Bun path, the resolver's order and the install hints.
 * Every case runs the REAL block under each bash in BASHES (macOS's 3.2 is
 * skipped by name where /bin/bash is something else), with a PATH built from
 * symlinks and stubs so nothing on the developer's machine decides the result.
 * install-local.sh and its served copy join the parity sites when that script
 * adopts the blocks (the next phase).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/server/db/__test_db.js";
import {
	BASHES,
	BASH_3_2,
	HAS_ICONV,
	MESSAGES,
	extractMarkerBlock,
	fakeBun,
	lsStub,
	makeFakeBunZip,
	run,
	shellQuote,
	stubDir,
} from "./lib/installer-test-utils.ts";

const { INSTALLER_SOURCES, buildRelayInstaller } = await import("../src/server/installers.js");

// Each case starts a bash or two with a fresh PATH; the first of them on a
// loaded machine can use most of the 5 s default (AGEN-18).
setDefaultTimeout(60_000);

const RELAY = readFileSync(join(import.meta.dir, "setup-relay.sh"), "utf-8");
const served = buildRelayInstaller(INSTALLER_SOURCES, "https://relay.example.test");
if (!served.ok) throw new Error(`the relay installer wasn't built: ${served.reason}`);

const BLOCKS = [
	{ name: "agentpulse-bun", minLines: 200, sentinel: "ap_install_pinned_bun() {" },
	{ name: "agentpulse-pkg-hint", minLines: 30, sentinel: "ap_install_hint() {" },
] as const;
const SITES = [
	{ site: "scripts/setup-relay.sh", source: RELAY },
	{ site: "the served /setup-relay.sh", source: served.script },
];
const blockAt = (source: string, b: (typeof BLOCKS)[number]) =>
	extractMarkerBlock(source, b.name, { minLines: b.minLines, sentinel: b.sentinel });
const BUN_BLOCK = blockAt(RELAY, BLOCKS[0]);
const HINT_BLOCK = blockAt(RELAY, BLOCKS[1]);

const root = mkdtempSync(join(tmpdir(), "ap-shared-blocks-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function scratch(label = "t") {
	counter += 1;
	const dir = join(root, `${label}-${counter}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

type Matrix = { bash: string; label: string; skip?: string };
const MATRIX: Matrix[] = [...BASHES, ...(BASH_3_2.skip ? [BASH_3_2] : [])];

/** One case under every bash; an unavailable one is skipped under its own name. */
function each(name: string, body: (bash: string) => void | Promise<void>, skipReason?: string) {
	for (const m of MATRIX) {
		if (skipReason) test.skip(`${skipReason}: ${name}`, () => {});
		else if (m.skip) test.skip(`${m.skip}: ${name}`, () => {});
		else test(`${m.label}: ${name}`, () => body(m.bash));
	}
}

const real = (tool: string) => {
	const path = Bun.which(tool);
	if (!path) throw new Error(`${tool} isn't available here`);
	return path;
};

/** The tools every case needs, plus stubs for the ones a test controls through AP_TEST_*. */
const BASE_TOOLS = [
	"awk",
	"cat",
	"chmod",
	"cp",
	"dirname",
	"grep",
	"head",
	...(HAS_ICONV ? ["iconv"] : []),
	"ls",
	"mkdir",
	"mktemp",
	"mv",
	"rm",
	"tr",
];
const STD_STUBS = (): Record<string, string> => ({
	uname: `case "\${1-}" in -s) echo "$AP_TEST_S" ;; -m) echo "$AP_TEST_M" ;; *) exec "${real("uname")}" "$@" ;; esac`,
	id: `if [ "\${1-}" = "-u" ]; then echo "\${AP_TEST_UID:-${process.getuid?.() ?? 0}}"; else exec "${real("id")}" "$@"; fi`,
	sysctl: `case "$*" in *proc_translated*) echo "\${AP_TEST_ROSETTA:-0}" ;; *avx2*) echo "\${AP_TEST_AVX2:-0}" ;; esac`,
	ldd: 'echo "$AP_TEST_LDD"; exit "${AP_TEST_LDD_RC:-0}"',
});
function pathOf(extraTools: string[] = [], stubs: Record<string, string> = {}) {
	return stubDir([...BASE_TOOLS, ...extraTools], { ...STD_STUBS(), ...stubs }, root);
}

type Env = Record<string, string>;
function inBlocks(bash: string, body: string, path: string, env: Env = {}, args: string[] = []) {
	const home = env.HOME ?? scratch("home");
	const full: Env = {
		PATH: path,
		HOME: home,
		TMPDIR: home,
		AP_TEST_S: "Linux",
		AP_TEST_M: "x86_64",
		...env,
	};
	return { ...run(bash, `${BUN_BLOCK}\n${HINT_BLOCK}\n${body}`, args, full), env: full };
}

describe("the blocks are byte-equal across sites", () => {
	for (const b of BLOCKS) {
		test(`${b.name}: every site carries the same block`, () => {
			const first = blockAt(SITES[0].source, b);
			for (const { site, source } of SITES) {
				expect([site, blockAt(source, b)]).toEqual([site, first]);
			}
		});
	}

	test("a missing block throws instead of returning an empty one", () => {
		expect(() => extractMarkerBlock("no markers here", "agentpulse-bun")).toThrow();
		expect(() => extractMarkerBlock(RELAY, "agentpulse-bun", { minLines: 10_000 })).toThrow();
	});
});

describe("static guards over the shared blocks", () => {
	for (const b of BLOCKS) {
		const text = blockAt(RELAY, b);
		test(`${b.name}: no whole-array expansion (bash 3.2 breaks on an empty one)`, () => {
			expect(text).not.toMatch(/\$\{[^}]*\[[@*]\]/);
		});
		test(`${b.name}: no pattern replacement whose text holds & (bash 5.2 reads it as the match)`, () => {
			expect(text).not.toMatch(/\$\{[^}]*\/\/[^}]*&/);
		});
		test(`${b.name}: no exit handler is installed`, () => {
			expect(text).not.toMatch(/^\s*trap\b/m);
		});
	}
});

describe("the pins", () => {
	const emitted = new Set(
		[
			...BUN_BLOCK.slice(
				BUN_BLOCK.indexOf("bun_asset_for() {"),
				BUN_BLOCK.indexOf("bun_asset_sha256() {"),
			).matchAll(/echo "([a-z0-9-]+)"/g),
		].map((m) => m[1]),
	);
	const pinned = new Map(
		[...BUN_BLOCK.matchAll(/^\s+([a-z0-9-]+)\) echo "([0-9a-f]+)" ;;$/gm)].map((m) => [m[1], m[2]]),
	);

	test("the assets bun_asset_for can name are exactly the ones bun_asset_sha256 pins", () => {
		expect(emitted.size).toBe(9);
		expect(emitted.has("linux-x64")).toBe(true);
		expect(new Set(pinned.keys())).toEqual(emitted);
	});

	test("every pinned hash is 64 hex characters", () => {
		for (const [asset, sha] of pinned)
			expect([asset, /^[0-9a-f]{64}$/.test(sha)]).toEqual([asset, true]);
	});

	each(
		"ap_install_pinned_bun hands ap_fetch_bun_zip the release URL, that asset's hash and https",
		(bash) => {
			for (const [asset, sha] of pinned) {
				const res = inBlocks(
					bash,
					`ap_fetch_bun_zip() { printf '%s\\n' "$@"; }\nap_install_pinned_bun "$1" /d/bin/bun /w`,
					pathOf(),
					{},
					[asset],
				);
				expect(res.out.split("\n")).toEqual([
					`https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/bun-${asset}.zip`,
					sha,
					asset,
					"/d/bin/bun",
					"/w",
					"https",
				]);
			}
		},
	);
});

describe("ap_bun_asset: the platform table", () => {
	const rows: Array<[string, Env, string, string]> = [
		["Darwin arm64", { AP_TEST_S: "Darwin", AP_TEST_M: "arm64" }, "", "darwin-aarch64"],
		[
			"Darwin x86_64 under Rosetta",
			{ AP_TEST_S: "Darwin", AP_TEST_M: "x86_64", AP_TEST_ROSETTA: "1" },
			"",
			"darwin-aarch64",
		],
		[
			"Darwin x86_64 without avx2",
			{ AP_TEST_S: "Darwin", AP_TEST_M: "x86_64", AP_TEST_AVX2: "0" },
			"",
			"darwin-x64-baseline",
		],
		[
			"Linux x86_64 glibc with avx2",
			{ AP_TEST_LDD: "ldd (GNU libc) 2.39" },
			"flags : sse4 avx2",
			"linux-x64",
		],
		[
			"Linux x86_64 musl without avx2 (musl's ldd exits 1)",
			{ AP_TEST_LDD: "musl libc (x86_64)", AP_TEST_LDD_RC: "1" },
			"flags : sse4",
			"linux-x64-musl-baseline",
		],
		[
			"Linux aarch64 musl",
			{ AP_TEST_M: "aarch64", AP_TEST_LDD: "musl libc (aarch64)", AP_TEST_LDD_RC: "1" },
			"",
			"linux-aarch64-musl",
		],
		["FreeBSD amd64", { AP_TEST_S: "FreeBSD", AP_TEST_M: "amd64" }, "", ""],
	];
	for (const [name, env, cpu, asset] of rows) {
		each(`${name} -> ${asset || "nothing"}`, (bash) => {
			const cpuinfo = join(scratch("cpu"), "cpuinfo");
			writeFileSync(cpuinfo, `${cpu}\n`);
			const res = inBlocks(bash, 'ap_bun_asset "$1"', pathOf(), env, [cpuinfo]);
			expect([res.code, res.out, res.err]).toEqual([0, asset, ""]);
		});
	}
});

/** A curl that logs its arguments and then runs the real one. */
const loggingCurl = (log: string) => `echo "$*" >> "${log}"; exec "${real("curl")}" "$@"`;
/** A sha256sum that works wherever shasum does (not every machine ships a real one). */
const sha256sumStub = () =>
	Bun.which("sha256sum") ? {} : { sha256sum: `exec "${real("shasum")}" -a 256 "$@"` };

describe("ap_fetch_bun_zip", () => {
	const ASSET = "linux-x64";
	const fetchCase = (
		bash: string,
		z: { zip: string; sha: string },
		dir: string,
		opts: {
			tools?: string[];
			stubs?: Record<string, string>;
			proto?: string;
			sha?: string;
			umask?: string;
		} = {},
	) => {
		const curlLog = join(dir, "curl.log");
		const res = inBlocks(
			bash,
			`${opts.umask ? `umask ${opts.umask}\n` : ""}if ap_fetch_bun_zip "$1" "$2" "$3" "$4" "$5" "$6"; then echo "RC=0"; else echo "RC=1"; fi`,
			pathOf(opts.tools ?? ["curl", "unzip", "shasum"], {
				curl: loggingCurl(curlLog),
				...opts.stubs,
			}),
			{},
			[
				`file://${z.zip}`,
				opts.sha ?? z.sha,
				ASSET,
				join(dir, "inst", "bin", "bun"),
				join(dir, "work"),
				opts.proto ?? "file",
			],
		);
		const log = existsSync(curlLog) ? readFileSync(curlLog, "utf-8") : "";
		return { ...res, log, dest: join(dir, "inst", "bin", "bun"), work: join(dir, "work") };
	};
	const mode = (p: string) => statSync(p).mode & 0o777;

	each(
		"a good zip installs a 755 binary, even under umask 002, and creates the work dir at 700",
		(bash) => {
			const dir = scratch("fetch");
			const res = fetchCase(bash, makeFakeBunZip(dir, ASSET, "file"), dir, { umask: "002" });
			expect([res.out, res.err]).toEqual(["RC=0", ""]);
			expect(existsSync(res.work)).toBe(true);
			expect(mode(res.work)).toBe(0o700);
			expect([mode(res.dest), mode(join(dir, "inst")), mode(join(dir, "inst", "bin"))]).toEqual([
				0o755, 0o755, 0o755,
			]);
			expect(readdirSync(join(dir, "inst", "bin"))).toEqual(["bun"]);
		},
	);

	each("with only shasum, or only sha256sum, a good zip installs", (bash) => {
		for (const [tools, stubs] of [
			[["curl", "unzip", "shasum"], {}],
			[["curl", "unzip"], sha256sumStub()],
		] as const) {
			if (tools.length === 2 && !Bun.which("sha256sum") && !Bun.which("shasum")) continue;
			const dir = scratch("fetch");
			const res = fetchCase(bash, makeFakeBunZip(dir, ASSET, "file"), dir, {
				tools: [...tools, ...(tools.length === 2 && Bun.which("sha256sum") ? ["sha256sum"] : [])],
				stubs,
			});
			expect([res.out, res.err]).toEqual(["RC=0", ""]);
		}
	});

	each("with neither shasum nor sha256sum it names sha256sum and never starts curl", (bash) => {
		const dir = scratch("fetch");
		const res = fetchCase(bash, makeFakeBunZip(dir, ASSET, "file"), dir, {
			tools: ["curl", "unzip"],
		});
		expect(res.out).toBe("RC=1");
		expect(res.err).toContain(MESSAGES.fetch.tool("sha256sum", null));
		expect(res.log).toBe("");
		expect(existsSync(res.dest)).toBe(false);
	});

	each("with no unzip it is refused before curl", (bash) => {
		const dir = scratch("fetch");
		const res = fetchCase(bash, makeFakeBunZip(dir, ASSET, "file"), dir, {
			tools: ["curl", "shasum"],
		});
		expect(res.out).toBe("RC=1");
		expect(res.err).toContain(MESSAGES.fetch.tool("unzip", null));
		expect(res.log).toBe("");
		expect(existsSync(res.work)).toBe(false);
	});

	each("a wrong hash is refused under shasum and under sha256sum, and installs nothing", (bash) => {
		for (const [tools, stubs] of [
			[["curl", "unzip", "shasum"], {}],
			[["curl", "unzip"], sha256sumStub()],
		] as const) {
			if (tools.length === 2 && !Bun.which("sha256sum") && !Bun.which("shasum")) continue;
			const dir = scratch("fetch");
			const res = fetchCase(bash, makeFakeBunZip(dir, ASSET, "file"), dir, {
				tools: [...tools, ...(tools.length === 2 && Bun.which("sha256sum") ? ["sha256sum"] : [])],
				stubs,
				sha: "0".repeat(64),
			});
			expect(res.out).toBe("RC=1");
			expect(res.err).toContain(MESSAGES.fetch.checksum);
			expect(existsSync(res.dest)).toBe(false);
		}
	});

	each("a corrupt zip is refused as unzippable", (bash) => {
		const dir = scratch("fetch");
		const res = fetchCase(bash, makeFakeBunZip(dir, ASSET, "corrupt"), dir);
		expect(res.out).toBe("RC=1");
		expect(res.err).toContain(MESSAGES.fetch.unzip);
		expect(existsSync(res.dest)).toBe(false);
	});

	each("a member that is a symlink is refused as not a regular file", (bash) => {
		const dir = scratch("fetch");
		const res = fetchCase(bash, makeFakeBunZip(dir, ASSET, "symlink"), dir);
		expect(res.out).toBe("RC=1");
		expect(res.err).toContain(MESSAGES.fetch.notRegular(ASSET));
		expect(existsSync(res.dest)).toBe(false);
	});

	each("proto=https refuses a file:// URL, which shows --proto is applied", (bash) => {
		const dir = scratch("fetch");
		const z = makeFakeBunZip(dir, ASSET, "file");
		const res = fetchCase(bash, z, dir, { proto: "https" });
		expect(res.out).toBe("RC=1");
		expect(res.err).toContain(MESSAGES.fetch.download(`file://${z.zip}`));
		expect(res.log).toContain("--proto =https --proto-redir =https");
		expect(res.log).toContain("-fsSL");
	});

	each("an existing 700 destination root stays 700; a 775 one only loses group write", (bash) => {
		for (const [start, want] of [
			[0o700, 0o700],
			[0o775, 0o755],
		] as const) {
			const dir = scratch("fetch");
			mkdirSync(join(dir, "inst", "bin"), { recursive: true });
			chmodSync(join(dir, "inst", "bin"), start);
			chmodSync(join(dir, "inst"), start);
			const res = fetchCase(bash, makeFakeBunZip(dir, ASSET, "file"), dir);
			expect([res.out, res.err]).toEqual(["RC=0", ""]);
			expect([mode(join(dir, "inst")), mode(join(dir, "inst", "bin"))]).toEqual([want, want]);
		}
	});

	each("an empty pinned checksum fails closed", (bash) => {
		const dir = scratch("fetch");
		const res = fetchCase(bash, makeFakeBunZip(dir, ASSET, "file"), dir, { sha: "" });
		expect(res.out).toBe("RC=1");
		expect(res.err).toContain(MESSAGES.fetch.checksum);
		expect(existsSync(res.dest)).toBe(false);
	});

	each("an empty pinned checksum is refused even when the hash tool prints nothing", (bash) => {
		const dir = scratch("fetch");
		const res = fetchCase(bash, makeFakeBunZip(dir, ASSET, "file"), dir, {
			sha: "",
			stubs: { shasum: "exit 0" },
		});
		expect(res.out).toBe("RC=1");
		expect(res.err).toContain(MESSAGES.fetch.checksum);
		expect(existsSync(res.dest)).toBe(false);
	});

	each("with neither unzip nor a checksum tool both are named, and curl never starts", (bash) => {
		const dir = scratch("fetch");
		const res = fetchCase(bash, makeFakeBunZip(dir, ASSET, "file"), dir, { tools: ["curl"] });
		expect(res.out).toBe("RC=1");
		expect(res.err).toContain(MESSAGES.fetch.tool("unzip", null));
		expect(res.err).toContain(MESSAGES.fetch.tool("sha256sum", null));
		expect(res.log).toBe("");
	});

	each("a failure after staging removes the stage file", (bash) => {
		const dir = scratch("fetch");
		const res = fetchCase(bash, makeFakeBunZip(dir, ASSET, "file"), dir, {
			stubs: { cp: "exit 1" },
		});
		expect(res.out).toBe("RC=1");
		expect(res.err).toContain("couldn't install Bun at");
		expect(readdirSync(join(dir, "inst", "bin"))).toEqual([]);
	});
});

describe("ap_bun_acceptable and ap_resolve_bun: which Bun may run in a service", () => {
	const me = process.getuid?.() ?? 0;

	/** A good Bun at <dir>/bin/bun under a fresh scratch directory; returns its parts. */
	async function bunUnder(
		label: string,
		opts: { dirMode?: number; fileMode?: number; version?: string } = {},
	) {
		const base = scratch(label);
		const bin = join(base, "bin");
		const file = await fakeBun(bin, opts.version ?? "1.3.12", opts.fileMode ?? 0o755);
		chmodSync(bin, opts.dirMode ?? 0o755);
		chmodSync(base, 0o755);
		return { base, bin, file };
	}

	/** ap_resolve_bun with BUN_INSTALL pointing at `installDir`; prints the refusal line and the result. */
	function resolveVia(
		bash: string,
		installDir: string,
		extra: { stubs?: Record<string, string>; env?: Env; path?: string } = {},
	) {
		const path = extra.path ?? pathOf([], extra.stubs);
		return inBlocks(
			bash,
			'ap_resolve_bun "$HOME/.agentpulse/bun"; echo "BIN=$BUN_BIN NEEDS=$BUN_NEEDS_INSTALL"',
			path,
			{ BUN_INSTALL: installDir, ...extra.env },
		);
	}
	const refusal = (bash: string, p: string, reason: string, env?: Env) =>
		MESSAGES.notUsing(shellQuote(bash, p, env), reason);

	each("a good file at 755 in a 755 directory is accepted and used", async (bash) => {
		const { base, file } = await bunUnder("good");
		const res = resolveVia(bash, base);
		expect([res.out, res.err]).toEqual([`BIN=${file} NEEDS=0`, ""]);
	});

	each("Darwin: a Homebrew-style 775 directory owned by gid 80 is accepted", async (bash) => {
		const { base, bin, file } = await bunUnder("brew", { dirMode: 0o775 });
		const res = resolveVia(bash, base, {
			stubs: { ls: lsStub(me, 80, bin) },
			env: { AP_TEST_S: "Darwin", AP_TEST_M: "arm64" },
		});
		expect(res.out).toBe(`BIN=${file} NEEDS=0`);
	});

	each("a symlink to a good file is accepted with its path kept as written", async (bash) => {
		const target = await bunUnder("target");
		const link = scratch("link");
		mkdirSync(join(link, "bin"));
		symlinkSync(target.file, join(link, "bin", "bun"));
		const res = resolveVia(bash, link);
		expect(res.out).toBe(`BIN=${join(link, "bin", "bun")} NEEDS=0`);
	});

	each("a file and directory owned by root are accepted", async (bash) => {
		const { base, bin, file } = await bunUnder("rootowned");
		const res = resolveVia(bash, base, { stubs: { ls: lsStub(0, 0, [file, bin]) } });
		expect([res.out, res.err]).toEqual([`BIN=${file} NEEDS=0`, ""]);
	});

	/** Narrow-mode refusals, each with the exact `Not using` line the resolver prints. */
	const refusals: Array<
		[
			string,
			(b: string) => Promise<{ install: string; stubs?: Record<string, string>; env?: Env }>,
			string,
		]
	> = [];
	for (const [label, name] of [
		["a space", "a b"],
		["%", "a%b"],
		["$", "a$b"],
		["a newline", "a\nb"],
		["&", "a&b"],
		["<", "a<b"],
		["é", "aé"],
	] as const) {
		refusals.push([
			`${label} in the path`,
			async () => {
				const base = join(scratch("chars"), name);
				mkdirSync(join(base, "bin"), { recursive: true });
				await fakeBun(join(base, "bin"), "1.3.12");
				return { install: base };
			},
			MESSAGES.reason.badChars,
		]);
	}
	for (const [label, rel] of [
		["a . component", "x/./y"],
		["a .. component", "x/../x/y"],
		["an empty component (//)", "x//y"],
	] as const) {
		refusals.push([
			label,
			async () => {
				const t = scratch("comp");
				mkdirSync(join(t, "x", "y", "bin"), { recursive: true });
				await fakeBun(join(t, "x", "y", "bin"), "1.3.12");
				return { install: `${t}/${rel}` };
			},
			MESSAGES.reason.component,
		]);
	}
	refusals.push(
		[
			"a directory where the file should be",
			async () => {
				const t = scratch("isdir");
				mkdirSync(join(t, "bin", "bun"), { recursive: true });
				return { install: t };
			},
			MESSAGES.reason.notExecutable,
		],
		[
			"a mode-644 file",
			async () => ({ install: (await bunUnder("m644", { fileMode: 0o644 })).base }),
			MESSAGES.reason.notExecutable,
		],
		[
			"a world-writable file (777)",
			async () => ({ install: (await bunUnder("m777", { fileMode: 0o777 })).base }),
			MESSAGES.reason.worldWritable,
		],
		[
			"a world-writable directory (1777)",
			async () => ({ install: (await bunUnder("d1777", { dirMode: 0o1777 })).base }),
			MESSAGES.reason.worldWritable,
		],
		[
			"a version below the floor",
			async () => ({ install: (await bunUnder("old", { version: "1.3.11" })).base }),
			MESSAGES.reason.older("1.3.11"),
		],
		[
			"a --version that fails",
			async () => {
				const b = await bunUnder("noversion");
				writeFileSync(b.file, "#!/bin/sh\nexit 1\n");
				return { install: b.base };
			},
			MESSAGES.reason.unknownVersion,
		],
		[
			"a file owned by another user",
			async () => {
				const b = await bunUnder("foreignfile");
				return { install: b.base, stubs: { ls: lsStub(me + 4242, 20, b.file) } };
			},
			MESSAGES.reason.notOwned,
		],
		[
			"a directory owned by another user",
			async () => {
				const b = await bunUnder("foreigndir");
				return { install: b.base, stubs: { ls: lsStub(me + 4242, 20, b.bin) } };
			},
			MESSAGES.reason.notOwned,
		],
		[
			"Linux: a 775 directory in the user's own group",
			async () => {
				const b = await bunUnder("grp", { dirMode: 0o775 });
				return { install: b.base, stubs: { ls: lsStub(me, process.getgid?.() ?? 20, b.bin) } };
			},
			MESSAGES.reason.groupWritable,
		],
		[
			"Linux: a 775 directory with gid 80",
			async () => {
				const b = await bunUnder("gid80", { dirMode: 0o775 });
				return { install: b.base, stubs: { ls: lsStub(me, 80, b.bin) } };
			},
			MESSAGES.reason.groupWritable,
		],
		[
			"Darwin: a 775 directory with an unrelated gid",
			async () => {
				const b = await bunUnder("gid1234", { dirMode: 0o775 });
				return {
					install: b.base,
					stubs: { ls: lsStub(me, 1234, b.bin) },
					env: { AP_TEST_S: "Darwin", AP_TEST_M: "arm64" },
				};
			},
			MESSAGES.reason.groupWritable,
		],
		[
			"Linux: a file made under umask 002 (mode 775)",
			async () => ({ install: (await bunUnder("umask002", { fileMode: 0o775 })).base }),
			MESSAGES.reason.groupWritable,
		],
	);
	for (const [label, build, reason] of refusals) {
		each(`refused, with its exact line: ${label}`, async (bash) => {
			const setup = await build(bash);
			const res = resolveVia(bash, setup.install, { stubs: setup.stubs, env: setup.env });
			const candidate = `${setup.install.replace(/\/$/, "")}/bin/bun`;
			expect(res.out.split("\n")[0]).toBe(refusal(bash, candidate, reason, res.env));
			expect(res.out).toContain("NEEDS=1");
		});
	}

	each("a relative path is refused", async (bash) => {
		const t = scratch("rel");
		mkdirSync(join(t, "rel", "bin"), { recursive: true });
		await fakeBun(join(t, "rel", "bin"), "1.3.12");
		const res = inBlocks(
			bash,
			`cd "${t}"\nap_resolve_bun "$HOME/.agentpulse/bun"; echo "NEEDS=$BUN_NEEDS_INSTALL"`,
			pathOf(),
			{ BUN_INSTALL: "rel" },
		);
		expect(res.out.split("\n")).toEqual([
			refusal(bash, "rel/bin/bun", MESSAGES.reason.notAbsolute, res.env),
			"NEEDS=1",
		]);
	});

	describe("wide mode (the relay's own paths)", () => {
		const wide = (bash: string, p: string, path = pathOf()) =>
			inBlocks(
				bash,
				'if ap_bun_acceptable "$1" wide; then echo "yes"; else echo "no: $AP_REASON"; fi',
				path,
				{},
				[p],
			).out;
		// Each row is a shell expression for the path, so exact bytes need no JS string.
		const reasonRows: Array<[string, string, string, boolean]> = [
			["%", "'/x/a%b/bin/bun'", MESSAGES.reason.badChars, false],
			["$", "'/x/a$b/bin/bun'", MESSAGES.reason.badChars, false],
			['"', `'/x/a"b/bin/bun'`, MESSAGES.reason.badChars, false],
			["a backslash", "'/x/a\\b/bin/bun'", MESSAGES.reason.badChars, false],
			["a control character", `"/x/a$(printf '\\t')b/bin/bun"`, MESSAGES.reason.badChars, false],
			["a lone \\xff", `"/x/a$(printf '\\377')b/bin/bun"`, MESSAGES.reason.notUtf8, true],
			["U+0085", `"/x/a$(printf '\\302\\205')b/bin/bun"`, MESSAGES.reason.controls, true],
		];
		for (const [label, pathExpr, reason, needsIconv] of reasonRows) {
			each(
				`refused: ${label}`,
				(bash) => {
					const out = inBlocks(
						bash,
						`p=${pathExpr}\nif ap_bun_acceptable "$p" wide; then echo yes; else echo "no: $AP_REASON"; fi`,
						pathOf(),
					).out;
					expect(out).toBe(`no: ${reason}`);
				},
				needsIconv && !HAS_ICONV ? "iconv isn't installed here" : undefined,
			);
		}

		each(
			"accepted: a space and a valid UTF-8 é in the directory name",
			async (bash) => {
				for (const name of ["my home", "hömé"]) {
					const base = join(scratch("wide"), name);
					mkdirSync(join(base, "bin"), { recursive: true });
					const file = await fakeBun(join(base, "bin"), "1.3.12");
					chmodSync(join(base, "bin"), 0o755);
					expect(wide(bash, file)).toBe("yes");
				}
			},
			HAS_ICONV ? undefined : "iconv isn't installed here",
		);

		each("refused: é with no iconv on PATH", (bash) => {
			const noIconv = stubDir(
				BASE_TOOLS.filter((t) => t !== "iconv"),
				STD_STUBS(),
				root,
			);
			expect(wide(bash, "/x/hömé/bin/bun", noIconv)).toBe(`no: ${MESSAGES.reason.noIconv}`);
		});
	});

	describe("ap_resolve_bun: the order", () => {
		const resolveWith = (
			bash: string,
			o: { home: string; installEnv?: string; pathDirs?: string[] },
		) =>
			inBlocks(
				bash,
				'ap_resolve_bun "$HOME/.agentpulse/bun"; echo "BIN=$BUN_BIN NEEDS=$BUN_NEEDS_INSTALL DIR=$BUN_DIR"',
				`${pathOf()}${(o.pathDirs ?? []).map((d) => `:${d}`).join("")}`,
				{ HOME: o.home, ...(o.installEnv ? { BUN_INSTALL: o.installEnv } : {}) },
			);

		each("~/.bun beats PATH, and PATH beats the private copy", async (bash) => {
			const home = scratch("order");
			const dotBun = await fakeBun(join(home, ".bun", "bin"), "1.3.12");
			const onPath = await bunUnder("onpath");
			const priv = await fakeBun(join(home, ".agentpulse", "bun", "bin"), "1.3.12");
			expect(resolveWith(bash, { home, pathDirs: [onPath.bin] }).out).toContain(`BIN=${dotBun} `);
			rmSync(join(home, ".bun"), { recursive: true });
			expect(resolveWith(bash, { home, pathDirs: [onPath.bin] }).out).toContain(
				`BIN=${onPath.file} `,
			);
			expect(resolveWith(bash, { home }).out).toContain(`BIN=${priv} `);
		});

		each("a set BUN_INSTALL replaces ~/.bun", async (bash) => {
			const home = scratch("order");
			await fakeBun(join(home, ".bun", "bin"), "1.3.12");
			const chosen = await bunUnder("installed");
			expect(resolveWith(bash, { home, installEnv: chosen.base }).out).toContain(
				`BIN=${chosen.file} `,
			);
			const empty = scratch("empty-install");
			const out = resolveWith(bash, { home, installEnv: empty }).out;
			expect(out).toBe(
				`BIN=${join(home, ".agentpulse", "bun", "bin", "bun")} NEEDS=1 DIR=${join(home, ".agentpulse", "bun", "bin")}`,
			);
		});

		each("a candidate reached twice is judged and reported once", async (bash) => {
			const home = scratch("order");
			const old = await fakeBun(join(home, ".bun", "bin"), "1.1.30");
			const res = resolveWith(bash, { home, pathDirs: [join(home, ".bun", "bin")] });
			const lines = res.out.split("\n");
			expect(lines).toEqual([
				refusal(bash, old, MESSAGES.reason.older("1.1.30"), res.env),
				`BIN=${join(home, ".agentpulse", "bun", "bin", "bun")} NEEDS=1 DIR=${join(home, ".agentpulse", "bun", "bin")}`,
			]);
		});

		each("with nothing usable it asks for an install at the private path", (bash) => {
			const home = scratch("order");
			const res = resolveWith(bash, { home });
			expect(res.out).toBe(
				`BIN=${join(home, ".agentpulse", "bun", "bin", "bun")} NEEDS=1 DIR=${join(home, ".agentpulse", "bun", "bin")}`,
			);
		});
	});

	describe("ap_check_bun_target", () => {
		const check = (bash: string, p: string, stubs?: Record<string, string>) =>
			inBlocks(
				bash,
				'if ap_check_bun_target "$1"; then echo ok; else echo refused; fi',
				pathOf([], stubs),
				{},
				[p],
			);

		each("accepts a path under a directory you own", (bash) => {
			const res = check(bash, `${scratch("ok")}/new/bin/bun`);
			expect([res.out, res.err]).toEqual(["ok", ""]);
		});
		for (const [label, p, reason] of [
			["a relative path", "rel/bin/bun", MESSAGES.reason.notAbsolute],
			["a space", "/x/a b/bin/bun", MESSAGES.reason.badChars],
			["%", "/x/a%b/bin/bun", MESSAGES.reason.badChars],
		] as const) {
			each(`refuses ${label}`, (bash) => {
				const res = check(bash, p);
				expect(res.out).toBe("refused");
				expect(res.err).toContain(MESSAGES.targetBad(shellQuote(bash, p, res.env), reason));
			});
		}
		each("refuses a world-writable nearest ancestor", (bash) => {
			const anc = scratch("ww");
			chmodSync(anc, 0o777);
			const p = `${anc}/new/bin/bun`;
			const res = check(bash, p);
			expect(res.out).toBe("refused");
			expect(res.err).toContain(
				MESSAGES.targetDirBad(
					shellQuote(bash, p, res.env),
					MESSAGES.reason.worldWritable,
					shellQuote(bash, anc, res.env),
				),
			);
		});
		each("refuses a nearest ancestor owned by someone else", (bash) => {
			const anc = scratch("foreign");
			const p = `${anc}/new/bin/bun`;
			const res = check(bash, p, { ls: lsStub((process.getuid?.() ?? 0) + 4242, 20, anc) });
			expect(res.out).toBe("refused");
			expect(res.err).toContain(
				MESSAGES.targetDirBad(
					shellQuote(bash, p, res.env),
					MESSAGES.reason.notOwned,
					shellQuote(bash, anc, res.env),
				),
			);
		});
	});
});

describe("ap_tighten_dir", () => {
	const me = process.getuid?.() ?? 0;
	const tighten = (bash: string, dir: string, stubs?: Record<string, string>) =>
		inBlocks(bash, 'ap_tighten_dir "$1"; echo "rc=$?"', pathOf([], stubs), {}, [dir]);
	const mode = (p: string) => statSync(p).mode & 0o777;

	each("removes group and other write from a directory you own, and nothing else", (bash) => {
		for (const [start, want] of [
			[0o775, 0o755],
			[0o777, 0o755],
			[0o700, 0o700],
			[0o755, 0o755],
		] as const) {
			const dir = scratch("tighten");
			chmodSync(dir, start);
			expect(tighten(bash, dir).out).toBe("rc=0");
			expect(mode(dir)).toBe(want);
		}
	});

	each("leaves a directory owned by someone else alone, and a missing one", (bash) => {
		const dir = scratch("tighten");
		chmodSync(dir, 0o775);
		expect(tighten(bash, dir, { ls: lsStub(me + 4242, 20, dir) }).out).toBe("rc=0");
		expect(mode(dir)).toBe(0o775);
		expect(tighten(bash, join(dir, "missing")).out).toBe("rc=0");
	});
});

describe("ap_install_hint", () => {
	const MANAGERS = ["apt-get", "dnf", "yum", "zypper", "pacman", "apk", "brew"];
	const hint = (
		bash: string,
		o: { managers: string[]; os?: string; uid?: string; tools?: string[] },
	) =>
		inBlocks(
			bash,
			'ap_install_hint "$@"; echo "rc=$?"',
			pathOf([], Object.fromEntries(o.managers.map((m) => [m, "exit 0"]))),
			{ AP_TEST_S: o.os ?? "Linux", AP_TEST_UID: o.uid ?? "1000" },
			o.tools ?? ["python3", "unzip"],
		).out;

	const expected: Array<[string, string]> = [
		["apt-get", "sudo apt-get update && sudo apt-get install -y python3 unzip"],
		["dnf", "sudo dnf install -y python3 unzip"],
		["yum", "sudo yum install -y python3 unzip"],
		["zypper", "sudo zypper install -y python3 unzip"],
		["pacman", "sudo pacman -S --needed python unzip"],
		["apk", "sudo apk add python3 unzip"],
		["brew", "brew install python unzip"],
	];
	for (const [manager, command] of expected) {
		each(`${manager} gives ${command}`, (bash) => {
			expect(hint(bash, { managers: [manager] })).toBe(`${command}\nrc=0`);
		});
	}
	each("apt-get and brew on Linux give apt-get", (bash) => {
		expect(hint(bash, { managers: ["apt-get", "brew"] })).toContain("sudo apt-get update");
	});
	each("Darwin gives brew, whatever else is installed", (bash) => {
		expect(hint(bash, { managers: ["apt-get", "brew"], os: "Darwin" })).toBe(
			"brew install python unzip\nrc=0",
		);
	});
	each("dnf and yum give dnf", (bash) => {
		expect(hint(bash, { managers: ["yum", "dnf"] })).toBe(
			"sudo dnf install -y python3 unzip\nrc=0",
		);
	});
	each("sha256sum is the coreutils package, and several tools share one command", (bash) => {
		expect(hint(bash, { managers: ["dnf"], tools: ["python3", "sha256sum", "unzip"] })).toBe(
			"sudo dnf install -y python3 coreutils unzip\nrc=0",
		);
	});
	each("root gets no sudo, and brew never does", (bash) => {
		expect(hint(bash, { managers: ["apt-get"], uid: "0" })).toBe(
			"apt-get update && apt-get install -y python3 unzip\nrc=0",
		);
		expect(hint(bash, { managers: ["brew"], uid: "1000" })).toBe("brew install python unzip\nrc=0");
	});
	each("no manager gives nothing and exits 0", (bash) => {
		expect(hint(bash, { managers: [] })).toBe("rc=0");
		expect(hint(bash, { managers: [], os: "Darwin" })).toBe("rc=0");
		expect(MANAGERS.length).toBe(7);
	});
});
