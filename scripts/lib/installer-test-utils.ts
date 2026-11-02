/**
 * Shared helpers for the installer shell tests: pulling a marker block or a
 * single function out of a script, running bash on it under `set -euo
 * pipefail` with an explicit environment, building a stub PATH, and the exact
 * installer message catalogue (the plan's P8) so no test copies a string.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type BlockCheck = {
	/** The block must be at least this many lines. */
	minLines?: number;
	/** Text the block must contain (guards against slicing the wrong region). */
	sentinel?: string;
};

function assertBlock(what: string, text: string, check: BlockCheck): string {
	if (check.minLines !== undefined && text.split("\n").length < check.minLines) {
		throw new Error(`${what} is shorter than ${check.minLines} lines`);
	}
	if (check.sentinel !== undefined && !text.includes(check.sentinel)) {
		throw new Error(`${what} doesn't contain ${JSON.stringify(check.sentinel)}`);
	}
	return text;
}

/** `# >>> name` through the end of `# <<< name`. Throws when either marker is missing. */
export function extractMarkerBlock(source: string, name: string, check: BlockCheck = {}): string {
	const startMarker = `# >>> ${name}`;
	const endMarker = `# <<< ${name}`;
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker);
	if (start === -1 || end === -1) {
		throw new Error(`${name} markers not found`);
	}
	return assertBlock(`the ${name} block`, source.slice(start, end + endMarker.length), check);
}

/** The body GET /setup.sh serves, rendered through the real route. */
export async function renderedSetupSh(): Promise<string> {
	const { Hono } = await import("hono");
	const { setup } = await import("../../src/server/routes/setup.ts");
	const app = new Hono().route("/", setup);
	const res = await app.request("http://localhost/setup.sh", {
		headers: { Host: "localhost:3000" },
	});
	return res.text();
}

/** One top-level `name() { … }` function, from its first line to the `}` that starts a line. */
export function fn(source: string, name: string, check: BlockCheck = {}): string {
	const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, "m").exec(source);
	if (!match) throw new Error(`${name} not found`);
	return assertBlock(`function ${name}`, match[0], check);
}

/** How long any helper subprocess may run before the test fails instead of hanging. */
export const SPAWN_TIMEOUT_MS = 20_000;

/** Bun.spawnSync with a timeout; a hung child throws a clear error rather than freezing the suite. */
export function spawnChecked(cmd: string[], opts: Parameters<typeof Bun.spawnSync>[1] = {}) {
	const proc = Bun.spawnSync(cmd, { timeout: SPAWN_TIMEOUT_MS, ...opts });
	if (proc.exitedDueToTimeout) {
		throw new Error(`timed out after ${SPAWN_TIMEOUT_MS} ms: ${cmd.slice(0, 3).join(" ")}`);
	}
	return proc;
}

/** Whether iconv is available; the wide-mode UTF-8 cases name-skip without it. */
export const HAS_ICONV = Bun.which("iconv") !== null;

export type BashEntry = { bash: string; label: string; skip?: string };

function bashVersion(bash: string): string {
	const proc = spawnChecked([bash, "--version"]);
	const first = proc.stdout.toString().split("\n")[0] ?? "";
	return /version (\S+)/.exec(first)?.[1] ?? "unknown";
}

/** The bashes a test runs under: the one on PATH, and /bin/bash (macOS's 3.2) when it exists. */
export const BASHES: BashEntry[] = [
	{ bash: "bash", label: `bash ${bashVersion("bash")}` },
	...(existsSync("/bin/bash") &&
	realpathSync("/bin/bash") !== realpathSync(Bun.which("bash") ?? "/bin/bash")
		? [{ bash: "/bin/bash", label: `bash ${bashVersion("/bin/bash")}` }]
		: []),
];

/** The bash 3.2 that `curl | bash` uses on a Mac; skipped by name where /bin/bash is something else. */
export const BASH_3_2: BashEntry = existsSync("/bin/bash")
	? bashVersion("/bin/bash").startsWith("3.2")
		? { bash: "/bin/bash", label: "bash 3.2" }
		: {
				bash: "/bin/bash",
				label: "bash 3.2",
				skip: `bash 3.2: /bin/bash here is ${bashVersion("/bin/bash")}`,
			}
	: { bash: "bash", label: "bash 3.2", skip: "bash 3.2: /bin/bash doesn't exist here" };

/**
 * `bash -c 'set -euo pipefail; <body>' test <args>` with exactly the given
 * environment (PATH defaults to the caller's own; nothing else is inherited).
 */
export function run(
	bash: string,
	body: string,
	args: string[] = [],
	env: Record<string, string> = {},
) {
	const proc = spawnChecked(
		[Bun.which(bash) ?? bash, "-c", `set -euo pipefail\n${body}`, "test", ...args],
		{
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
		},
	);
	return {
		code: proc.exitCode,
		out: proc.stdout.toString().trimEnd(),
		err: proc.stderr.toString(),
	};
}

/**
 * A PATH equal to `base` except that no directory offers any of `names`: each
 * directory that holds one is mirrored as symlinks to everything else in it
 * (dropping the whole directory would lose the other tools living there).
 */
export function pathWithout(
	names: string[],
	base = process.env.PATH ?? "/usr/bin:/bin",
	parent = tmpdir(),
): string {
	const omitted = new Set(names);
	const mirrorRoot = mkdtempSync(join(parent, "ap-path-without-"));
	const dirs: string[] = [];
	for (const [i, dir] of base.split(":").filter(Boolean).entries()) {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			dirs.push(dir);
			continue;
		}
		if (!entries.some((entry) => omitted.has(entry))) {
			dirs.push(dir);
			continue;
		}
		const mirror = join(mirrorRoot, String(i));
		mkdirSync(mirror, { recursive: true });
		for (const entry of entries) {
			if (omitted.has(entry)) continue;
			try {
				symlinkSync(join(dir, entry), join(mirror, entry));
			} catch {
				// A dangling or unreadable entry: skip it rather than fail the whole mirror.
			}
		}
		dirs.push(mirror);
	}
	return dirs.join(":");
}

/**
 * A fresh directory of symlinks to the real `tools` plus script `stubs`
 * (name -> sh body), for use as a whole PATH. A stub replaces a tool of the
 * same name. Throws when a requested tool doesn't resolve, so a missing one
 * can't quietly turn a case into a different test.
 */
export function stubDir(
	tools: string[],
	stubs: Record<string, string> = {},
	parent = tmpdir(),
): string {
	const dir = mkdtempSync(join(parent, "ap-stub-path-"));
	for (const tool of tools) {
		if (tool in stubs) continue;
		const real = Bun.which(tool);
		if (!real) throw new Error(`stubDir: ${tool} doesn't resolve on PATH`);
		symlinkSync(real, join(dir, tool));
	}
	for (const [name, body] of Object.entries(stubs)) {
		const file = join(dir, name);
		writeFileSync(file, `#!/bin/sh\n${body}\n`);
		chmodSync(file, 0o755);
	}
	return dir;
}

/**
 * An `ls` stub body: for `ls -ldnL <path>` (the path is the last argument) it
 * prints the real listing with the uid and gid fields replaced, in the shape
 * `<mode> <links> <uid> <gid> <size> <mon> <day> <time> <path>`; any other
 * call runs the real `ls`.
 */
export function lsStub(
	fakeUid: number | string,
	fakeGid: number | string,
	path: string | string[],
): string {
	const realLs = Bun.which("ls");
	if (!realLs) throw new Error("lsStub: ls doesn't resolve on PATH");
	const paths = (Array.isArray(path) ? path : [path])
		.map((p) => `'${p.replace(/'/g, "'\\''")}'`)
		.join("|");
	return [
		'for a in "$@"; do last="$a"; done',
		`case "\${last-}" in ${paths})`,
		`  "${realLs}" "$@" | awk -v u='${fakeUid}' -v g='${fakeGid}' '{ $3 = u; $4 = g; print }' ;;`,
		"*)",
		`  exec "${realLs}" "$@" ;;`,
		"esac",
	].join("\n");
}

/**
 * A fake Bun release zip with one member, bun-<asset>/bun: a script answering
 * --version (kind "file"), a symlink (kind "symlink"), or no zip at all
 * (kind "corrupt"). Returns the zip path and its SHA256.
 */
export function makeFakeBunZip(
	dir: string,
	asset: string,
	kind: "file" | "symlink" | "corrupt" = "file",
	version = "1.3.12",
) {
	mkdirSync(dir, { recursive: true });
	const zip = join(dir, "bun.zip");
	if (kind === "corrupt") {
		writeFileSync(zip, "this is not a zip file");
	} else {
		const attr = kind === "file" ? "0o100755" : "0o120777";
		const content =
			kind === "file"
				? `#!/bin/sh\n[ "$1" = "--version" ] && echo ${version}\nexit 0\n`
				: "/bin/sh";
		const made = spawnChecked([
			"python3",
			"-I",
			"-c",
			`import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1], 'w')\ni = zipfile.ZipInfo('bun-' + sys.argv[2] + '/bun')\ni.external_attr = ${attr} << 16\nz.writestr(i, sys.argv[3])\nz.close()`,
			zip,
			asset,
			content,
		]);
		if (made.exitCode !== 0) throw new Error(made.stderr.toString());
	}
	return { zip, sha: createHash("sha256").update(readFileSync(zip)).digest("hex") };
}

/** A `bun` that only answers --version. The mode is always applied, whatever the umask. */
export async function fakeBun(dir: string, version: string, mode = 0o755): Promise<string> {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "bun");
	writeFileSync(file, `#!/bin/sh\n[ "$1" = "--version" ] && echo "${version}"\nexit 0\n`);
	chmodSync(file, mode);
	return file;
}

/** `printf %q` of `value` under the same bash that will print the message (3.2 and 5.x differ). */
export function shellQuote(
	bash: string,
	value: string,
	env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" },
): string {
	const proc = spawnChecked([Bun.which(bash) ?? bash, "-c", 'printf %q "$1"', "test", value], {
		env,
	});
	return proc.stdout.toString();
}

const PYTHON_NOTE =
	"    (python3 is used by the local supervisor and the agent hooks; --skip-supervisor --skip-hooks installs without it.)";

/**
 * The installers' messages, byte for byte (the plan's P8). Path arguments are
 * the `printf %q`-quoted text, from shellQuote under the case's own bash.
 */
export const MESSAGES = {
	missing(tools: string[], hint: string | null): string {
		return [
			`  ✗ Missing: ${tools.join(" ")}`,
			hint ? `    Install with: ${hint}` : "    Install them with your system's package manager.",
			...(tools.includes("python3") ? [PYTHON_NOTE] : []),
			"    Then run this installer again. Nothing was installed.",
		].join("\n");
	},
	noAsset: (os: string, arch: string) =>
		`  ✗ There's no pinned Bun 1.3.12 release for ${os}/${arch}. Install Bun 1.3.12 or newer and run this installer again, or set BUN_INSTALL to where it is.`,
	notUsing: (p: string, reason: string) => `  ! Not using ${p}: ${reason}`,
	bunInstallBad: (p: string, reason: string) =>
		`  ✗ BUN_INSTALL points at a Bun this installer can't use: ${p} (${reason}). Fix it or unset BUN_INSTALL.`,
	/** The target path itself can't be used. */
	targetBad: (p: string, reason: string) =>
		`  ✗ Can't install Bun at ${p}: ${reason}. Install Bun 1.3.12 or newer yourself and set BUN_INSTALL to where it is.`,
	/** The nearest existing directory above the target is the problem (\`dir\` is %q-quoted). */
	targetDirBad: (p: string, reason: string, dir: string) =>
		`  ✗ Can't install Bun at ${p}: ${reason}. Run chmod go-w on ${dir} if you own it, or install Bun 1.3.12 or newer yourself and set BUN_INSTALL to where it is.`,
	fetch: {
		tool: (tool: "unzip" | "sha256sum", hint: string | null) =>
			hint
				? `  ✗ ${tool} is required to install Bun. Install it with: ${hint}`
				: `  ✗ ${tool} is required to install Bun. Install it with your system's package manager.`,
		download: (url: string) => `  ✗ couldn't download Bun from ${url}`,
		checksum:
			"  ✗ the downloaded Bun release's checksum doesn't match the pinned one; not installing it",
		unzip: "  ✗ couldn't unzip the downloaded Bun release",
		notRegular: (asset: string) =>
			`  ✗ the Bun release didn't contain a regular file at bun-${asset}/bun`,
		notUsable: (p: string, reason: string) =>
			`  ✗ the Bun just installed at ${p} isn't usable (${reason})`,
	},
	pathBad: (what: string, p: string, reason: string) =>
		`  ✗ ${what} ${p} can't be used: ${reason}. Use an absolute path of letters, digits and / . _ + - @.`,
	overlap: (bun: string, what: string, p: string) =>
		`  ✗ Bun would live at ${bun}, inside ${what} ${p}, which this installer may delete. Choose another --dir or set BUN_INSTALL.`,
	argBad: (flag: string, reason: string) => `  ✗ ${flag} ${reason}`,
	/** install-local: --dir exists, isn't a git checkout, and isn't an older AgentPulse copy (p is %q-quoted). */
	installDirForeign: (p: string) =>
		`  ✗ --dir ${p} already exists and isn't an AgentPulse checkout; the installer won't delete it. Move it or choose another --dir.`,
	/** install-local: ~/.bun/bin exists but is left off the service PATH (p is %q-quoted). */
	notAddingToPath: (p: string, reason: string) =>
		`  ! Not adding ${p} to the service PATH: ${reason}`,
	/** install-local: a --dir that is, or contains, something the installer keeps (dir and other are %q-quoted). */
	dirHolds: (dir: string, what: string, other: string) =>
		`  ✗ --dir ${dir} would hold or replace ${what} ${other}, and the installer deletes --dir when it isn't a git checkout. Choose another --dir.`,
	unitDir: (dir: string) =>
		`  ✗ ${dir} is a symbolic link; the installer won't write service files through it. Nothing was installed.`,
	relayHome: (home: string, reason: string) =>
		`  ✗ The relay keeps its files and Bun under ${home}/.agentpulse, and that path can't be used (${reason}). It may hold only letters, digits, spaces, UTF-8 text and / . _ + - @. Run the installer as a user whose home path fits.`,
	tmp: (p: string) => `  ✗ couldn't create a temporary directory under ${p}`,
	/** install-local's "can be read by other users" note for a user-supplied --data-dir (p is %q-quoted). */
	dataDirReadable: (p: string) =>
		`  ! ${p} can be read by other users; run chmod 700 ${p} to keep AgentPulse's data private.`,
	/** The reasons an arg-bad line carries. */
	argReason: {
		port: "must be a number from 1 to 65535",
		bool: "must be true or false",
		charset: "can only contain letters, digits, '.', '_' and '-'",
		controls: "can't contain control characters",
		url: "must be an http:// or https:// URL without spaces, quotes, $, ; or <>",
		needsValue: "needs a value",
		repoUserinfo: "can't contain a user name or token; use a git credential helper",
		host: "can only contain letters, digits, '.', ':', '_' and '-', or an IPv6 address in [brackets]",
		ref: "can only contain letters, digits, '.', '_', '/' and '-', can't start with '-' and can't contain '..'",
		repo: "must be an https:// URL (without spaces, quotes, $, ; or <>) or an absolute path of letters, digits and / . _ + - @",
	},
	/** The reasons a path-bad line carries. */
	pathReason: {
		empty: "it's empty",
		notAbsolute: "it isn't absolute",
		component: "it has an empty, . or .. component",
		badChars: "it has characters a service file can't hold",
	},
	/** The reasons the not-using and path-bad lines carry. */
	reason: {
		notAbsolute: "its path isn't absolute",
		badChars: "its path has characters a service file can't hold",
		component: "its path has an empty, . or .. component",
		notExecutable: "isn't an executable file",
		worldWritable: "it or its directory is writable by everyone",
		groupWritable: "it or its directory is writable by its group",
		notOwned: "it or its directory isn't owned by you or root",
		older: (version: string) => `Bun ${version} is older than 1.3.12`,
		unknownVersion: "Bun of unknown version is older than 1.3.12",
		notUtf8: "its path isn't valid UTF-8",
		controls: "its path has control characters",
		noIconv: "its path has non-ASCII characters, and iconv isn't installed to check them",
	},
} as const;
