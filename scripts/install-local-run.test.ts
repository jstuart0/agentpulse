/**
 * scripts/install-local.sh, run whole: the prerequisite check that names a
 * missing tool before anything is written (issue #38: on Fedora, with no
 * unzip, the old installer stopped silently at "Installing Bun..."), the
 * pinned and checksummed Bun download, BUN_INSTALL, the argument and path
 * validation, the overlap check, the private directory modes, and the
 * `{ ... }` wrapper plus `</dev/null` that keep `curl | bash` safe.
 *
 * Every case runs the REAL script in a subprocess under each bash named in
 * its row, with an explicit minimal environment: a PATH built from symlinks to
 * the real tools plus stubs (git, curl, systemctl, launchctl, a fake bun),
 * and a throwaway HOME and TMPDIR. Nothing on the developer's machine decides
 * a result. The stubs log every call to AP_STUB_LOG together with how many
 * bytes of stdin the call could read, which is how the `</dev/null` rule is
 * proved: the script arrives on stdin followed by padding, and a child that
 * wasn't given /dev/null would eat some of it.
 *
 * Service-file privacy and restart-on-rerun are the next phase and aren't here.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BASHES,
	BASH_3_2,
	HAS_ICONV,
	MESSAGES,
	extractMarkerBlock,
	fn,
	lsStub,
	makeFakeBunZip,
	run,
	shellQuote,
	spawnChecked,
	stubDir,
} from "./lib/installer-test-utils.ts";

// Each case starts a real installer in a subprocess; leave room for a loaded machine (AGEN-18).
setDefaultTimeout(60_000);

const SCRIPT = join(import.meta.dir, "install-local.sh");
const SOURCE = readFileSync(SCRIPT, "utf-8");
const BUN_BLOCK = extractMarkerBlock(SOURCE, "agentpulse-bun", {
	minLines: 200,
	sentinel: "ap_install_pinned_bun() {",
});

const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-install-local-run-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;
function fresh(label: string, mode = 0o755): string {
	counter += 1;
	const dir = join(root, `${label}-${counter}`);
	mkdirSync(dir, { recursive: true });
	chmodSync(dir, mode);
	return dir;
}

const MATRIX = [...BASHES, ...(BASH_3_2.skip ? [BASH_3_2] : [])];
/** One case under every bash; an unavailable one is skipped under its own name. */
function each(name: string, body: (bash: string) => void | Promise<void>) {
	for (const m of MATRIX) {
		if (m.skip) test.skip(`${m.skip}: ${name}`, () => {});
		else test(`${m.label}: ${name}`, () => body(m.bash));
	}
}
const MAIN = BASHES[0].bash;
/** One case under the bash on PATH only, for rows whose subject isn't bash-specific. */
const once = (name: string, body: (bash: string) => void | Promise<void>) =>
	test(`${BASHES[0].label}: ${name}`, () => body(MAIN));

const HAS_PLISTLIB = spawnChecked(["python3", "-I", "-c", "import plistlib"]).exitCode === 0;
const onlyWithPlistlib = HAS_PLISTLIB ? test : test.skip.bind(test);
const plistName = (name: string) => (HAS_PLISTLIB ? name : `python3 plistlib unavailable: ${name}`);
const HAS_UNZIP = Bun.which("unzip") !== null;
const withUnzip = HAS_UNZIP ? each : skippedEach;
function skippedEach(name: string) {
	test.skip(`unzip unavailable here: ${name}`, () => {});
}

// ── the PATH and environment a case runs under ──

const CORE_TOOLS = [
	"awk",
	"basename",
	"cat",
	"chmod",
	"cp",
	"dirname",
	"env",
	"grep",
	"head",
	"id",
	...(HAS_ICONV ? ["iconv"] : []),
	"ls",
	"mkdir",
	"mktemp",
	"mv",
	"readlink",
	"rm",
	"sed",
	"seq",
	"sleep",
	"tr",
	"wc",
];
const SHA_TOOL = Bun.which("shasum") ? "shasum" : "sha256sum";
const real = (tool: string) => {
	const path = Bun.which(tool);
	if (!path) throw new Error(`${tool} isn't available here`);
	return path;
};

/** A stub that logs its call and how many bytes of stdin it could read, then exits 0. */
const loggingStub = (name: string, extra = "") =>
	[
		"n=$(cat | wc -c | tr -d ' ')",
		`echo "${name} $* stdin=$n" >> "$AP_STUB_LOG"`,
		extra,
		"exit 0",
	].join("\n");

const CURL_STUB = [
	'echo "curl $*" >> "$AP_STUB_LOG"',
	'url=""; out=""; prev=""',
	'for a in "$@"; do',
	'  if [ "$prev" = "-o" ]; then out="$a"; fi',
	'  case "$a" in http://*|https://*|file://*) url="$a" ;; esac',
	'  prev="$a"',
	"done",
	'case "$url" in',
	"  */api/v1/health) exit 0 ;;",
	"  https://github.com/oven-sh/bun/releases/*)",
	// The mode ~/.agentpulse has at the moment Bun is requested, before the install has had a chance to fix it.
	'    ls -ldn "$HOME/.agentpulse" > "$AP_STUB_LOG.at-fetch" 2>&1',
	// A test hook: something appears at the install directory while Bun is being fetched.
	'    if [ -n "${AP_RACE_DIR-}" ]; then mkdir -p "$AP_RACE_DIR"; echo mine > "$AP_RACE_DIR/notes.txt"; fi',
	'    if [ -n "${AP_FAKE_ZIP-}" ] && [ -n "$out" ]; then cp "$AP_FAKE_ZIP" "$out"; exit 0; fi',
	'    echo "curl blocked $url" >> "$AP_STUB_LOG"; exit 7 ;;',
	"  *)",
	'    echo "curl blocked $url" >> "$AP_STUB_LOG"; exit 7 ;;',
	"esac",
].join("\n");

type PathOpts = {
	unzip?: boolean;
	python3?: boolean;
	git?: boolean;
	sha?: boolean;
	/** Directories put in front of the stub directory (a Bun, a managers' bin). */
	prefix?: string[];
	stubs?: Record<string, string>;
};
const stubDirs = new Map<string, string>();
/**
 * The PATH for a case. The stub directory depends only on the options, so each
 * distinct one is built once: a freshly written executable costs a slow first
 * run on some machines, and rebuilding the same stubs per case multiplied it.
 */
function mkPath(o: PathOpts = {}): string {
	const { prefix, ...rest } = o;
	const key = JSON.stringify(rest);
	let dir = stubDirs.get(key);
	if (!dir) {
		dir = buildStubDir(rest);
		stubDirs.set(key, dir);
	}
	return [...(prefix ?? []), dir].join(":");
}
function buildStubDir(o: Omit<PathOpts, "prefix">): string {
	const tools = [
		...CORE_TOOLS,
		...(o.unzip === false ? [] : ["unzip"]),
		...(o.python3 === false ? [] : ["python3"]),
		...(o.sha === false ? [] : [SHA_TOOL]),
	];
	const stubs: Record<string, string> = {
		uname: `case "\${1-}" in -m) echo "$AP_TEST_M" ;; *) echo "$AP_TEST_S" ;; esac`,
		sysctl: "exit 0",
		curl: CURL_STUB,
		systemctl: loggingStub("systemctl"),
		launchctl: loggingStub("launchctl"),
		...(o.git === false
			? {}
			: {
					git: loggingStub(
						"git",
						'echo "$(umask)" >> "$AP_STUB_LOG.git-umask"; if [ "${1-}" = clone ]; then for a in "$@"; do d="$a"; done; mkdir -p "$d/src/deep"; echo \'{"name":"agentpulse"}\' > "$d/package.json"; echo x > "$d/src/deep/a.ts"; fi',
					),
				}),
		...o.stubs,
	};
	return stubDir(tools, stubs, root);
}
/** What `sudo ` prefix the hint carries for the user running the suite (none when that is root). */
const SUDO = (process.getuid?.() ?? 1) === 0 ? "" : "sudo ";
const idStub = (uid: number) =>
	`if [ "\${1-}" = "-u" ]; then echo ${uid}; else exec "${real("id")}" "$@"; fi`;

/** `<prefix>/bin/bun`, a fake that answers --version and logs everything else. Dirs and file are 755. */
function installBun(prefix: string, version = "1.3.12"): string {
	mkdirSync(join(prefix, "bin"), { recursive: true });
	chmodSync(prefix, 0o755);
	chmodSync(join(prefix, "bin"), 0o755);
	const file = join(prefix, "bin", "bun");
	writeFileSync(
		file,
		[
			"#!/bin/sh",
			`case "\${1-}" in --version) echo "${version}"; exit 0 ;; esac`,
			"n=$(cat | wc -c | tr -d ' ')",
			'echo "$0 $* stdin=$n" >> "$AP_STUB_LOG"',
			'case "$*" in "run start"|"run supervisor") echo "ENV $2 PUBLIC_URL=$PUBLIC_URL HOST=$HOST PATH=$PATH" >> "$AP_STUB_LOG" ;; esac',
			// What a real install and build leave in the checkout, written under the caller's umask.
			'case "$*" in install) mkdir -p node_modules/.bin; echo x > node_modules/.bin/f ;; "run build") mkdir -p dist; echo x > dist/f ;; esac',
			"exit 0",
			"",
		].join("\n"),
	);
	chmodSync(file, 0o755);
	return file;
}

type Opts = {
	path: string;
	home?: string;
	env?: Record<string, string>;
	/** Pipe the script in (`bash -s -- args`) instead of running it as a file. */
	stdin?: string;
	script?: string;
	umask?: string;
	uname?: "Linux" | "Darwin" | "FreeBSD";
	arch?: string;
};
type Result = {
	code: number | null;
	stdout: string;
	stderr: string;
	log: string;
	logFile: string;
	/** `ls -ldn ~/.agentpulse` as it was when the Bun release was requested; "" if it never was. */
	atFetch: string;
	home: string;
	tmp: string;
};
function go(bash: string, args: string[], o: Opts): Result {
	const home = o.home ?? fresh("home");
	const tmp = fresh("tmp");
	const logFile = join(fresh("log"), "stub.log");
	writeFileSync(logFile, "");
	const uname = o.uname ?? "Linux";
	const env: Record<string, string> = {
		PATH: o.path,
		HOME: home,
		TMPDIR: tmp,
		AP_STUB_LOG: logFile,
		AP_TEST_S: uname,
		AP_TEST_M: o.arch ?? (uname === "Darwin" ? "arm64" : "x86_64"),
		PYTHONDONTWRITEBYTECODE: "1",
		...o.env,
	};
	const bashPath = Bun.which(bash) ?? bash;
	const argv =
		o.stdin !== undefined
			? [bashPath, "-s", "--", ...args]
			: [bashPath, o.script ?? SCRIPT, ...args];
	const cmd = o.umask
		? ["/bin/sh", "-c", 'umask "$1"; shift; exec "$@"', "sh", o.umask, ...argv]
		: argv;
	const proc = spawnChecked(cmd, {
		env,
		cwd: home,
		...(o.stdin !== undefined ? { stdin: Buffer.from(o.stdin) } : {}),
	});
	return {
		code: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
		log: readFileSync(logFile, "utf-8"),
		logFile,
		atFetch: existsSync(`${logFile}.at-fetch`) ? readFileSync(`${logFile}.at-fetch`, "utf-8") : "",
		home,
		tmp,
	};
}

const q = (bash: string, value: string) => shellQuote(bash, value);
/** The arguments a run that goes all the way needs: no hooks, no service manager. */
const PLAIN = ["--skip-hooks", "--service", "none"];
const BANNER = "AgentPulse Local Install";
const list = (dir: string) => readdirSync(dir).sort();
const modeOf = (p: string) => statSync(p).mode & 0o777;

function plistJson(file: string): {
	ProgramArguments: string[];
	EnvironmentVariables: Record<string, string>;
} {
	const proc = spawnChecked([
		"python3",
		"-I",
		"-c",
		"import json, plistlib, sys\nprint(json.dumps(plistlib.load(open(sys.argv[1], 'rb'))))",
		file,
	]);
	expect(proc.exitCode).toBe(0);
	return JSON.parse(proc.stdout.toString());
}
const unitFile = (home: string, name = "agentpulse") =>
	join(home, ".config", "systemd", "user", `${name}.service`);
const plistFile = (home: string, name = "local") =>
	join(home, "Library", "LaunchAgents", `dev.agentpulse.${name}.plist`);

/** The pinned asset this installer would pick under the stubbed uname. */
function assetFor(uname: string, arch: string): string {
	const out = run("bash", `${BUN_BLOCK}\nap_bun_asset`, [], {
		PATH: mkPath(),
		HOME: fresh("asset-home"),
		AP_TEST_S: uname,
		AP_TEST_M: arch,
	}).out;
	expect(out).not.toBe("");
	return out;
}
const releaseUrl = (asset: string) =>
	`https://github.com/oven-sh/bun/releases/download/bun-v1.3.12/bun-${asset}.zip`;

type FakeRelease = { zip: string; script: string; asset: string };
const releases = new Map<string, FakeRelease>();
/**
 * A fake Bun release zip for this host's asset, and a copy of the installer
 * whose pinned hash for that asset is the zip's (the only line that differs).
 * The negative control runs the unmodified script against the same zip.
 */
function fakeRelease(uname: "Linux" | "Darwin"): FakeRelease {
	const cached = releases.get(uname);
	if (cached) return cached;
	const asset = assetFor(uname, uname === "Darwin" ? "arm64" : "x86_64");
	const dir = fresh(`fake-release-${uname}`);
	const { zip, sha } = makeFakeBunZip(dir, asset);
	const lines = SOURCE.split("\n");
	const pinned = lines.filter((l) => l.startsWith(`    ${asset}) echo "`));
	expect(pinned).toHaveLength(1);
	const modified = lines.map((l) => (l === pinned[0] ? `    ${asset}) echo "${sha}" ;;` : l));
	expect(modified.filter((l, i) => l !== lines[i])).toHaveLength(1);
	const script = join(dir, "install-local.sh");
	writeFileSync(script, modified.join("\n"));
	const release = { zip, script, asset };
	releases.set(uname, release);
	return release;
}

// ── prerequisites: the failure this change exists for ──

describe("prerequisites are checked, named and refused before anything is written", () => {
	// These run as the real user, so the sandbox HOME really is theirs and the run gets as far
	// as it would on a real machine; a refusal that came from anywhere else would leave files.
	each(
		"W1: no Bun and no unzip: the missing block with the package-manager command, nothing written",
		(bash) => {
			const r = go(bash, PLAIN, { path: mkPath({ unzip: false, stubs: { dnf: "exit 0" } }) });
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.missing(["unzip"], `${SUDO}dnf install -y unzip`));
			expect(r.stderr).not.toContain("python3");
			expect(list(r.home)).toEqual([]);
			expect(r.log).toBe("");
		},
	);

	each("W1 as a non-root user: the hint carries sudo whichever uid runs the suite", (bash) => {
		const home = fresh("home");
		const r = go(bash, PLAIN, {
			home,
			path: mkPath({
				unzip: false,
				stubs: { dnf: "exit 0", id: idStub(1000), ls: lsStub(1000, 1000, home) },
			}),
		});
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(MESSAGES.missing(["unzip"], "sudo dnf install -y unzip"));
		expect(list(r.home)).toEqual([]);
	});

	each("the Fedora case: python3 and unzip both missing, as root, so no sudo", (bash) => {
		// `id` says root, so the sandbox HOME is made to look root-owned too, as it is for a real root.
		const home = fresh("home");
		const r = go(bash, PLAIN, {
			home,
			path: mkPath({
				unzip: false,
				python3: false,
				stubs: { dnf: "exit 0", id: idStub(0), ls: lsStub(0, 0, home) },
			}),
		});
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(
			MESSAGES.missing(["python3", "unzip"], "dnf install -y python3 unzip"),
		);
		expect(list(r.home)).toEqual([]);
		expect(r.log).toBe("");
	});

	once("everything missing is listed together, in curl-git-python3-tools order", (bash) => {
		const r = go(bash, PLAIN, {
			path: mkPath({ git: false, python3: false, unzip: false, stubs: { dnf: "exit 0" } }),
		});
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(
			MESSAGES.missing(["git", "python3", "unzip"], `${SUDO}dnf install -y git python3 unzip`),
		);
		expect(list(r.home)).toEqual([]);
		expect(r.log).toBe("");
	});

	once("with no package manager the message says to use the system's", (bash) => {
		const r = go(bash, PLAIN, { path: mkPath({ unzip: false }) });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(MESSAGES.missing(["unzip"], null));
		expect(list(r.home)).toEqual([]);
	});

	once("a platform with no pinned Bun release is refused by name", (bash) => {
		const r = go(bash, PLAIN, { path: mkPath(), uname: "FreeBSD", arch: "amd64" });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(MESSAGES.noAsset("FreeBSD", "amd64"));
		expect(list(r.home)).toEqual([]);
		expect(r.log).toBe("");
	});

	once("a usable Bun means unzip isn't needed", (bash) => {
		const bunx = fresh("bunx");
		installBun(bunx);
		const r = go(bash, [...PLAIN, "--skip-supervisor"], {
			path: mkPath({ unzip: false }),
			env: { BUN_INSTALL: bunx },
		});
		expect(r.code).toBe(0);
		expect(r.stderr).toBe("");
	});

	describe("python3 is needed only when something will use it (W8)", () => {
		const noPython = () => mkPath({ python3: false });
		const bunHome = () => {
			const bunx = fresh("bunx");
			installBun(bunx);
			return { BUN_INSTALL: bunx };
		};
		once("the defaults configure the supervisor and hooks: refused", (bash) => {
			const r = go(bash, ["--service", "none"], { path: noPython(), env: bunHome() });
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.missing(["python3"], null));
		});
		once("--skip-supervisor alone still leaves the hooks: refused", (bash) => {
			const r = go(bash, ["--service", "none", "--skip-supervisor"], {
				path: noPython(),
				env: bunHome(),
			});
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.missing(["python3"], null));
		});
		once("both skips: completes", (bash) => {
			const r = go(bash, [...PLAIN, "--skip-supervisor"], { path: noPython(), env: bunHome() });
			expect(r.code).toBe(0);
		});
		each("auth on with a key still configures the supervisor: refused without python3", (bash) => {
			const r = go(bash, ["--service", "none", "--disable-auth", "false", "--api-key", "ap_x"], {
				path: noPython(),
				env: bunHome(),
			});
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.missing(["python3"], null));
		});
		once("auth on with no key skips both, so python3 isn't needed", (bash) => {
			const r = go(bash, [...PLAIN, "--disable-auth", "false"], {
				path: noPython(),
				env: bunHome(),
			});
			expect(r.code).toBe(0);
			expect(r.stdout).toContain("Skipping supervisor auto-install");
		});
	});
});

// ── which Bun, and where it goes ──

describe("the Bun the installer uses", () => {
	each("W2: BUN_INSTALL is honored everywhere Bun is run, even when it isn't on PATH", (bash) => {
		const bunx = fresh("bunx");
		const bun = installBun(bunx);
		const r = go(bash, ["--skip-hooks", "--service", "systemd"], {
			path: mkPath(),
			env: { BUN_INSTALL: bunx },
		});
		expect(r.code).toBe(0);
		expect(r.stdout).toContain(`  ✓ Bun: ${bun} (1.3.12)`);
		expect(r.log).toContain(`${bun} install stdin=0`);
		expect(r.log).toContain(`${bun} run build stdin=0`);
		const unit = readFileSync(unitFile(r.home), "utf-8");
		expect(unit).toContain(`\nExecStart=${bun} run start\n`);
		expect(unit).toContain(`\nEnvironment=PATH=${bunx}/bin:`);
		const supervisor = readFileSync(unitFile(r.home, "agentpulse-supervisor"), "utf-8");
		expect(supervisor).toContain(`\nExecStart=${bun} run supervisor\n`);
		expect(supervisor).toContain(`\nEnvironment=PATH=${bunx}/bin:`);
		expect(r.stdout + r.log).not.toContain("bun.sh");
	});

	for (const uname of ["Linux", "Darwin"] as const) {
		once(`W3 (${uname}): a Bun already at ~/.bun is used and written exactly as before`, (bash) => {
			const home = fresh("home");
			const bun = installBun(join(home, ".bun"));
			const r = go(
				bash,
				["--skip-hooks", "--service", uname === "Darwin" ? "launchd" : "systemd"],
				{
					path: mkPath(),
					home,
					uname,
				},
			);
			expect(r.code).toBe(0);
			expect(r.stdout).toContain(`  ✓ Bun: ${bun} (1.3.12)`);
			if (uname === "Linux") {
				const unit = readFileSync(unitFile(home), "utf-8");
				expect(unit).toContain(`\nExecStart=${home}/.bun/bin/bun run start\n`);
				expect(unit).toContain(`\nEnvironment=PATH=${home}/.bun/bin:/opt/homebrew/bin:`);
			}
		});
	}

	onlyWithPlistlib(plistName("W3 (Darwin): the plist runs the ~/.bun Bun"), () => {
		const home = fresh("home");
		const bun = installBun(join(home, ".bun"));
		const r = go(MAIN, ["--skip-hooks", "--service", "launchd"], {
			path: mkPath(),
			home,
			uname: "Darwin",
		});
		expect(r.code).toBe(0);
		const plist = plistJson(plistFile(home));
		expect(plist.ProgramArguments).toEqual([bun, "run", "start"]);
		expect(plist.EnvironmentVariables.PATH.startsWith(`${home}/.bun/bin:`)).toBe(true);
		expect(r.log).toContain("launchctl load");
	});

	each("W10: a BUN_INSTALL Bun that is too old is refused and left as it was", (bash) => {
		const old = fresh("old");
		const bun = installBun(old, "1.3.11");
		const before = readFileSync(bun, "utf-8");
		const r = go(bash, PLAIN, { path: mkPath(), env: { BUN_INSTALL: old } });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(
			MESSAGES.bunInstallBad(q(bash, bun), MESSAGES.reason.older("1.3.11")),
		);
		expect(readFileSync(bun, "utf-8")).toBe(before);
		expect(r.log).toBe("");
	});

	describe("W11: a BUN_INSTALL target that can't be written to is refused before any download", () => {
		const rows = [
			{ name: "relative", value: () => "rel/x", reason: MESSAGES.reason.notAbsolute },
			{ name: "space", value: (t: string) => `${t}/b x`, reason: MESSAGES.reason.badChars },
			{ name: "percent", value: (t: string) => `${t}/b%x`, reason: MESSAGES.reason.badChars },
		];
		for (const row of rows) {
			each(row.name, (bash) => {
				const value = row.value(fresh("b"));
				const r = go(bash, PLAIN, { path: mkPath(), env: { BUN_INSTALL: value } });
				expect(r.code).toBe(1);
				expect(r.stderr).toContain(MESSAGES.targetBad(q(bash, `${value}/bin/bun`), row.reason));
				expect(r.log).toBe("");
				expect(list(r.home)).toEqual([]);
			});
		}
	});

	each(
		"a Bun that is the wrong version on PATH is reported, then the download is attempted (W9)",
		(bash) => {
			const old = fresh("old");
			const bun = installBun(old, "1.1.30");
			const asset = assetFor("Linux", "x86_64");
			const r = go(bash, ["--skip-hooks", "--service", "systemd"], {
				path: mkPath({ prefix: [join(old, "bin")] }),
			});
			expect(r.code).toBe(1);
			expect(r.stdout).toContain(MESSAGES.notUsing(q(bash, bun), MESSAGES.reason.older("1.1.30")));
			expect(r.stderr).toContain(MESSAGES.fetch.download(releaseUrl(asset)));
			expect(existsSync(join(r.home, ".config"))).toBe(false);
			expect(existsSync(join(r.home, ".agentpulse", "bun", "bin", "bun"))).toBe(false);
			expect(readdirSync(r.tmp).filter((f) => f.startsWith("agentpulse-install."))).toEqual([]);
		},
	);
});

// ── the pinned download ──

describe("a first run downloads the pinned Bun, checks it, and uses it", () => {
	for (const uname of ["Linux", "Darwin"] as const) {
		withUnzip(`W12 (${uname}): installs into ~/.agentpulse/bun and the service runs it`, (bash) => {
			const rel = fakeRelease(uname);
			const service = uname === "Darwin" ? "launchd" : "systemd";
			const r = go(bash, ["--skip-hooks", "--skip-supervisor", "--service", service], {
				path: mkPath(),
				script: rel.script,
				uname,
				env: { AP_FAKE_ZIP: rel.zip },
			});
			const bin = join(r.home, ".agentpulse", "bun", "bin");
			expect(r.code).toBe(0);
			expect(r.stdout).toContain(`  Installing Bun 1.3.12 into ${bin}...`);
			expect(r.stdout).toContain(`  ✓ Bun: ${bin}/bun (1.3.12)`);
			expect(r.log).toContain(
				`curl -q --proto =https --proto-redir =https -fsSL ${releaseUrl(rel.asset)} -o `,
			);
			if (uname === "Linux") {
				expect(readFileSync(unitFile(r.home), "utf-8")).toContain(
					`\nExecStart=${bin}/bun run start\n`,
				);
			} else if (HAS_PLISTLIB) {
				expect(plistJson(plistFile(r.home)).ProgramArguments[0]).toBe(`${bin}/bun`);
			}
			expect(readdirSync(r.tmp).filter((f) => f.startsWith("agentpulse-install."))).toEqual([]);
			expect(readdirSync(bin).filter((f) => f.startsWith(".bun."))).toEqual([]);
		});
	}

	withUnzip(
		"negative control: the unmodified script refuses the same zip on its checksum",
		(bash) => {
			const rel = fakeRelease("Linux");
			const r = go(bash, PLAIN, { path: mkPath(), env: { AP_FAKE_ZIP: rel.zip } });
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.fetch.checksum);
			expect(existsSync(join(r.home, ".agentpulse", "bun", "bin", "bun"))).toBe(false);
			expect(readdirSync(r.tmp).filter((f) => f.startsWith("agentpulse-install."))).toEqual([]);
		},
	);

	withUnzip(
		"W13: under umask 002 Bun and its directories are 755 and ~/.agentpulse is 700",
		(bash) => {
			const rel = fakeRelease("Linux");
			const r = go(bash, [...PLAIN, "--skip-supervisor"], {
				path: mkPath(),
				script: rel.script,
				umask: "002",
				env: { AP_FAKE_ZIP: rel.zip },
			});
			expect(r.code).toBe(0);
			const dir = join(r.home, ".agentpulse");
			expect(r.atFetch.startsWith("drwx------")).toBe(true);
			expect(modeOf(dir)).toBe(0o700);
			expect(modeOf(join(dir, "bun"))).toBe(0o755);
			expect(modeOf(join(dir, "bun", "bin"))).toBe(0o755);
			expect(modeOf(join(dir, "bun", "bin", "bun"))).toBe(0o755);
			expect(modeOf(join(dir, "logs"))).toBe(0o700);
			expect(modeOf(join(dir, "data"))).toBe(0o700);
		},
	);

	describe("W14: a Bun in a group-writable directory on PATH", () => {
		withUnzip("on Linux it is refused, and the private pinned copy is used instead", (bash) => {
			const rel = fakeRelease("Linux");
			const dir = fresh("brewish");
			const bun = installBun(dir);
			chmodSync(join(dir, "bin"), 0o775);
			const r = go(bash, ["--skip-hooks", "--skip-supervisor", "--service", "systemd"], {
				path: mkPath({ prefix: [join(dir, "bin")] }),
				script: rel.script,
				env: { AP_FAKE_ZIP: rel.zip },
			});
			expect(r.code).toBe(0);
			expect(r.stdout).toContain(MESSAGES.notUsing(q(bash, bun), MESSAGES.reason.groupWritable));
			const priv = join(r.home, ".agentpulse", "bun", "bin", "bun");
			expect(readFileSync(unitFile(r.home), "utf-8")).toContain(`\nExecStart=${priv} run start\n`);
		});

		onlyWithPlistlib(
			plistName("on macOS a Homebrew-style 775 directory in group 80 is accepted"),
			() => {
				const dir = fresh("brewish");
				const bun = installBun(dir);
				const bin = join(dir, "bin");
				chmodSync(bin, 0o775);
				const r = go(MAIN, ["--skip-hooks", "--skip-supervisor", "--service", "launchd"], {
					path: mkPath({
						prefix: [bin],
						stubs: { ls: lsStub(process.getuid?.() ?? 0, 80, bin) },
					}),
					uname: "Darwin",
				});
				expect(r.code).toBe(0);
				expect(r.stdout).not.toContain("Not using");
				expect(plistJson(plistFile(r.home)).ProgramArguments[0]).toBe(bun);
			},
		);
	});
});

// ── arguments ──

describe("W15/W17: option values are validated before the banner", () => {
	const rows: { args: string[]; flag: string; reason: string }[] = [
		{ args: ["--port", "0"], flag: "--port", reason: MESSAGES.argReason.port },
		{ args: ["--port", "x"], flag: "--port", reason: MESSAGES.argReason.port },
		{ args: ["--port", "65536"], flag: "--port", reason: MESSAGES.argReason.port },
		{ args: ["--port", "9999999"], flag: "--port", reason: MESSAGES.argReason.port },
		{ args: ["--disable-auth", "yes"], flag: "--disable-auth", reason: MESSAGES.argReason.bool },
		{ args: ["--api-key", "a b"], flag: "--api-key", reason: MESSAGES.argReason.charset },
		{ args: ["--host", "h\u0001"], flag: "--host", reason: MESSAGES.argReason.host },
		{ args: ["--host", "a b"], flag: "--host", reason: MESSAGES.argReason.host },
		{ args: ["--host", "h$x"], flag: "--host", reason: MESSAGES.argReason.host },
		{ args: ["--host", "*"], flag: "--host", reason: MESSAGES.argReason.host },
		{ args: ["--host", "a'b\"c>"], flag: "--host", reason: MESSAGES.argReason.host },
		{ args: ["--host", "a&b"], flag: "--host", reason: MESSAGES.argReason.host },
		{ args: ["--host", "a<b"], flag: "--host", reason: MESSAGES.argReason.host },
		{ args: ["--host", "fe80::1%eth0"], flag: "--host", reason: MESSAGES.argReason.host },
		{ args: ["--host", "[::1"], flag: "--host", reason: MESSAGES.argReason.host },
		{ args: ["--host", "[zz]"], flag: "--host", reason: MESSAGES.argReason.host },
		{ args: ["--host", ""], flag: "--host", reason: MESSAGES.argReason.host },
		{ args: ["--ref", "-x"], flag: "--ref", reason: MESSAGES.argReason.ref },
		{ args: ["--ref", "a..b"], flag: "--ref", reason: MESSAGES.argReason.ref },
		{ args: ["--ref", "a b"], flag: "--ref", reason: MESSAGES.argReason.ref },
		{ args: ["--ref", "a;b"], flag: "--ref", reason: MESSAGES.argReason.ref },
		{ args: ["--ref", ""], flag: "--ref", reason: MESSAGES.argReason.ref },
		{ args: ["--repo", "ftp://h/x.git"], flag: "--repo", reason: MESSAGES.argReason.repo },
		{
			args: ["--repo", "https://u:t@h.example/x.git"],
			flag: "--repo",
			reason: MESSAGES.argReason.repoUserinfo,
		},
		{
			args: ["--repo", "https://u@h.example/x.git"],
			flag: "--repo",
			reason: MESSAGES.argReason.repoUserinfo,
		},
		{
			args: ["--repo", "https://h.example@evil.example/x.git"],
			flag: "--repo",
			reason: MESSAGES.argReason.repoUserinfo,
		},
		{
			args: ["--repo", "https://u:p@ss@h.example/x.git"],
			flag: "--repo",
			reason: MESSAGES.argReason.repoUserinfo,
		},
		{ args: ["--repo", "git@h.example:x/y.git"], flag: "--repo", reason: MESSAGES.argReason.repo },
		{ args: ["--repo", "-x"], flag: "--repo", reason: MESSAGES.argReason.repo },
		{ args: ["--repo", "--upload-pack=x"], flag: "--repo", reason: MESSAGES.argReason.needsValue },
		{ args: ["--repo", "rel/path"], flag: "--repo", reason: MESSAGES.argReason.repo },
		{ args: ["--repo", "/tmp/a b"], flag: "--repo", reason: MESSAGES.argReason.repo },
		{ args: ["--repo", "https://h/a b"], flag: "--repo", reason: MESSAGES.argReason.repo },
		{ args: ["--repo", "https://h/a\nb"], flag: "--repo", reason: MESSAGES.argReason.repo },
		{ args: ["--repo", "https://h/it's.git"], flag: "--repo", reason: MESSAGES.argReason.repo },
		{ args: ["--repo", "https://h/$x.git"], flag: "--repo", reason: MESSAGES.argReason.repo },
		{ args: ["--repo", "https://h/a;b.git"], flag: "--repo", reason: MESSAGES.argReason.repo },
		{
			args: ["--public-url", "http://h/it's"],
			flag: "--public-url",
			reason: MESSAGES.argReason.url,
		},
		{
			args: ["--public-url", "http://h/$HOME"],
			flag: "--public-url",
			reason: MESSAGES.argReason.url,
		},
		{
			args: ["--public-url", "http://h/a;b"],
			flag: "--public-url",
			reason: MESSAGES.argReason.url,
		},
		{ args: ["--public-url", "u\n"], flag: "--public-url", reason: MESSAGES.argReason.controls },
		{
			args: ["--public-url", "http://h/a b"],
			flag: "--public-url",
			reason: MESSAGES.argReason.url,
		},
		{ args: ["--public-url", "ftp://h"], flag: "--public-url", reason: MESSAGES.argReason.url },
		{ args: ["--public-url", 'http://h/"x'], flag: "--public-url", reason: MESSAGES.argReason.url },
	];
	for (const { args, flag, reason } of rows) {
		each(`${JSON.stringify(args)} is refused with the ${flag} line`, (bash) => {
			const r = go(bash, [...PLAIN, ...args], { path: mkPath() });
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.argBad(flag, reason));
			expect(r.stdout).not.toContain(BANNER);
			expect(list(r.home)).toEqual([]);
			expect(r.log).toBe("");
		});
	}

	once("a valid port, key and URL are accepted", (bash) => {
		const bunx = fresh("bunx");
		installBun(bunx);
		const r = go(
			bash,
			[
				...PLAIN,
				"--skip-supervisor",
				"--port",
				"3456",
				"--api-key",
				"ap_Abc-1.2",
				"--disable-auth",
				"false",
				"--public-url",
				"http://h.example:3456/a?b=1&c=(2)#f",
			],
			{ path: mkPath(), env: { BUN_INSTALL: bunx } },
		);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("  URL:        http://h.example:3456/a?b=1&c=(2)#f");
	});
});

// ── paths ──

describe("--dir, --data-dir and the log directory use only characters a service file can hold", () => {
	const rows = (t: string) => [
		{
			args: ["--dir", `${t}/my app`],
			what: "--dir",
			p: `${t}/my app`,
			reason: MESSAGES.pathReason.badChars,
		},
		{
			args: ["--dir", "rel/x"],
			what: "--dir",
			p: "rel/x",
			reason: MESSAGES.pathReason.notAbsolute,
		},
		{ args: ["--dir", ""], what: "--dir", p: "", reason: MESSAGES.pathReason.empty },
		{
			args: ["--dir", `${t}/a/../b`],
			what: "--dir",
			p: `${t}/a/../b`,
			reason: MESSAGES.pathReason.component,
		},
		{
			args: ["--data-dir", `${t}/d%h`],
			what: "--data-dir",
			p: `${t}/d%h`,
			reason: MESSAGES.pathReason.badChars,
		},
	];
	for (const i of [0, 1, 2, 3, 4]) {
		each(`row ${i} is refused with the path-bad line and nothing is written`, (bash) => {
			const t = fresh("t");
			const row = rows(t)[i];
			const r = go(bash, [...PLAIN, ...row.args], { path: mkPath() });
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.pathBad(row.what, q(bash, row.p), row.reason));
			expect(list(r.home)).toEqual([]);
			expect(r.log).toBe("");
		});
	}

	once("the log directory is named when HOME is the problem", (bash) => {
		const t = fresh("t");
		const home = fresh("h&x");
		const r = go(bash, [...PLAIN, "--dir", `${t}/app`, "--data-dir", `${t}/data`], {
			path: mkPath(),
			home,
		});
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(
			MESSAGES.pathBad(
				"the log directory",
				q(bash, `${home}/.agentpulse/logs`),
				MESSAGES.pathReason.badChars,
			),
		);
		expect(r.log).toBe("");
	});

	once("a trailing slash is accepted and dropped", (bash) => {
		const t = fresh("t");
		const dir = `${t}/app-1.2_x@y`;
		const bunx = fresh("bunx");
		installBun(bunx);
		const r = go(
			bash,
			["--skip-hooks", "--skip-supervisor", "--service", "systemd", "--dir", `${dir}/`],
			{
				path: mkPath(),
				env: { BUN_INSTALL: bunx },
			},
		);
		expect(r.code).toBe(0);
		expect(readFileSync(unitFile(r.home), "utf-8")).toContain(`\nWorkingDirectory=${dir}\n`);
		expect(existsSync(`${dir}/.env.local`)).toBe(true);
	});
});

describe("W7: the Bun may not live somewhere this installer deletes", () => {
	each("BUN_INSTALL inside --dir", (bash) => {
		const t = fresh("t");
		const app = `${t}/app`;
		const bun = installBun(`${app}/b`);
		writeFileSync(`${app}/marker`, "keep");
		const r = go(bash, [...PLAIN, "--dir", app, "--data-dir", `${t}/data`], {
			path: mkPath(),
			env: { BUN_INSTALL: `${app}/b` },
		});
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(MESSAGES.overlap(q(bash, bun), "--dir", q(bash, app)));
		expect(readFileSync(`${app}/marker`, "utf-8")).toBe("keep");
		expect(existsSync(bun)).toBe(true);
		expect(r.log).toBe("");
	});

	each("--data-dir set to ~/.agentpulse, where the private Bun goes", (bash) => {
		const home = fresh("home");
		mkdirSync(join(home, ".agentpulse"));
		writeFileSync(join(home, ".agentpulse", "marker"), "keep");
		const r = go(bash, [...PLAIN, "--data-dir", `${home}/.agentpulse`], { path: mkPath(), home });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(
			MESSAGES.overlap(
				q(bash, `${home}/.agentpulse/bun/bin/bun`),
				"--data-dir",
				q(bash, `${home}/.agentpulse`),
			),
		);
		expect(readFileSync(join(home, ".agentpulse", "marker"), "utf-8")).toBe("keep");
		expect(r.log).toBe("");
	});

	once("BUN_INSTALL is a symbolic link to a directory inside --dir", (bash) => {
		const t = fresh("t");
		const bun = installBun(`${t}/app/real`);
		symlinkSync(`${t}/app/real`, `${t}/via-link`);
		const r = go(bash, [...PLAIN, "--dir", `${t}/app`, "--data-dir", `${t}/data`], {
			path: mkPath(),
			env: { BUN_INSTALL: `${t}/via-link` },
		});
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(
			MESSAGES.overlap(q(bash, `${t}/via-link/bin/bun`), "--dir", q(bash, `${t}/app`)),
		);
		expect(existsSync(bun)).toBe(true);
		expect(r.log).toBe("");
	});

	once(
		"BUN_INSTALL is a link that itself lives inside --dir: the link would be deleted",
		(bash) => {
			const t = fresh("t");
			const bun = installBun(`${t}/elsewhere`);
			mkdirSync(`${t}/app`, { recursive: true });
			symlinkSync(`${t}/elsewhere`, `${t}/app/link`);
			const r = go(bash, [...PLAIN, "--dir", `${t}/app`, "--data-dir", `${t}/data`], {
				path: mkPath(),
				env: { BUN_INSTALL: `${t}/app/link` },
			});
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(
				MESSAGES.overlap(q(bash, `${t}/app/link/bin/bun`), "--dir", q(bash, `${t}/app`)),
			);
			expect(existsSync(bun)).toBe(true);
		},
	);

	for (const flag of ["--dir", "--data-dir"]) {
		once(`W7b: BUN_BIN is a symbolic link into ${flag}`, (bash) => {
			const t = fresh("t");
			const inside = flag === "--dir" ? `${t}/app` : `${t}/data`;
			const target = installBun(`${inside}/vendor`);
			mkdirSync(`${t}/b/bin`, { recursive: true });
			chmodSync(`${t}/b`, 0o755);
			chmodSync(`${t}/b/bin`, 0o755);
			symlinkSync(target, `${t}/b/bin/bun`);
			const r = go(bash, [...PLAIN, "--dir", `${t}/app`, "--data-dir", `${t}/data`], {
				path: mkPath(),
				env: { BUN_INSTALL: `${t}/b` },
			});
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.overlap(q(bash, target), flag, q(bash, inside)));
			expect(existsSync(target)).toBe(true);
			expect(r.log).toBe("");
		});
	}

	once("a Bun beside --dir, not inside it, is fine", (bash) => {
		const t = fresh("t");
		installBun(`${t}/app-bun`);
		const r = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/app`], {
			path: mkPath(),
			env: { BUN_INSTALL: `${t}/app-bun` },
		});
		expect(r.code).toBe(0);
	});
});

// ── service pre-flight ──

describe("the service directory and mode are checked before anything is written", () => {
	once("an unsupported --service mode is refused up front", (bash) => {
		const r = go(bash, ["--skip-hooks", "--service", "weird"], { path: mkPath() });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("Error: unsupported --service mode 'weird'");
		expect(list(r.home)).toEqual([]);
		expect(r.log).toBe("");
	});

	once("a symbolic-link systemd user directory is refused", (bash) => {
		const home = fresh("home");
		mkdirSync(join(home, ".config", "systemd"), { recursive: true });
		mkdirSync(join(home, "elsewhere"));
		symlinkSync(join(home, "elsewhere"), join(home, ".config", "systemd", "user"));
		const r = go(bash, ["--skip-hooks", "--service", "systemd"], { path: mkPath(), home });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(MESSAGES.unitDir(q(bash, join(home, ".config", "systemd", "user"))));
		expect(existsSync(join(home, ".agentpulse"))).toBe(false);
		expect(r.log).toBe("");
	});

	once("a symbolic-link LaunchAgents directory is refused", (bash) => {
		const home = fresh("home");
		mkdirSync(join(home, "Library"));
		mkdirSync(join(home, "elsewhere"));
		symlinkSync(join(home, "elsewhere"), join(home, "Library", "LaunchAgents"));
		const r = go(bash, ["--skip-hooks", "--service", "launchd"], {
			path: mkPath(),
			home,
			uname: "Darwin",
		});
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(MESSAGES.unitDir(q(bash, join(home, "Library", "LaunchAgents"))));
		expect(existsSync(join(home, ".agentpulse"))).toBe(false);
		expect(r.log).toBe("");
	});
});

// ── directory modes ──

describe("W16: AgentPulse's data and log directories are private", () => {
	const plain = (extra: string[] = []) => [...PLAIN, "--skip-supervisor", ...extra];
	const withBun = () => {
		const bunx = fresh("bunx");
		installBun(bunx);
		return { BUN_INSTALL: bunx };
	};

	each("created at 700 even under umask 002", (bash) => {
		const r = go(bash, plain(), { path: mkPath(), umask: "002", env: withBun() });
		expect(r.code).toBe(0);
		for (const d of ["", "data", "logs"]) {
			expect(modeOf(join(r.home, ".agentpulse", d))).toBe(0o700);
		}
	});

	once("existing 755 default directories are re-moded to 700", (bash) => {
		const home = fresh("home");
		for (const d of ["", "data", "logs"]) {
			mkdirSync(join(home, ".agentpulse", d), { recursive: true });
			chmodSync(join(home, ".agentpulse", d), 0o755);
		}
		const r = go(bash, plain(), { path: mkPath(), home, env: withBun() });
		expect(r.code).toBe(0);
		for (const d of ["", "data", "logs"]) {
			expect(modeOf(join(home, ".agentpulse", d))).toBe(0o700);
		}
	});

	each("an existing 755 --data-dir is left alone, with the advice line", (bash) => {
		const data = fresh("mydata");
		const r = go(bash, plain(["--data-dir", data]), { path: mkPath(), env: withBun() });
		expect(r.code).toBe(0);
		expect(modeOf(data)).toBe(0o755);
		expect(r.stdout).toContain(MESSAGES.dataDirReadable(q(bash, data)));
	});

	once("a 700 --data-dir gets no advice", (bash) => {
		const data = fresh("mydata", 0o700);
		const r = go(bash, plain(["--data-dir", data]), { path: mkPath(), env: withBun() });
		expect(r.code).toBe(0);
		expect(r.stdout).not.toContain("can be read by other users");
	});

	once("a new --data-dir is created at 700, its parents as usual", (bash) => {
		const t = fresh("t");
		const r = go(bash, plain(["--data-dir", `${t}/x/y`]), { path: mkPath(), env: withBun() });
		expect(r.code).toBe(0);
		expect(modeOf(`${t}/x/y`)).toBe(0o700);
		expect(modeOf(`${t}/x`)).toBe(0o755);
	});
});

// ── --dir may not hold what the installer keeps ──

describe("a --dir that would hold or replace HOME, ~/.agentpulse, the data or the log directory is refused", () => {
	const refused = (
		name: string,
		pick: (
			home: string,
			t: string,
			bash: string,
		) => { args: string[]; dir: string; what: string; other: string },
	) =>
		each(name, (bash) => {
			const home = fresh("home");
			const t = fresh("t");
			const c = pick(home, t, bash);
			mkdirSync(join(home, ".agentpulse"), { recursive: true });
			writeFileSync(join(home, ".agentpulse", "marker"), "keep");
			const r = go(bash, [...PLAIN, ...c.args], { path: mkPath(), home });
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.dirHolds(q(bash, c.dir), c.what, q(bash, c.other)));
			expect(readFileSync(join(home, ".agentpulse", "marker"), "utf-8")).toBe("keep");
			expect(r.log).toBe("");
		});

	refused("--dir is HOME", (home) => ({
		args: ["--dir", home],
		dir: home,
		what: "your home directory",
		other: home,
	}));
	refused("--dir is above HOME", (home) => ({
		args: ["--dir", join(home, "..")],
		dir: realpathSync(join(home, "..")),
		what: "your home directory",
		other: home,
	}));
	refused("--dir is ~/.agentpulse", (home) => ({
		args: ["--dir", `${home}/.agentpulse`, "--data-dir", `${home}/elsewhere`],
		dir: `${home}/.agentpulse`,
		what: "the AgentPulse directory",
		other: `${home}/.agentpulse`,
	}));
	refused("--data-dir inside --dir", (_home, t) => ({
		args: ["--dir", `${t}/app`, "--data-dir", `${t}/app/data`],
		dir: `${t}/app`,
		what: "--data-dir",
		other: `${t}/app/data`,
	}));
	refused("--data-dir is a link that sits inside --dir (the link would be deleted)", (_home, t) => {
		mkdirSync(`${t}/app`, { recursive: true });
		mkdirSync(`${t}/elsewhere`);
		symlinkSync(`${t}/elsewhere`, `${t}/app/data`);
		return {
			args: ["--dir", `${t}/app`, "--data-dir", `${t}/app/data`],
			dir: `${t}/app`,
			what: "--data-dir",
			other: `${t}/app/data`,
		};
	});
	refused("--dir is the log directory", (home) => ({
		args: ["--dir", `${home}/.agentpulse/logs`],
		dir: `${home}/.agentpulse/logs`,
		what: "the log directory",
		other: `${home}/.agentpulse/logs`,
	}));
	refused("--dir is a symbolic link to HOME", (home, t) => {
		symlinkSync(home, `${t}/link`);
		return {
			args: ["--dir", `${t}/link`],
			dir: `${t}/link`,
			what: "your home directory",
			other: home,
		};
	});

	once("a --dir beside the data directory, and the defaults, are fine", (bash) => {
		const bunx = fresh("bunx");
		installBun(bunx);
		const t = fresh("t");
		const r = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/app`], {
			path: mkPath(),
			env: { BUN_INSTALL: bunx },
		});
		expect(r.code).toBe(0);
		const d = go(bash, [...PLAIN, "--skip-supervisor"], {
			path: mkPath(),
			env: { BUN_INSTALL: bunx },
		});
		expect(d.code).toBe(0);
	});
});

describe("directories the installer makes or reuses are never left group-writable", () => {
	const withBun = () => {
		const bunx = fresh("bunx");
		installBun(bunx);
		return { BUN_INSTALL: bunx };
	};

	once(
		"the install directory, and the directories made on the way to it, are 755 under umask 002",
		(bash) => {
			const t = fresh("t");
			const r = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/new/deep/app`], {
				path: mkPath(),
				umask: "002",
				env: withBun(),
			});
			expect(r.code).toBe(0);
			expect(modeOf(`${t}/new`)).toBe(0o755);
			expect(modeOf(`${t}/new/deep`)).toBe(0o755);
			expect(modeOf(`${t}/new/deep/app`) & 0o022).toBe(0);
		},
	);

	once("a stricter umask than 022 is kept for those directories", (bash) => {
		const t = fresh("t");
		const r = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/new/deep/app`], {
			path: mkPath(),
			umask: "077",
			env: withBun(),
		});
		expect(r.code).toBe(0);
		expect(modeOf(`${t}/new`)).toBe(0o700);
		expect(modeOf(`${t}/new/deep`)).toBe(0o700);
	});

	withUnzip(
		"a re-run finds ~/.agentpulse and its Bun directories at 775 and still installs",
		(bash) => {
			const rel = fakeRelease("Linux");
			const home = fresh("home");
			const dir = join(home, ".agentpulse");
			const old = installBun(join(dir, "bun"), "1.1.30");
			for (const d of [dir, join(dir, "bun"), join(dir, "bun", "bin")]) chmodSync(d, 0o775);
			// A user's own default Bun directory is not ours to change.
			const userBun = installBun(join(home, ".bun"), "1.1.30");
			chmodSync(join(home, ".bun", "bin"), 0o775);
			const r = go(bash, [...PLAIN, "--skip-supervisor"], {
				path: mkPath(),
				home,
				script: rel.script,
				umask: "002",
				env: { AP_FAKE_ZIP: rel.zip },
			});
			expect(r.stderr).not.toContain("Can't install Bun");
			expect(r.code).toBe(0);
			expect(r.stdout).toContain(MESSAGES.notUsing(q(bash, old), MESSAGES.reason.older("1.1.30")));
			expect(r.stdout).toContain(`  ✓ Bun: ${old} (1.3.12)`);
			expect(modeOf(join(dir, "bun", "bin")) & 0o022).toBe(0);
			expect(modeOf(join(dir, "bun", "bin")) & 0o700).toBe(0o700);
			expect(modeOf(join(home, ".bun", "bin"))).toBe(0o775);
			expect(readFileSync(userBun, "utf-8")).toContain("1.1.30");
		},
	);

	// The nearest existing directory above the Bun is what the target check judges.
	for (const level of ["", "bun"]) {
		withUnzip(
			`an earlier run's ~/.agentpulse${level ? `/${level}` : ""} left at 775 (nothing deeper yet) doesn't stop the install`,
			(bash) => {
				const rel = fakeRelease("Linux");
				const home = fresh("home");
				const dir = join(home, ".agentpulse", level);
				mkdirSync(dir, { recursive: true });
				for (const d of [join(home, ".agentpulse"), dir]) chmodSync(d, 0o775);
				const r = go(bash, [...PLAIN, "--skip-supervisor"], {
					path: mkPath(),
					home,
					script: rel.script,
					umask: "002",
					env: { AP_FAKE_ZIP: rel.zip },
				});
				expect(r.stderr).not.toContain("Can't install Bun");
				expect(r.code).toBe(0);
				expect(r.stdout).toContain(`  ✓ Bun: ${home}/.agentpulse/bun/bin/bun (1.3.12)`);
			},
		);
	}

	once("a user-supplied BUN_INSTALL directory is never tightened", (bash) => {
		const bi = fresh("bi");
		const bun = installBun(bi);
		chmodSync(join(bi, "bin"), 0o775);
		const r = go(bash, PLAIN, { path: mkPath(), env: { BUN_INSTALL: bi } });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(MESSAGES.bunInstallBad(q(bash, bun), MESSAGES.reason.groupWritable));
		expect(modeOf(join(bi, "bin"))).toBe(0o775);
	});
});

describe("D18: BUN_INSTALL set to the default Bun directory is the same as unset", () => {
	for (const suffix of ["", "/"]) {
		withUnzip(
			`BUN_INSTALL=$HOME/.bun${suffix} with an old Bun there: not-using, then the private copy`,
			(bash) => {
				const rel = fakeRelease("Linux");
				const home = fresh("home");
				const old = installBun(join(home, ".bun"), "1.1.30");
				const r = go(bash, [...PLAIN, "--skip-supervisor"], {
					path: mkPath(),
					home,
					script: rel.script,
					env: { AP_FAKE_ZIP: rel.zip, BUN_INSTALL: `${home}/.bun${suffix}` },
				});
				const priv = `${home}/.agentpulse/bun/bin/bun`;
				expect(r.code).toBe(0);
				expect(r.stdout).toContain(
					MESSAGES.notUsing(q(bash, old), MESSAGES.reason.older("1.1.30")),
				);
				expect(r.stdout).toContain(`  ✓ Bun: ${priv} (1.3.12)`);
				expect(r.stderr).not.toContain("BUN_INSTALL points at");
			},
		);
	}

	withUnzip("BUN_INSTALL=$HOME/.bun with nothing there installs the private copy", (bash) => {
		const rel = fakeRelease("Linux");
		const home = fresh("home");
		const r = go(bash, [...PLAIN, "--skip-supervisor"], {
			path: mkPath(),
			home,
			script: rel.script,
			env: { AP_FAKE_ZIP: rel.zip, BUN_INSTALL: `${home}/.bun` },
		});
		expect(r.code).toBe(0);
		expect(r.stdout).toContain(`  ✓ Bun: ${home}/.agentpulse/bun/bin/bun (1.3.12)`);
	});

	once("BUN_INSTALL=$HOME/.bun with a good Bun there uses it", (bash) => {
		const home = fresh("home");
		const bun = installBun(join(home, ".bun"));
		const r = go(bash, [...PLAIN, "--skip-supervisor"], {
			path: mkPath(),
			home,
			env: { BUN_INSTALL: `${home}/.bun` },
		});
		expect(r.code).toBe(0);
		expect(r.stdout).toContain(`  ✓ Bun: ${bun} (1.3.12)`);
	});

	each("any other BUN_INSTALL with an old Bun is still refused", (bash) => {
		const other = fresh("other");
		const bun = installBun(other, "1.1.30");
		const r = go(bash, PLAIN, { path: mkPath(), env: { BUN_INSTALL: other } });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(
			MESSAGES.bunInstallBad(q(bash, bun), MESSAGES.reason.older("1.1.30")),
		);
	});
});

describe("the service PATH keeps the default Bun directory reachable", () => {
	const SYS = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

	each("a Bun elsewhere: its directory first, then ~/.bun/bin, in both units", (bash) => {
		const bunx = fresh("bunx");
		installBun(bunx);
		const home = fresh("home");
		mkdirSync(join(home, ".bun", "bin"), { recursive: true });
		for (const d of [join(home, ".bun"), join(home, ".bun", "bin")]) chmodSync(d, 0o755);
		const r = go(bash, ["--skip-hooks", "--service", "systemd"], {
			path: mkPath(),
			home,
			env: { BUN_INSTALL: bunx },
		});
		expect(r.code).toBe(0);
		for (const name of ["agentpulse", "agentpulse-supervisor"]) {
			expect(readFileSync(unitFile(r.home, name), "utf-8")).toContain(
				`\nEnvironment=PATH=${bunx}/bin:${r.home}/.bun/bin:${SYS}\n`,
			);
		}
	});

	once("the default Bun directory is not listed twice", (bash) => {
		const home = fresh("home");
		installBun(join(home, ".bun"));
		const r = go(bash, ["--skip-hooks", "--service", "systemd"], { path: mkPath(), home });
		expect(r.code).toBe(0);
		for (const name of ["agentpulse", "agentpulse-supervisor"]) {
			expect(readFileSync(unitFile(home, name), "utf-8")).toContain(
				`\nEnvironment=PATH=${home}/.bun/bin:${SYS}\n`,
			);
		}
	});

	describe("~/.bun/bin is added only when it is there and safe", () => {
		const run = (bash: string, prep: (home: string) => void, extra: Partial<Opts> = {}) => {
			const bunx = fresh("bunx");
			installBun(bunx);
			const home = fresh("home");
			prep(home);
			const r = go(bash, ["--skip-hooks", "--skip-supervisor", "--service", "systemd"], {
				path: mkPath(),
				home,
				env: { BUN_INSTALL: bunx },
				...extra,
			});
			return { r, home, bunx, unit: r.code === 0 ? readFileSync(unitFile(home), "utf-8") : "" };
		};
		const mkDefault = (home: string, mode: number) => {
			mkdirSync(join(home, ".bun", "bin"), { recursive: true });
			chmodSync(join(home, ".bun"), 0o755);
			chmodSync(join(home, ".bun", "bin"), mode);
		};

		each("absent: left out, with no message", (bash) => {
			const { r, bunx, unit } = run(bash, () => {});
			expect(r.code).toBe(0);
			expect(unit).toContain(`\nEnvironment=PATH=${bunx}/bin:${SYS}\n`);
			expect(r.stdout).not.toContain("Not adding");
		});
		each("acceptable (755): added", (bash) => {
			const { r, home, bunx, unit } = run(bash, (h) => mkDefault(h, 0o755));
			expect(r.code).toBe(0);
			expect(unit).toContain(`\nEnvironment=PATH=${bunx}/bin:${home}/.bun/bin:${SYS}\n`);
			expect(r.stdout).not.toContain("Not adding");
		});
		each("group-writable on Linux: left out, with the not-adding line", (bash) => {
			const { r, home, bunx, unit } = run(bash, (h) => mkDefault(h, 0o775));
			expect(r.code).toBe(0);
			expect(unit).toContain(`\nEnvironment=PATH=${bunx}/bin:${SYS}\n`);
			expect(r.stdout).toContain(
				MESSAGES.notAddingToPath(q(bash, `${home}/.bun/bin`), MESSAGES.reason.groupWritable),
			);
		});
		once("world-writable: left out, with the not-adding line", (bash) => {
			const { r, home, unit } = run(bash, (h) => mkDefault(h, 0o777));
			expect(r.code).toBe(0);
			expect(unit).not.toContain(`${home}/.bun/bin`);
			expect(r.stdout).toContain(
				MESSAGES.notAddingToPath(q(bash, `${home}/.bun/bin`), MESSAGES.reason.worldWritable),
			);
		});
		onlyWithPlistlib(
			plistName("group-writable in macOS's admin group (80): added, as for the Bun rule"),
			() => {
				const home = fresh("home");
				const bin = join(home, ".bun", "bin");
				mkDefault(home, 0o775);
				const bunx = fresh("bunx");
				installBun(bunx);
				const r = go(MAIN, ["--skip-hooks", "--skip-supervisor", "--service", "launchd"], {
					path: mkPath({ stubs: { ls: lsStub(process.getuid?.() ?? 0, 80, bin) } }),
					home,
					uname: "Darwin",
					env: { BUN_INSTALL: bunx },
				});
				expect(r.code).toBe(0);
				expect(r.stdout).not.toContain("Not adding");
				expect(plistJson(plistFile(home)).EnvironmentVariables.PATH).toBe(
					`${bunx}/bin:${bin}:${SYS}`,
				);
			},
		);
	});

	onlyWithPlistlib(plistName("both plists carry the same PATH"), () => {
		const bunx = fresh("bunx");
		installBun(bunx);
		const home = fresh("home");
		mkdirSync(join(home, ".bun", "bin"), { recursive: true });
		for (const d of [join(home, ".bun"), join(home, ".bun", "bin")]) chmodSync(d, 0o755);
		const r = go(MAIN, ["--skip-hooks", "--service", "launchd"], {
			path: mkPath(),
			home,
			uname: "Darwin",
			env: { BUN_INSTALL: bunx },
		});
		expect(r.code).toBe(0);
		for (const name of ["local", "supervisor"]) {
			expect(plistJson(plistFile(r.home, name)).EnvironmentVariables.PATH).toBe(
				`${bunx}/bin:${r.home}/.bun/bin:${SYS}`,
			);
		}
	});
});

describe("an option that needs a value and is last on the line gets a clean message", () => {
	each("a following option is not a value: --dir --port 4000", (bash) => {
		const r = go(bash, ["--dir", "--port", "4000"], { path: mkPath() });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(MESSAGES.argBad("--dir", MESSAGES.argReason.needsValue));
		expect(r.stdout).not.toContain(BANNER);
		expect(list(r.home)).toEqual([]);
	});

	for (const flag of [
		"--ref",
		"--repo",
		"--dir",
		"--data-dir",
		"--port",
		"--host",
		"--public-url",
		"--disable-auth",
		"--api-key",
		"--service",
	]) {
		once(`${flag}`, (bash) => {
			const r = go(bash, [flag], { path: mkPath() });
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.argBad(flag, MESSAGES.argReason.needsValue));
			expect(r.stderr).not.toContain("unbound variable");
			expect(r.stdout).not.toContain(BANNER);
			expect(list(r.home)).toEqual([]);
		});
	}
});

// ── the checkout and the directory it goes in ──

/** Every path under `dir` (not `dir` itself) whose mode has the group-write bit. */
function groupWritableUnder(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const name of readdirSync(d)) {
			const p = join(d, name);
			const st = lstatSync(p);
			if (!st.isSymbolicLink() && st.mode & 0o020) out.push(p);
			if (st.isDirectory()) walk(p);
		}
	};
	walk(dir);
	return out;
}

describe("what git and bun write into the checkout is never group-writable", () => {
	const bunEnv = () => {
		const bunx = fresh("bunx");
		installBun(bunx);
		return { BUN_INSTALL: bunx };
	};
	each("a fresh clone, install and build under umask 002", (bash) => {
		const t = fresh("t");
		const r = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/app`], {
			path: mkPath(),
			umask: "002",
			env: bunEnv(),
		});
		expect(r.code).toBe(0);
		// The stubs did write: the tree exists and holds the clone, the install and the build.
		expect(existsSync(`${t}/app/src/deep/a.ts`)).toBe(true);
		expect(existsSync(`${t}/app/node_modules/.bin/f`)).toBe(true);
		expect(existsSync(`${t}/app/dist/f`)).toBe(true);
		expect(groupWritableUnder(`${t}/app`)).toEqual([]);
		expect(modeOf(`${t}/app`) & 0o022).toBe(0);
	});
	once("a stricter umask than 022 is kept for them", (bash) => {
		const t = fresh("t");
		const r = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/app`], {
			path: mkPath(),
			umask: "077",
			env: bunEnv(),
		});
		expect(r.code).toBe(0);
		expect(modeOf(`${t}/app/src`)).toBe(0o700);
		expect(modeOf(`${t}/app/node_modules`)).toBe(0o700);
	});
	each("git runs under umask 022 for a clone and for an update", (bash) => {
		const t = fresh("t");
		const gitUmasks = (r: Result) =>
			readFileSync(`${r.logFile}.git-umask`, "utf-8").split("\n").filter(Boolean);
		const fresh1 = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/app`], {
			path: mkPath(),
			umask: "002",
			env: bunEnv(),
		});
		expect(fresh1.code).toBe(0);
		expect(gitUmasks(fresh1)).toEqual(["0022"]);
		mkdirSync(`${t}/upd/.git`, { recursive: true });
		const upd = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/upd`], {
			path: mkPath(),
			umask: "002",
			env: bunEnv(),
		});
		expect(upd.code).toBe(0);
		expect(gitUmasks(upd)).toEqual(["0022", "0022", "0022"]);
	});
	for (const [name, unit] of [
		["default", ""],
		["chosen", "chosen"],
	] as const) {
		once(
			`an existing ${name} checkout keeps/gets its mode: only a default one is tightened`,
			(bash) => {
				const home = fresh("home");
				const t = fresh("t");
				const dir = unit ? `${t}/app` : `${home}/.agentpulse/app`;
				mkdirSync(`${dir}/.git`, { recursive: true });
				chmodSync(dir, 0o775);
				const r = go(bash, [...PLAIN, "--skip-supervisor", ...(unit ? ["--dir", dir] : [])], {
					path: mkPath(),
					home,
					env: bunEnv(),
				});
				expect(r.code).toBe(0);
				expect(r.log).toContain("git -C");
				expect(modeOf(dir)).toBe(unit ? 0o775 : 0o755);
			},
		);
	}
});

describe("an existing non-git --dir is replaced only when there is nothing of the user's in it", () => {
	const bunEnv = () => {
		const bunx = fresh("bunx");
		installBun(bunx);
		return { BUN_INSTALL: bunx };
	};
	const go1 = (bash: string, dir: string, home?: string) =>
		go(bash, [...PLAIN, "--skip-supervisor", "--dir", dir], {
			path: mkPath(),
			home,
			env: bunEnv(),
		});

	each("a non-empty directory that isn't AgentPulse is refused and left alone", (bash) => {
		const t = fresh("t");
		mkdirSync(`${t}/app`);
		writeFileSync(`${t}/app/notes.txt`, "mine");
		const r = go1(bash, `${t}/app`);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(MESSAGES.installDirForeign(q(bash, `${t}/app`)));
		expect(readFileSync(`${t}/app/notes.txt`, "utf-8")).toBe("mine");
		expect(list(r.home)).toEqual([]);
		expect(r.log).toBe("");
	});
	once("a package.json with another name doesn't count", (bash) => {
		const t = fresh("t");
		mkdirSync(`${t}/app`);
		writeFileSync(`${t}/app/package.json`, '{"name": "someone-elses"}');
		const r = go1(bash, `${t}/app`);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(MESSAGES.installDirForeign(q(bash, `${t}/app`)));
		expect(existsSync(`${t}/app/package.json`)).toBe(true);
	});
	once("a file or a link at --dir is refused", (bash) => {
		const t = fresh("t");
		writeFileSync(`${t}/file`, "mine");
		mkdirSync(`${t}/real`);
		symlinkSync(`${t}/real`, `${t}/link`);
		for (const p of [`${t}/file`, `${t}/link`]) {
			const r = go1(bash, p);
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.installDirForeign(q(bash, p)));
		}
		expect(readFileSync(`${t}/file`, "utf-8")).toBe("mine");
		expect(existsSync(`${t}/real`)).toBe(true);
	});
	each("an empty directory is fine", (bash) => {
		const t = fresh("t");
		mkdirSync(`${t}/app`);
		const r = go1(bash, `${t}/app`);
		expect(r.code).toBe(0);
		expect(existsSync(`${t}/app/package.json`)).toBe(true);
	});
	each("an older AgentPulse copy without .git is replaced", (bash) => {
		const t = fresh("t");
		mkdirSync(`${t}/app/old`, { recursive: true });
		writeFileSync(`${t}/app/package.json`, '{\n  "name": "agentpulse",\n  "version": "0.1.0"\n}');
		writeFileSync(`${t}/app/old/stale`, "stale");
		const r = go1(bash, `${t}/app`);
		expect(r.code).toBe(0);
		expect(existsSync(`${t}/app/old/stale`)).toBe(false);
		expect(r.log).toContain("git clone ");
	});
	each(
		"a link to a real checkout passes the guard, takes the update path, and nothing is deleted",
		(bash) => {
			const t = fresh("t");
			mkdirSync(`${t}/real/.git`, { recursive: true });
			writeFileSync(`${t}/real/keep`, "mine");
			symlinkSync(`${t}/real`, `${t}/link`);
			const r = go1(bash, `${t}/link`);
			expect(r.stderr).not.toContain(MESSAGES.installDirForeign(q(bash, `${t}/link`)));
			expect(r.log).toContain("git -C");
			expect(r.log).not.toContain("git clone");
			expect(readFileSync(`${t}/real/keep`, "utf-8")).toBe("mine");
			// The run still ends at .env.local: the private writer (AGEN-21) never writes through a
			// symlinked directory. That is older than the guard and is not changed here.
			expect(r.code).toBe(1);
			expect(r.stderr).toContain("refusing to write into a symlinked directory");
		},
	);
	once("a package.json that is a link doesn't count", (bash) => {
		const t = fresh("t");
		mkdirSync(`${t}/app`);
		writeFileSync(`${t}/real.json`, '{\n  "name": "agentpulse"\n}\n');
		symlinkSync(`${t}/real.json`, `${t}/app/package.json`);
		const r = go1(bash, `${t}/app`);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(MESSAGES.installDirForeign(q(bash, `${t}/app`)));
		expect(lstatSync(`${t}/app/package.json`).isSymbolicLink()).toBe(true);
		expect(existsSync(`${t}/real.json`)).toBe(true);
	});
	describe("the name in package.json is the top-level one", () => {
		const NESTED =
			'{\n\t"author": {\n\t\t"name": "agentpulse"\n\t},\n\t"name": "someone-elses"\n}\n';
		const MINIFIED = '{"name":"agentpulse","version":"1"}';
		const REAL = readFileSync(join(import.meta.dir, "..", "package.json"), "utf-8");
		const withPython = [
			["with python3", () => mkPath()],
			["without python3 (anchored line match)", () => mkPath({ python3: false })],
		] as const;
		for (const [label, pathFor] of withPython) {
			once(`${label}: a nested "name": "agentpulse" is refused`, (bash) => {
				const t = fresh("t");
				mkdirSync(`${t}/app`);
				writeFileSync(`${t}/app/package.json`, NESTED);
				const r = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/app`], {
					path: pathFor(),
					env: bunEnv(),
				});
				expect(r.code).toBe(1);
				expect(r.stderr).toContain(MESSAGES.installDirForeign(q(bash, `${t}/app`)));
				expect(readFileSync(`${t}/app/package.json`, "utf-8")).toBe(NESTED);
			});
			once(
				`${label}: the repository's own package.json passes and the copy is replaced`,
				(bash) => {
					const t = fresh("t");
					mkdirSync(`${t}/app`);
					writeFileSync(`${t}/app/package.json`, REAL);
					writeFileSync(`${t}/app/stale`, "x");
					const r = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/app`], {
						path: pathFor(),
						env: bunEnv(),
					});
					expect(r.code).toBe(0);
					expect(existsSync(`${t}/app/stale`)).toBe(false);
				},
			);
		}
		once("without python3 a file it can't read line by line is refused (fails closed)", (bash) => {
			const t = fresh("t");
			mkdirSync(`${t}/app`);
			writeFileSync(`${t}/app/package.json`, MINIFIED);
			const r = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/app`], {
				path: mkPath({ python3: false }),
				env: bunEnv(),
			});
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.installDirForeign(q(bash, `${t}/app`)));
		});
		once("with python3 the same minified file passes", (bash) => {
			const t = fresh("t");
			mkdirSync(`${t}/app`);
			writeFileSync(`${t}/app/package.json`, MINIFIED);
			const r = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/app`], {
				path: mkPath(),
				env: bunEnv(),
			});
			expect(r.code).toBe(0);
		});
	});
	withUnzip(
		"something appearing at --dir while Bun is fetched is caught by the check before the delete",
		(bash) => {
			const rel = fakeRelease("Linux");
			const t = fresh("t");
			const r = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/app`], {
				path: mkPath(),
				script: rel.script,
				env: { AP_FAKE_ZIP: rel.zip, AP_RACE_DIR: `${t}/app` },
			});
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.installDirForeign(q(bash, `${t}/app`)));
			expect(readFileSync(`${t}/app/notes.txt`, "utf-8")).toBe("mine\n");
			expect(r.log).not.toContain("git clone");
		},
	);
	once("a directory that doesn't exist yet is fine", (bash) => {
		const t = fresh("t");
		expect(go1(bash, `${t}/new/app`).code).toBe(0);
	});
});

describe("a HOME that ends in slashes is normalised before any path is built", () => {
	const SYS_NO_SLASHES = (s: string) => !s.includes("//");
	once("service paths hold no //, and --dir equal to HOME is still refused", (bash) => {
		const bunx = fresh("bunx");
		installBun(bunx);
		const base = fresh("home");
		const sloppy = `${base}//`;
		const r = go(bash, ["--skip-hooks", "--skip-supervisor", "--service", "systemd"], {
			path: mkPath(),
			home: sloppy,
			env: { BUN_INSTALL: bunx },
		});
		expect(r.code).toBe(0);
		const unit = readFileSync(unitFile(base), "utf-8");
		expect(SYS_NO_SLASHES(unit)).toBe(true);
		expect(unit).toContain(`\nWorkingDirectory=${base}/.agentpulse/app\n`);
		expect(unit).toContain(`\nEnvironment=HOME=${base}\n`);
		const refused = go(bash, [...PLAIN, "--dir", base], { path: mkPath(), home: sloppy });
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain(
			MESSAGES.dirHolds(q(bash, base), "your home directory", q(bash, base)),
		);
	});
});

// ── service files: private, escaped, restarted ──

describe("service files are written 0600, end in one newline, and are applied on a re-run", () => {
	const bunEnv = () => {
		const bunx = fresh("bunx");
		installBun(bunx);
		return { BUN_INSTALL: bunx };
	};
	const endsInOneNewline = (file: string) => {
		const text = readFileSync(file, "utf-8");
		return text.endsWith("\n") && !text.endsWith("\n\n");
	};

	each(
		"W4/W4c (Linux): both units are 0600 even over an older 0644 file, and end in exactly one newline",
		(bash) => {
			const home = fresh("home");
			mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
			for (const n of ["agentpulse", "agentpulse-supervisor"]) {
				writeFileSync(unitFile(home, n), "old\n");
				chmodSync(unitFile(home, n), 0o644);
			}
			const r = go(bash, ["--skip-hooks", "--service", "systemd"], {
				path: mkPath(),
				home,
				env: bunEnv(),
			});
			expect(r.code).toBe(0);
			for (const n of ["agentpulse", "agentpulse-supervisor"]) {
				expect(modeOf(unitFile(home, n))).toBe(0o600);
				expect(endsInOneNewline(unitFile(home, n))).toBe(true);
			}
		},
	);

	onlyWithPlistlib(
		plistName("W4/W4c (macOS): both plists are 0600 over an older 0644 file, one trailing newline"),
		() => {
			const home = fresh("home");
			mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
			for (const n of ["local", "supervisor"]) {
				writeFileSync(plistFile(home, n), "old\n");
				chmodSync(plistFile(home, n), 0o644);
			}
			const r = go(MAIN, ["--skip-hooks", "--service", "launchd"], {
				path: mkPath(),
				home,
				uname: "Darwin",
				env: bunEnv(),
			});
			expect(r.code).toBe(0);
			for (const n of ["local", "supervisor"]) {
				expect(modeOf(plistFile(home, n))).toBe(0o600);
				expect(endsInOneNewline(plistFile(home, n))).toBe(true);
				expect(plistJson(plistFile(home, n)).ProgramArguments[0]).toContain("/bin/bun");
			}
		},
	);

	const IS_ROOT = (process.getuid?.() ?? 1) === 0;
	const unwritable = IS_ROOT ? test.skip : test;

	each(
		"W4 (Linux): a link at a unit path is refused before the clone and build, its target untouched",
		(bash) => {
			for (const which of ["agentpulse", "agentpulse-supervisor"]) {
				const home = fresh("home");
				mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
				writeFileSync(`${home}/target`, "keep");
				symlinkSync(`${home}/target`, unitFile(home, which));
				const r = go(bash, ["--skip-hooks", "--service", "systemd"], {
					path: mkPath(),
					home,
					env: bunEnv(),
				});
				expect(r.code).toBe(1);
				expect(r.stderr).toContain(MESSAGES.unitDir(q(bash, unitFile(home, which))));
				expect(readFileSync(`${home}/target`, "utf-8")).toBe("keep");
				expect(r.log).toBe("");
				expect(existsSync(join(home, ".agentpulse"))).toBe(false);
			}
		},
	);

	once("W4 (Linux): a dangling link at a unit path is refused too", (bash) => {
		const home = fresh("home");
		mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
		symlinkSync(`${home}/nowhere`, unitFile(home));
		const r = go(bash, ["--skip-hooks", "--skip-supervisor", "--service", "systemd"], {
			path: mkPath(),
			home,
			env: bunEnv(),
		});
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(MESSAGES.unitDir(q(bash, unitFile(home))));
		expect(r.log).toBe("");
	});

	once(
		"a link at the supervisor's unit path doesn't matter when the supervisor is skipped",
		(bash) => {
			const home = fresh("home");
			mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
			symlinkSync(`${home}/nowhere`, unitFile(home, "agentpulse-supervisor"));
			const r = go(bash, ["--skip-hooks", "--skip-supervisor", "--service", "systemd"], {
				path: mkPath(),
				home,
				env: bunEnv(),
			});
			expect(r.code).toBe(0);
		},
	);

	once(
		"W4 (macOS): a link at a plist path is refused before the clone, and launchctl isn't called",
		(bash) => {
			for (const which of ["local", "supervisor"]) {
				const home = fresh("home");
				mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
				writeFileSync(`${home}/target`, "keep");
				symlinkSync(`${home}/target`, plistFile(home, which));
				const r = go(bash, ["--skip-hooks", "--service", "launchd"], {
					path: mkPath(),
					home,
					uname: "Darwin",
					env: bunEnv(),
				});
				expect(r.code).toBe(1);
				expect(r.stderr).toContain(MESSAGES.unitDir(q(bash, plistFile(home, which))));
				expect(readFileSync(`${home}/target`, "utf-8")).toBe("keep");
				expect(r.log).toBe("");
			}
		},
	);

	// A write that fails after the pre-flight (here, a directory that can't be written to) must
	// stop the run before systemctl or launchctl is touched.
	unwritable("a unit that can't be written stops the run before systemctl", () => {
		const home = fresh("home");
		mkdirSync(join(home, ".config", "systemd", "user"), { recursive: true });
		chmodSync(join(home, ".config", "systemd", "user"), 0o555);
		try {
			const r = go(MAIN, ["--skip-hooks", "--skip-supervisor", "--service", "systemd"], {
				path: mkPath(),
				home,
				env: bunEnv(),
			});
			expect(r.code).toBe(1);
			expect(r.stderr).toContain("could not create a private temp file");
			expect(r.log).not.toContain("systemctl");
		} finally {
			chmodSync(join(home, ".config", "systemd", "user"), 0o755);
		}
	});
	unwritable("a plist that can't be written stops the run before launchctl", () => {
		const home = fresh("home");
		mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
		chmodSync(join(home, "Library", "LaunchAgents"), 0o555);
		try {
			const r = go(MAIN, ["--skip-hooks", "--skip-supervisor", "--service", "launchd"], {
				path: mkPath(),
				home,
				uname: "Darwin",
				env: bunEnv(),
			});
			expect(r.code).toBe(1);
			expect(r.stderr).toContain("could not create a private temp file");
			expect(r.log).not.toContain("launchctl");
		} finally {
			chmodSync(join(home, "Library", "LaunchAgents"), 0o755);
		}
	});

	each(
		"neither unit sets KillMode: systemd's default stops the agents the supervisor started",
		(bash) => {
			const r = go(bash, ["--skip-hooks", "--service", "systemd"], {
				path: mkPath(),
				env: bunEnv(),
			});
			expect(r.code).toBe(0);
			for (const n of ["agentpulse", "agentpulse-supervisor"]) {
				expect(readFileSync(unitFile(r.home, n), "utf-8")).not.toContain("KillMode");
			}
		},
	);

	each("under umask 002 a fresh service directory is not group-writable", (bash) => {
		const u = go(bash, ["--skip-hooks", "--skip-supervisor", "--service", "systemd"], {
			path: mkPath(),
			umask: "002",
			env: bunEnv(),
		});
		expect(u.code).toBe(0);
		for (const d of [".config", ".config/systemd", ".config/systemd/user"]) {
			expect(modeOf(join(u.home, d)) & 0o022).toBe(0);
		}
		const l = go(bash, ["--skip-hooks", "--skip-supervisor", "--service", "launchd"], {
			path: mkPath(),
			umask: "002",
			uname: "Darwin",
			env: bunEnv(),
		});
		expect(l.code).toBe(0);
		for (const d of ["Library", "Library/LaunchAgents"]) {
			expect(modeOf(join(l.home, d)) & 0o022).toBe(0);
		}
	});

	each("systemd: enable, then restart, for both units, and never enable --now", (bash) => {
		const r = go(bash, ["--skip-hooks", "--service", "systemd"], { path: mkPath(), env: bunEnv() });
		expect(r.code).toBe(0);
		const calls = r.log.split("\n").filter((l) => l.startsWith("systemctl "));
		expect(calls.filter((c) => c.includes("restart"))).toEqual([
			"systemctl --user restart agentpulse stdin=0",
			"systemctl --user restart agentpulse-supervisor stdin=0",
		]);
		expect(r.log).not.toContain("--now");
		for (const n of ["agentpulse", "agentpulse-supervisor"]) {
			const enable = calls.findIndex((c) => c.startsWith(`systemctl --user enable ${n} `));
			const restart = calls.findIndex((c) => c.startsWith(`systemctl --user restart ${n} `));
			expect(enable).toBeGreaterThanOrEqual(0);
			expect(restart).toBeGreaterThan(enable);
		}
	});

	withUnzip(
		"W5: a re-run that switches Bun rewrites both units to the new path and restarts both",
		(bash) => {
			const rel = fakeRelease("Linux");
			const home = fresh("home");
			const first = go(bash, ["--skip-hooks", "--service", "systemd"], {
				path: mkPath(),
				home,
				env: bunEnv(),
			});
			expect(first.code).toBe(0);
			const second = go(bash, ["--skip-hooks", "--service", "systemd"], {
				path: mkPath(),
				home,
				script: rel.script,
				env: { AP_FAKE_ZIP: rel.zip },
			});
			expect(second.code).toBe(0);
			const priv = `${home}/.agentpulse/bun/bin/bun`;
			expect(readFileSync(unitFile(home), "utf-8")).toContain(`\nExecStart=${priv} run start\n`);
			expect(readFileSync(unitFile(home, "agentpulse-supervisor"), "utf-8")).toContain(
				`\nExecStart=${priv} run supervisor\n`,
			);
			for (const r of [first, second]) {
				expect(r.log).toContain("systemctl --user restart agentpulse stdin=0");
				expect(r.log).toContain("systemctl --user restart agentpulse-supervisor stdin=0");
			}
		},
	);

	once("W5 (macOS): both plists are unloaded and then loaded again on a re-run", (bash) => {
		const home = fresh("home");
		const run = () =>
			go(bash, ["--skip-hooks", "--service", "launchd"], {
				path: mkPath(),
				home,
				uname: "Darwin",
				env: bunEnv(),
			});
		run();
		const r = run();
		expect(r.code).toBe(0);
		const calls = r.log.split("\n").filter((l) => l.startsWith("launchctl "));
		for (const n of ["local", "supervisor"]) {
			const unload = calls.findIndex(
				(c) => c.startsWith("launchctl unload") && c.includes(`dev.agentpulse.${n}.plist`),
			);
			const load = calls.findIndex(
				(c) => c.startsWith("launchctl load") && c.includes(`dev.agentpulse.${n}.plist`),
			);
			expect(unload).toBeGreaterThanOrEqual(0);
			expect(load).toBeGreaterThan(unload);
		}
	});
});

describe("D13: the plist holds XML-escaped values and the paths use only safe characters", () => {
	const bunEnv = () => {
		const bunx = fresh("bunx");
		installBun(bunx);
		return { BUN_INSTALL: bunx };
	};
	onlyWithPlistlib(
		plistName("X-url: a URL with & is escaped in the file and read back exactly"),
		() => {
			const url = "http://h.example:3000/?a=1&b=2&c=(3)";
			const home = fresh("home");
			const r = go(MAIN, ["--skip-hooks", "--service", "launchd", "--public-url", url], {
				path: mkPath(),
				home,
				uname: "Darwin",
				env: bunEnv(),
			});
			expect(r.code).toBe(0);
			for (const n of ["local", "supervisor"]) {
				const raw = readFileSync(plistFile(home, n), "utf-8");
				expect(raw).toContain(
					"<key>PUBLIC_URL</key><string>http://h.example:3000/?a=1&amp;b=2&amp;c=(3)</string>",
				);
				expect(plistJson(plistFile(home, n)).EnvironmentVariables.PUBLIC_URL).toBe(url);
			}
		},
	);
	onlyWithPlistlib(plistName("X-host: a bracketed IPv6 host reads back exactly"), () => {
		const home = fresh("home");
		const r = go(
			MAIN,
			["--skip-hooks", "--skip-supervisor", "--service", "launchd", "--host", "[::1]"],
			{
				path: mkPath(),
				home,
				uname: "Darwin",
				env: bunEnv(),
			},
		);
		expect(r.code).toBe(0);
		expect(plistJson(plistFile(home)).EnvironmentVariables.HOST).toBe("[::1]");
	});

	const rows = (t: string) => [
		{
			args: ["--dir", `${t}/d$x`],
			what: "--dir",
			p: `${t}/d$x`,
			reason: MESSAGES.pathReason.badChars,
		},
		{
			args: ["--dir", `${t}/d'q`],
			what: "--dir",
			p: `${t}/d'q`,
			reason: MESSAGES.pathReason.badChars,
		},
		{
			args: ["--dir", `${t}/dé`],
			what: "--dir",
			p: `${t}/dé`,
			reason: MESSAGES.pathReason.badChars,
		},
		{
			args: ["--dir", `${t}/d&x`],
			what: "--dir",
			p: `${t}/d&x`,
			reason: MESSAGES.pathReason.badChars,
		},
		{
			args: ["--data-dir", `${t}/d%h`],
			what: "--data-dir",
			p: `${t}/d%h`,
			reason: MESSAGES.pathReason.badChars,
		},
		{
			args: ["--data-dir", `${t}/d"q`],
			what: "--data-dir",
			p: `${t}/d"q`,
			reason: MESSAGES.pathReason.badChars,
		},
	];
	for (const i of [0, 1, 2, 3, 4, 5]) {
		once(`P-dir row ${i} is refused with the path-bad line`, (bash) => {
			const t = fresh("t");
			const row = rows(t)[i];
			const r = go(bash, [...PLAIN, ...row.args], { path: mkPath() });
			expect(r.code).toBe(1);
			expect(r.stderr).toContain(MESSAGES.pathBad(row.what, q(bash, row.p), row.reason));
			expect(list(r.home)).toEqual([]);
		});
	}
});

describe("--service none builds the environment safely", () => {
	const LOCAL_BLOCK = extractMarkerBlock(SOURCE, "agentpulse-local-prereqs");
	const bunEnv = () => {
		const bunx = fresh("bunx");
		const bun = installBun(bunx);
		return { env: { BUN_INSTALL: bunx }, bun };
	};
	const SYS_PATH = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

	/** The two functions plus the settings the script has set by the time it runs a service. */
	const PRELUDE = `PORT=3000 HOST=0.0.0.0 PUBLIC_URL=http://h DISABLE_AUTH=true API_KEY="" DATA_DIR=/d
${fn(LOCAL_BLOCK, "ap_local_env_content")}
${fn(LOCAL_BLOCK, "ap_local_env_run")}`;

	each(
		"ap_local_env_run keeps every NAME=value line one word, without globbing or splitting",
		(bash) => {
			const dir = fresh("env");
			writeFileSync(`${dir}/decoy1`, "");
			writeFileSync(`${dir}/decoy2`, "");
			writeFileSync(`${dir}/env`, "PORT=1\nHOST=x y  z\nPUBLIC_URL=*\n\nNODE_ENV=last-no-newline");
			const out = run(
				bash,
				`cd "${dir}"\n${PRELUDE}\nap_local_env_run "${dir}/env" sh -c 'printf "%s|%s|%s|%s" "$PORT" "$HOST" "$PUBLIC_URL" "$NODE_ENV"'`,
				[],
				SYS_PATH,
			);
			expect(out.code).toBe(0);
			expect(out.out).toBe("1|x y  z|*|last-no-newline");
		},
	);

	each(
		"a line that isn't one of the settings the installer writes is skipped by number, without its text, and never runs",
		(bash) => {
			const dir = fresh("env");
			const secret = "ap_secret_in_a_bad_line";
			writeFileSync(
				`${dir}/env`,
				`PORT=1\nnot an assignment ${secret}\n=x\n1A=x\nD-E=x\n$(touch ${dir}/pwned)=x\nHOST=ok\nPUBLIC_URL=$(touch ${dir}/pwned2) \`touch ${dir}/pwned3\`\n`,
			);
			const out = run(
				bash,
				`${PRELUDE}\nap_local_env_run "${dir}/env" sh -c 'printf "%s|%s|%s" "$PORT" "$HOST" "$PUBLIC_URL"'`,
				[],
				SYS_PATH,
			);
			expect(out.code).toBe(0);
			expect(out.out).toBe(`1|ok|$(touch ${dir}/pwned2) \`touch ${dir}/pwned3\``);
			expect(out.err).toBe(
				[2, 3, 4, 5, 6]
					.map(
						(n) =>
							`  ! Skipping line ${n} of ${dir}/env: it isn't one of the settings the installer writes\n`,
					)
					.join(""),
			);
			expect(out.err).not.toContain(secret);
			expect(existsSync(`${dir}/pwned`)).toBe(false);
			expect(existsSync(`${dir}/pwned2`) || existsSync(`${dir}/pwned3`)).toBe(false);
		},
	);

	each("a PATH= or BASH_ENV= line in .env.local is not exported", (bash) => {
		const dir = fresh("env");
		writeFileSync(`${dir}/hook.sh`, `touch ${dir}/hooked\n`);
		writeFileSync(
			`${dir}/env`,
			`PATH=/nowhere\nBASH_ENV=${dir}/hook.sh\nLD_PRELOAD=/x\nNODE_OPTIONS=--require=x\nPORT=3000\n`,
		);
		const out = run(
			bash,
			`${PRELUDE}\nap_local_env_run "${dir}/env" bash -c 'printf "%s|%s|%s|%s|%s" "$PORT" "\${BASH_ENV-unset}" "\${LD_PRELOAD-unset}" "\${NODE_OPTIONS-unset}" "$(command -v sh >/dev/null && echo path-ok)"'`,
			[],
			SYS_PATH,
		);
		expect(out.code).toBe(0);
		expect(out.out).toBe("3000|unset|unset|unset|path-ok");
		expect(existsSync(`${dir}/hooked`)).toBe(false);
		expect(out.err.split("\n").filter(Boolean)).toHaveLength(4);
	});

	test("the names it may export are derived from the function that writes the file", () => {
		const content = fn(LOCAL_BLOCK, "ap_local_env_content");
		const written = [...content.matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]);
		expect(written.length).toBeGreaterThanOrEqual(8);
		expect(fn(LOCAL_BLOCK, "ap_local_env_run")).toContain("ap_local_env_content");
		expect(SOURCE).toContain('ENV_CONTENT="$(ap_local_env_content)"');
	});

	test("the values never go through a command line: the function execs the command itself", () => {
		const body = fn(LOCAL_BLOCK, "ap_local_env_run");
		expect(body).toContain('exec "$@"');
		expect(body).not.toMatch(/\benv\b[^\n]*"\$@"/);
	});

	each("an empty file gives no variables and still runs the command (bash 3.2, set -u)", (bash) => {
		const dir = fresh("env");
		writeFileSync(`${dir}/env`, "");
		const out = run(
			bash,
			`${PRELUDE}\nap_local_env_run "${dir}/env" sh -c 'echo ran'`,
			[],
			SYS_PATH,
		);
		expect(out.code).toBe(0);
		expect(out.out).toBe("ran");
	});

	once(
		"a URL with * reaches the server as written even when files would match the glob",
		(bash) => {
			const { env, bun } = bunEnv();
			const t = fresh("t");
			// The old unquoted `env $(tr ...)` expanded PUBLIC_URL=http://* against this directory.
			mkdirSync(`${t}/app/.git`, { recursive: true });
			mkdirSync(`${t}/app/PUBLIC_URL=http:`);
			writeFileSync(`${t}/app/PUBLIC_URL=http:/x`, "");
			const r = go(bash, [...PLAIN, "--dir", `${t}/app`, "--public-url", "http://*"], {
				path: mkPath(),
				env,
			});
			expect(r.code).toBe(0);
			const deadline = Date.now() + 10_000;
			let seen = readFileSync(r.logFile, "utf-8");
			while (
				Date.now() < deadline &&
				!(seen.includes("ENV start") && seen.includes("ENV supervisor"))
			) {
				Bun.sleepSync(100);
				seen = readFileSync(r.logFile, "utf-8");
			}
			expect(seen).toContain("ENV start PUBLIC_URL=http://* HOST=0.0.0.0 ");
			expect(seen).toContain("ENV supervisor PUBLIC_URL=http://* HOST=0.0.0.0 PATH=");
			expect(seen).toContain(`PATH=${bun.slice(0, -"/bun".length)}:`);
		},
	);
});

describe("--ref and --repo reach git as options-safe arguments", () => {
	const bunEnv = () => {
		const bunx = fresh("bunx");
		installBun(bunx);
		return { BUN_INSTALL: bunx };
	};
	each("a clone gets --branch <ref> --single-branch -- <repo> <dir>", (bash) => {
		const t = fresh("t");
		const r = go(
			bash,
			[
				...PLAIN,
				"--skip-supervisor",
				"--dir",
				`${t}/app`,
				"--ref",
				"release/v1.2.3",
				"--repo",
				"https://git.example.test/x/y.git",
			],
			{ path: mkPath(), env: bunEnv() },
		);
		expect(r.code).toBe(0);
		expect(r.log).toContain(
			`git clone --branch release/v1.2.3 --single-branch -- https://git.example.test/x/y.git ${t}/app stdin=0`,
		);
	});
	once("a local absolute path is accepted as the repository", (bash) => {
		const t = fresh("t");
		const r = go(
			bash,
			[...PLAIN, "--skip-supervisor", "--dir", `${t}/app`, "--repo", `${t}/origin.git`],
			{
				path: mkPath(),
				env: bunEnv(),
			},
		);
		expect(r.code).toBe(0);
		expect(r.log).toContain(`--single-branch -- ${t}/origin.git ${t}/app`);
	});
	once("an update checks the ref out with -- after it", (bash) => {
		const t = fresh("t");
		mkdirSync(`${t}/app/.git`, { recursive: true });
		const r = go(bash, [...PLAIN, "--skip-supervisor", "--dir", `${t}/app`, "--ref", "v2"], {
			path: mkPath(),
			env: bunEnv(),
		});
		expect(r.code).toBe(0);
		expect(r.log).toContain(`git -C ${t}/app checkout v2 -- stdin=0`);
	});
	once("an @ in the path of an https repository is fine, and is shown as given", (bash) => {
		const t = fresh("t");
		const r = go(
			bash,
			[
				...PLAIN,
				"--skip-supervisor",
				"--dir",
				`${t}/app`,
				"--repo",
				"https://git.example.test/x@y/z@w.git",
			],
			{ path: mkPath(), env: bunEnv() },
		);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("  Repo:       https://git.example.test/x@y/z@w.git (main)");
	});
	for (const host of ["localhost", "0.0.0.0", "my-host_1.example", "[::1]", "::1"]) {
		once(`--host ${host} is accepted`, (bash) => {
			const r = go(bash, [...PLAIN, "--skip-supervisor", "--host", host], {
				path: mkPath(),
				env: bunEnv(),
			});
			expect(r.code).toBe(0);
		});
	}
});

// ── piping ──

describe("W6: `curl | bash` is safe", () => {
	// Padding after the script gives a child something to eat if it inherits the pipe. It proves
	// the `</dev/null` rule and nothing else: a half-downloaded script is the truncation test's job.
	const padding = "# padding\n".repeat(20_000);
	const bunEnv = () => {
		const bunx = fresh("bunx");
		installBun(bunx);
		return { BUN_INSTALL: bunx };
	};

	each(
		"the script piped in runs to the end, and no child can read the rest of the pipe",
		(bash) => {
			const r = go(bash, ["--skip-hooks", "--service", "none"], {
				path: mkPath(),
				env: bunEnv(),
				stdin: `${SOURCE}${padding}`,
			});
			expect(r.code).toBe(0);
			expect(existsSync(join(r.home, ".agentpulse", "app", ".env.local"))).toBe(true);
			expect(r.stdout.endsWith("  Open:\n    http://localhost:3000\n")).toBe(true);
			const calls = r.log.split("\n").filter((l) => l.includes("stdin="));
			// The background starts log from their own process and may land after this reads the file.
			expect(calls.length).toBeGreaterThanOrEqual(3);
			for (const call of calls) expect(call).toEndWith("stdin=0");
			expect(r.log).toContain("git clone ");
			expect(r.log).toContain(" install stdin=0");
			expect(r.log).toContain(" run build stdin=0");
		},
	);

	once("--service none starts the server and the supervisor from BUN_BIN", (bash) => {
		const bunx = fresh("bunx");
		const bun = installBun(bunx);
		const r = go(bash, PLAIN, { path: mkPath(), env: { BUN_INSTALL: bunx } });
		expect(r.code).toBe(0);
		// Both are started in the background and log from their own process, so wait for them.
		const deadline = Date.now() + 10_000;
		let seen = readFileSync(r.logFile, "utf-8");
		while (
			Date.now() < deadline &&
			!(seen.includes(`${bun} run start stdin=0`) && seen.includes(`${bun} run supervisor stdin=0`))
		) {
			Bun.sleepSync(100);
			seen = readFileSync(r.logFile, "utf-8");
		}
		expect(seen).toContain(`${bun} run start stdin=0`);
		expect(seen).toContain(`${bun} run supervisor stdin=0`);
	});

	for (const [name, unit] of [
		["systemd", "systemctl"],
		["launchd", "launchctl"],
	] as const) {
		once(`the ${name} calls get /dev/null too`, (bash) => {
			const r = go(bash, ["--skip-hooks", "--skip-supervisor", "--service", name], {
				path: mkPath(),
				env: bunEnv(),
				uname: name === "launchd" ? "Darwin" : "Linux",
				stdin: `${SOURCE}${padding}`,
			});
			expect(r.code).toBe(0);
			const calls = r.log.split("\n").filter((l) => l.startsWith(`${unit} `));
			expect(calls.length).toBeGreaterThanOrEqual(1);
			for (const call of calls) expect(call).toEndWith("stdin=0");
		});
	}

	each("a download that stops partway through the main body runs nothing", (bash) => {
		// Cut right after the `bun install` statement: a script without the one `{ }` block
		// would already have run its banner, checks, clone and install by then.
		const lines = SOURCE.split("\n");
		const at = lines.findIndex((l) => l.startsWith('ap_local_with_umask "${BUN_BIN}" install'));
		expect(at).toBeGreaterThan(0);
		const cut = lines.slice(0, at + 1).join("\n");
		const r = go(bash, ["--skip-hooks", "--service", "none"], {
			path: mkPath(),
			env: bunEnv(),
			stdin: cut,
		});
		expect(r.code).not.toBe(0);
		expect(r.stdout).toBe("");
		expect(r.log).toBe("");
		expect(list(r.home)).toEqual([]);
	});

	test("the script ends with the closing brace of its one block", () => {
		expect(SOURCE.endsWith("\n}\n")).toBe(true);
		expect(SOURCE.split("\n").filter((l) => l === "{")).toHaveLength(1);
	});
});

// ── what's gone ──

describe("the unpinned Bun installer and the hardcoded ~/.bun are gone", () => {
	test("bun.sh/install doesn't appear", () => {
		expect(SOURCE).not.toContain("bun.sh/install");
	});
	test("every Bun run goes through BUN_BIN", () => {
		expect(SOURCE).not.toMatch(/^\s*(NODE_ENV=production )?bun (install|run)\b/m);
		expect(lstatSync(SCRIPT).isFile()).toBe(true);
	});
});
