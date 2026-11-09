/**
 * AGEN-141 plan step 30 (and the G9 re-plan's cases h-s): the OpenCode step of the four installers that can run
 * here (setup-hooks.sh, the built setup-relay.sh, the rendered /setup.sh and `agentpulse setup`), each run with an
 * environment built from nothing: HOME and every XDG_* inside a temp directory, XDG_CONFIG_HOME set to a sentinel,
 * and a PATH holding tripwire stubs for `opencode` and the package managers. None of them may ever run.
 *
 * install-local.ps1 can't run here; scripts/opencode-plugin-ps1.test.ts checks it statically.
 *
 * Cases that depend on the shipped G9b values read them from src/shared/opencode-plugin.ts, which the observations
 * test pins to OBSERVATIONS.md; the other branch of each value is covered by the decision-function table.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { INSTALLER_SOURCES, buildRelayInstaller } from "../src/server/installers.ts";
import {
	OPENCODE_FORCE_MARKER,
	OPENCODE_G9B,
	OPENCODE_LAYOUT,
	OPENCODE_SDK_CONFIG_DEP,
	OPENCODE_SDK_FORCE_MESSAGE,
	OPENCODE_SDK_MARKER,
	OPENCODE_SDK_SKIP_MESSAGE,
	OPENCODE_SDK_SKIP_MESSAGE_ALL_GATED,
	OPENCODE_SERVER_FIRST_NOTE,
	type OpenCodeInstallSite,
	buildOpenCodePluginFiles,
	openCodeEntries,
	renderOpenCodeMessage,
} from "../src/shared/opencode-plugin.ts";
import { pathWithout, renderedSetupSh } from "./lib/installer-test-utils.ts";
import { sourceRuleViolations } from "./lib/opencode-plugin-embed.ts";

setDefaultTimeout(60_000);

const ROOT = join(import.meta.dir, "..");
const PACKAGE_MANAGERS = ["npm", "npx", "pnpm", "yarn"] as const;
const ALL_GATED = OPENCODE_LAYOUT === "all_gated";
const SKIP_TEMPLATE = ALL_GATED ? OPENCODE_SDK_SKIP_MESSAGE_ALL_GATED : OPENCODE_SDK_SKIP_MESSAGE;
const GATED_NAMES = openCodeEntries()
	.filter((e) => e.gated)
	.map((e) => e.file);
const UNGATED_NAMES = openCodeEntries()
	.filter((e) => !e.gated)
	.map((e) => e.file);
const ALL_FILES = openCodeEntries().map((e) => e.file);

interface Ctx {
	root: string;
	home: string;
	xdg: string;
	config: string;
	plugins: string;
	bin: string;
	path: string;
}

let counter = 0;
const scratchRoot = mkdtempSync(join(tmpdir(), "ap-oc-install-"));

function makeCtx(opts: { withOpenCodeOnPath?: boolean } = {}): Ctx {
	const root = join(scratchRoot, `case-${String(++counter).padStart(4, "0")}`);
	const home = join(root, "home");
	const xdg = join(root, "sentinel-xdg");
	const bin = join(root, "bin");
	for (const d of [home, xdg, bin]) mkdirSync(d, { recursive: true });
	const trip = (name: string) => {
		const file = join(bin, name);
		writeFileSync(file, `#!/bin/sh\necho ran > "$HOME/${name}-was-run"\nexit 1\n`);
		chmodSync(file, 0o755);
	};
	if (opts.withOpenCodeOnPath !== false) trip("opencode");
	for (const name of PACKAGE_MANAGERS) trip(name);
	const base = pathWithout(["opencode", ...PACKAGE_MANAGERS], undefined, root);
	return {
		root,
		home,
		xdg,
		config: join(xdg, "opencode"),
		plugins: join(xdg, "opencode", "plugins"),
		bin,
		path: `${bin}:${base}`,
	};
}

function envFor(ctx: Ctx, extra: Record<string, string> = {}): Record<string, string> {
	return {
		HOME: ctx.home,
		XDG_CONFIG_HOME: ctx.xdg,
		XDG_DATA_HOME: join(ctx.root, "xdg-data"),
		XDG_STATE_HOME: join(ctx.root, "xdg-state"),
		XDG_CACHE_HOME: join(ctx.root, "xdg-cache"),
		TMPDIR: ctx.root,
		PATH: ctx.path,
		PYTHONDONTWRITEBYTECODE: "1",
		AGENTPULSE_TTY: join(ctx.root, "no-tty"),
		...extra,
	};
}

function sdkMarker(ctx: Ctx, withConfigDep = true) {
	mkdirSync(join(ctx.config, "node_modules", "@opencode-ai", "plugin"), { recursive: true });
	writeFileSync(join(ctx.config, OPENCODE_SDK_MARKER), '{"name":"@opencode-ai/plugin"}\n');
	if (withConfigDep) {
		writeFileSync(
			join(ctx.config, "package.json"),
			`{"dependencies":{${OPENCODE_SDK_CONFIG_DEP}:"1.0.0"}}\n`,
		);
	}
}

/** A state in which the gate opens without the force option, for the shipped G9b values. */
function openGateState(ctx: Ctx) {
	if (OPENCODE_G9B.sdkRule === "sdk_present")
		sdkMarker(ctx, OPENCODE_G9B.sdkCheck !== "marker_only");
	else if (OPENCODE_G9B.foreignOpens === "yes") foreignPlugin(ctx, "theirs.js");
}

function foreignPlugin(ctx: Ctx, name: string, text = "// someone else's plugin\n") {
	mkdirSync(ctx.plugins, { recursive: true });
	writeFileSync(join(ctx.plugins, name), text);
}

function files(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else out.push(relative(dir, p));
		}
	};
	if (existsSync(dir)) walk(dir);
	return out.sort();
}

function treeHash(dir: string, skip: (rel: string) => boolean = () => false): string {
	const h = createHash("sha256");
	for (const rel of files(dir)) {
		if (skip(rel)) continue;
		h.update(`${rel}\0${readFileSync(join(dir, rel))}\0`);
	}
	return h.digest("hex");
}

const modeOf = (p: string) => lstatSync(p).mode & 0o777;

// ---- the sites ---------------------------------------------------------------------------------

interface Site {
	name: string;
	key: OpenCodeInstallSite;
	direct: boolean;
	baseUrl: string;
	/** The flag spellings this installer takes. */
	forceFlag: string;
	noFlag: string;
	run: (ctx: Ctx, o?: RunOptions) => Promise<{ code: number; out: string }>;
}
interface RunOptions {
	force?: boolean;
	no?: boolean;
	url?: string;
	extraEnv?: Record<string, string>;
}

async function spawn(cmd: string[], ctx: Ctx, env: Record<string, string>, stdin?: string) {
	const proc = Bun.spawn(cmd, {
		cwd: ROOT,
		env,
		stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
		timeout: 50_000,
		killSignal: "SIGKILL",
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { code: proc.exitCode ?? -1, out: out + err };
}

const URL_DEFAULT = "http://localhost:3000";

const hooksSite: Site = {
	name: "setup-hooks.sh",
	key: "setup-hooks",
	direct: true,
	baseUrl: URL_DEFAULT,
	forceFlag: "--opencode-force",
	noFlag: "--no-opencode",
	run: (ctx, o = {}) =>
		spawn(
			[
				"bash",
				join(ROOT, "scripts/setup-hooks.sh"),
				"--url",
				o.url ?? URL_DEFAULT,
				"--key",
				"ap_test_key",
				"--agent",
				"opencode",
				"--no-auth-check",
				...(o.force ? ["--opencode-force"] : []),
				...(o.no ? ["--no-opencode"] : []),
			],
			ctx,
			envFor(ctx, o.extraEnv),
		),
};

const cliSite: Site = {
	name: "agentpulse setup",
	key: "cli",
	direct: true,
	baseUrl: URL_DEFAULT,
	forceFlag: "--opencode-force",
	noFlag: "--no-opencode",
	run: (ctx, o = {}) =>
		spawn(
			[
				process.execPath,
				join(ROOT, "bin/cli.ts"),
				"setup",
				"--url",
				o.url ?? URL_DEFAULT,
				...(o.force ? ["--opencode-force"] : []),
				...(o.no ? ["--no-opencode"] : []),
			],
			ctx,
			envFor(ctx, o.extraEnv),
		),
};

const setupShSite: Site = {
	name: "/setup.sh (rendered)",
	key: "setup-sh",
	direct: true,
	baseUrl: URL_DEFAULT,
	forceFlag: "bash -s -- --opencode-force",
	noFlag: "bash -s -- --no-opencode",
	run: async (ctx, o = {}) => {
		const script = await renderedSetupSh();
		// Piped into `bash -s -- <flags>`, the way a person runs it.
		return spawn(
			[
				"bash",
				"-s",
				"--",
				"--url",
				o.url ?? URL_DEFAULT,
				"--key",
				"ap_test_key",
				"--no-auth-check",
				...(o.force ? ["--opencode-force"] : []),
				...(o.no ? ["--no-opencode"] : []),
			],
			ctx,
			envFor(ctx, o.extraEnv),
			script,
		);
	},
};

/** Pulls the lines of `text` from the first to the last line matching the two patterns, inclusive. */
function between(text: string, from: RegExp, to: RegExp): string {
	const lines = text.split("\n");
	const a = lines.findIndex((l) => from.test(l));
	if (a === -1) throw new Error(`no line matches ${from}`);
	const b = lines.findIndex((l, i) => i > a && to.test(l));
	if (b === -1) throw new Error(`no line matches ${to} after ${from}`);
	return lines.slice(a, b + 1).join("\n");
}

function relayHarness(): string {
	const built = buildRelayInstaller(INSTALLER_SOURCES, "http://localhost:4000");
	if (!built.ok) throw new Error(built.reason);
	const s = built.script;
	const splice = (n: 1 | 2) =>
		between(
			s,
			new RegExp(
				`^cat > "\\$SRC_DIR/agentpulse-opencode-${n}\\.js" << 'AGENTPULSE_OPENCODE_PLUGIN_${n}_EOF'`,
			),
			new RegExp(`^AGENTPULSE_OPENCODE_PLUGIN_${n}_EOF$`),
		);
	return [
		"set -euo pipefail",
		'SRC_DIR="$(mktemp -d "$TMPDIR/relay-src.XXXXXX")"',
		between(s, /^# >>> agentpulse-hook-cmd/, /^# <<< agentpulse-hook-cmd/),
		between(s, /^# >>> agentpulse-opencode-install/, /^# <<< agentpulse-opencode-install/),
		splice(1),
		splice(2),
		'ap_opencode_plugin_1_template() { cat "$SRC_DIR/agentpulse-opencode-1.js"; }',
		'ap_opencode_plugin_2_template() { cat "$SRC_DIR/agentpulse-opencode-2.js"; }',
		'PORT="${AP_TEST_PORT:-4000}"',
		'OPENCODE_FORCE="${AP_TEST_FORCE:-0}"',
		'NO_OPENCODE="${AP_TEST_NO:-0}"',
		"ap_install_exclude_script() { :; }",
		// The real call site, as built.
		between(s, /^# OpenCode \(AGEN-141\): set up whenever it is found, through the relay/, /^fi$/),
	].join("\n");
}

const relaySite: Site = {
	name: "setup-relay.sh (built)",
	key: "setup-relay",
	direct: false,
	baseUrl: "http://localhost:4000",
	forceFlag: "bash -s -- --opencode-force",
	noFlag: "bash -s -- --no-opencode",
	run: (ctx, o = {}) => {
		const port = o.url?.match(/:(\d+)$/)?.[1] ?? o.extraEnv?.AP_TEST_PORT ?? "4000";
		return spawn(
			["bash", "-s"],
			ctx,
			envFor(ctx, {
				AP_TEST_PORT: port,
				AP_TEST_FORCE: o.force ? "1" : "0",
				AP_TEST_NO: o.no ? "1" : "0",
				...o.extraEnv,
			}),
			relayHarness(),
		);
	},
};

const SITES = [hooksSite, cliSite, setupShSite, relaySite];

function expectedFiles(site: Site) {
	return buildOpenCodePluginFiles({ baseUrl: site.baseUrl, direct: site.direct });
}
const skipMessage = (site: Site, ctx: Ctx) =>
	renderOpenCodeMessage(SKIP(), { dir: ctx.config, site: site.key });
const SKIP = () => SKIP_TEMPLATE;
const forceMessage = (site: Site, ctx: Ctx) =>
	renderOpenCodeMessage(OPENCODE_SDK_FORCE_MESSAGE, { dir: ctx.config, site: site.key });

function expectNothingRan(ctx: Ctx) {
	for (const name of ["opencode", ...PACKAGE_MANAGERS]) {
		expect(existsSync(join(ctx.home, `${name}-was-run`))).toBe(false);
	}
	expect(existsSync(join(ctx.home, ".config"))).toBe(false);
}

function expectEntriesEqual(site: Site, ctx: Ctx, names: string[]) {
	for (const f of expectedFiles(site)) {
		const abs = join(ctx.plugins, f.name);
		if (names.includes(f.name)) {
			expect(readFileSync(abs, "utf8")).toBe(f.text);
			expect(modeOf(abs)).toBe(0o644);
			expect(sourceRuleViolations(f.text, f.name)).toEqual([]);
		} else {
			expect(existsSync(abs)).toBe(false);
		}
	}
}

// ---- the cases ---------------------------------------------------------------------------------

for (const site of SITES) {
	describe(`OpenCode install: ${site.name}`, () => {
		test("a, c, i: with the gate open, every entry is written byte for byte (0644); a re-run says unchanged; no skip line", async () => {
			const ctx = makeCtx();
			openGateState(ctx);
			if (!existsSync(ctx.config)) mkdirSync(ctx.config, { recursive: true });
			const first = await site.run(ctx);
			expect(first.code).toBe(0);
			expectEntriesEqual(site, ctx, ALL_FILES);
			expect(first.out).not.toContain(skipMessage(site, ctx));
			expect(first.out).toContain(OPENCODE_SERVER_FIRST_NOTE);
			const second = await site.run(ctx);
			expect(second.code).toBe(0);
			expect(second.out).toContain("unchanged");
			expectEntriesEqual(site, ctx, ALL_FILES);
			expectNothingRan(ctx);
			// n: the names on disk are the layout's, as the shared module builds them.
			expect(files(ctx.plugins)).toEqual([...ALL_FILES].sort());
		});

		test("h: a cold config folder gets only the entry no 1.x counts, and the skip line with this installer's own spelling", async () => {
			const ctx = makeCtx();
			mkdirSync(ctx.config, { recursive: true });
			const res = await site.run(ctx);
			expect(res.code).toBe(0);
			expect(res.out).toContain(skipMessage(site, ctx));
			expect(res.out).toContain(site.forceFlag);
			expectEntriesEqual(site, ctx, UNGATED_NAMES);
			if (UNGATED_NAMES.length === 0) expect(existsSync(ctx.plugins)).toBe(false);
			expectNothingRan(ctx);
		});

		test("j: the SDK going away removes our 1.x entry (not backed up) and prints the skip line", async () => {
			const ctx = makeCtx();
			openGateState(ctx);
			await site.run(ctx);
			expectEntriesEqual(site, ctx, ALL_FILES);
			// Take the opening state away again.
			for (const rel of ["node_modules", "package.json"]) {
				Bun.spawnSync(["rm", "-rf", join(ctx.config, rel)]);
			}
			for (const rel of files(ctx.plugins)) {
				if (rel.startsWith("theirs")) Bun.spawnSync(["rm", "-f", join(ctx.plugins, rel)]);
			}
			const res = await site.run(ctx);
			expect(res.out).toContain(skipMessage(site, ctx));
			expectEntriesEqual(site, ctx, UNGATED_NAMES);
			expect(existsSync(join(ctx.home, ".agentpulse", "backups"))).toBe(false);
		});

		test("k: the force option writes the gated entries without the SDK and says what 1.x will do", async () => {
			const ctx = makeCtx();
			mkdirSync(ctx.config, { recursive: true });
			const res = await site.run(ctx, { force: true });
			expect(res.code).toBe(0);
			expectEntriesEqual(site, ctx, ALL_FILES);
			expect(res.out).toContain(forceMessage(site, ctx));
			expect(res.out).not.toContain(skipMessage(site, ctx));
			expectNothingRan(ctx);
			// r (named member): outside the all-gated layout the force run leaves no marker.
			if (!ALL_GATED) expect(existsSync(join(ctx.home, OPENCODE_FORCE_MARKER))).toBe(false);
		});

		test("l: nothing in the config folder except our entries changes, on install, re-run, force and removal", async () => {
			const ctx = makeCtx();
			sdkMarker(ctx);
			writeFileSync(join(ctx.config, ".gitignore"), "node_modules\n");
			writeFileSync(join(ctx.config, "bun.lock"), "lock\n");
			writeFileSync(join(ctx.config, "node_modules", "left-pad.txt"), "x\n");
			const ours = (rel: string) =>
				rel === "plugins" || rel.startsWith("plugins/agentpulse-opencode-");
			const before = treeHash(ctx.config, ours);
			for (const o of [{}, {}, { force: true }, { no: true }]) {
				await site.run(ctx, o);
				expect(treeHash(ctx.config, ours)).toBe(before);
			}
			expect(files(ctx.plugins)).toEqual([]);
		});

		test("m: no package manager runs, and the SDK name appears in the installer only in its marker path and the two messages", async () => {
			const ctx = makeCtx();
			mkdirSync(ctx.config, { recursive: true });
			await site.run(ctx, { force: true });
			for (const name of PACKAGE_MANAGERS)
				expect(existsSync(join(ctx.home, `${name}-was-run`))).toBe(false);
		});

		test("e, o: a symlinked plugins folder or config folder is refused before anything is written or removed", async () => {
			for (const link of ["plugins", "config"] as const) {
				const ctx = makeCtx();
				const target = join(ctx.root, "elsewhere");
				mkdirSync(join(target, "plugins"), { recursive: true });
				const ours = buildOpenCodePluginFiles({ baseUrl: site.baseUrl, direct: site.direct });
				// Our V1 entry already sits in the link target.
				const v1 = ours.find((f) => f.name === "agentpulse-opencode-1.js");
				writeFileSync(join(target, "plugins", "agentpulse-opencode-1.js"), v1?.text ?? "");
				sdkMarkerAt(target);
				if (link === "plugins") {
					mkdirSync(ctx.config, { recursive: true });
					symlinkSync(join(target, "plugins"), ctx.plugins);
				} else {
					symlinkSync(target, ctx.config);
				}
				const before = treeHash(target);
				const res = await site.run(ctx);
				expect(res.out.toLowerCase()).toMatch(/refus/);
				expect(treeHash(target)).toBe(before);
				const removal = await site.run(ctx, { no: true });
				expect(removal.out.toLowerCase()).toMatch(/refus/);
				expect(treeHash(target)).toBe(before);
			}
		});

		test("p: a foreign file with our name is left alone when the entry is skipped; an edited file with our header is removed", async () => {
			if (GATED_NAMES.length === 0) return;
			const ctx = makeCtx();
			mkdirSync(ctx.plugins, { recursive: true });
			const name = GATED_NAMES[0] as string;
			const theirs = "// not ours: someone's own plugin\nexport default {};\n";
			writeFileSync(join(ctx.plugins, name), theirs);
			// A lone foreign file named like ours is not "another plugin": the gate stays shut.
			const res = await site.run(ctx);
			expect(res.out).toContain(skipMessage(site, ctx));
			expect(readFileSync(join(ctx.plugins, name), "utf8")).toBe(theirs);
			expect(existsSync(join(ctx.home, ".agentpulse", "backups"))).toBe(false);
			// Our header with an edited body goes.
			const v1 = expectedFiles(site).find((f) => f.name === name) as { text: string };
			writeFileSync(join(ctx.plugins, name), `${v1.text.split("\n")[0]}\n// edited\n`);
			await site.run(ctx);
			expect(existsSync(join(ctx.plugins, name))).toBe(false);
		});

		test("q: another plugin opens the gate where the shipped rule says so; a dot file or a folder never does", async () => {
			const opens = OPENCODE_G9B.foreignOpens === "yes";
			const cases: Array<[string, "file" | "dir", boolean]> = [
				["theirs.js", "file", opens],
				["theirs.ts", "file", opens && OPENCODE_G9B.foreignExts === "js_ts"],
				[".hidden.js", "file", false],
				["theirs.mjs", "file", false],
				["folder.js", "dir", false],
			];
			for (const [name, kind, shouldOpen] of cases) {
				const ctx = makeCtx();
				mkdirSync(ctx.plugins, { recursive: true });
				if (kind === "dir") mkdirSync(join(ctx.plugins, name));
				else writeFileSync(join(ctx.plugins, name), "// theirs\n");
				const res = await site.run(ctx);
				const v1 = join(ctx.plugins, GATED_NAMES[0] as string);
				expect(existsSync(v1)).toBe(shouldOpen);
				if (shouldOpen) expect(res.out).not.toContain(skipMessage(site, ctx));
				else expect(res.out).toContain(skipMessage(site, ctx));
			}
		});

		test("s: the SDK check follows the shipped value (marker alone, or marker plus the config's dependency)", async () => {
			const ctx = makeCtx();
			sdkMarker(ctx, false);
			await site.run(ctx);
			const written = existsSync(join(ctx.plugins, GATED_NAMES[0] as string));
			expect(written).toBe(
				OPENCODE_G9B.sdkRule === "sdk_present" && OPENCODE_G9B.sdkCheck === "marker_only",
			);
			// A config package.json without the dependency does not satisfy the strict check either.
			if (OPENCODE_G9B.sdkCheck !== "marker_only") {
				writeFileSync(join(ctx.config, "package.json"), '{"dependencies":{}}\n');
				await site.run(ctx);
				expect(existsSync(join(ctx.plugins, GATED_NAMES[0] as string))).toBe(false);
			}
		});

		test("d, f: OpenCode not found writes nothing; --no-opencode removes our entries and leaves a foreign file", async () => {
			const none = makeCtx({ withOpenCodeOnPath: false });
			const res = await site.run(none);
			// The agent-scoped installer and the CLI say so; the all-agents installers just skip a tool that isn't there.
			if (site === hooksSite || site === cliSite)
				expect(res.out.toLowerCase()).toContain("not detected");
			else expect(res.out).not.toContain("OpenCode plugin");
			expect(existsSync(none.config)).toBe(false);
			expectNothingRan(none);

			const ctx = makeCtx();
			openGateState(ctx);
			foreignPlugin(ctx, "keep-me.js");
			await site.run(ctx);
			expectEntriesEqual(site, ctx, ALL_FILES);
			const removed = await site.run(ctx, { no: true });
			expect(removed.code).toBe(0);
			expect(files(ctx.plugins)).toEqual(["keep-me.js"]);
		});

		test("g: hostile URLs are refused before anything is written; accepted ones give text that passes the source rules", async () => {
			const hostile = [
				'http://localhost:3000/"x',
				"http://localhost:3000\\x",
				"http://localhost:3000`id`",
				"http://localhost:3000$(id)",
				"http://localhost:3000\nhttp://evil.test",
				"http://local@@host:3000",
				"ftp://localhost:3000",
				"javascript:alert(1)",
			];
			for (const url of hostile) {
				const ctx = makeCtx();
				sdkMarker(ctx);
				const res = await site.run(ctx, {
					url,
					extraEnv: site === relaySite ? { AP_TEST_PORT: "x" } : {},
				});
				expect(existsSync(ctx.plugins)).toBe(false);
				expect(res.out).not.toContain("ap_test_key");
			}
			for (const url of ["https://agentpulse.example.test", "http://[::1]:3000"]) {
				if (site === relaySite) continue;
				const ctx = makeCtx();
				sdkMarker(ctx);
				await site.run(ctx, { url });
				const want = buildOpenCodePluginFiles({ baseUrl: url, direct: true });
				for (const f of want) {
					expect(readFileSync(join(ctx.plugins, f.name), "utf8")).toBe(f.text);
					expect(sourceRuleViolations(f.text, f.name)).toEqual([]);
				}
			}
		});
	});
}

function sdkMarkerAt(dir: string) {
	mkdirSync(join(dir, "node_modules", "@opencode-ai", "plugin"), { recursive: true });
	writeFileSync(join(dir, OPENCODE_SDK_MARKER), "{}\n");
	writeFileSync(join(dir, "package.json"), `{"dependencies":{${OPENCODE_SDK_CONFIG_DEP}:"1"}}\n`);
}

describe("OpenCode install: the installer never runs anything it was told about", () => {
	test("the four installers' OpenCode sections name the SDK package only in the marker path, the dependency literal and the messages", () => {
		const ps = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf8");
		const sh = readFileSync(join(ROOT, "scripts/setup-hooks.sh"), "utf8");
		const relay = readFileSync(join(ROOT, "scripts/setup-relay.sh"), "utf8");
		const cliTs = readFileSync(join(ROOT, "src/shared/opencode-install.ts"), "utf8");
		const section = (text: string, begin: string, end: string) =>
			text.slice(text.indexOf(begin), text.indexOf(end));
		for (const text of [
			section(sh, "# >>> agentpulse-opencode-install", "# <<< agentpulse-opencode-install"),
			section(relay, "# >>> agentpulse-opencode-install", "# <<< agentpulse-opencode-install"),
			section(ps, "# >>> agentpulse-opencode-install", "# <<< agentpulse-opencode-install"),
		]) {
			const lines = text.split("\n").filter((l) => l.includes("@opencode-ai/plugin"));
			for (const l of lines) {
				expect(
					l.startsWith("AP_OC_SDK_MARKER=") ||
						l.startsWith("AP_OC_SDK_CONFIG_DEP=") ||
						l.startsWith("AP_OC_MSG_") ||
						l.startsWith("$script:ApOcSdkMarker") ||
						l.startsWith("$script:ApOcSdkConfigDep") ||
						l.startsWith("$script:ApOcMsg"),
				).toBe(true);
			}
		}
		// The TypeScript site takes the names from the shared module, not a literal of its own.
		expect(cliTs).not.toContain("@opencode-ai/plugin");
		// None of them runs `opencode`, a package manager, or a download.
		for (const text of [sh, relay, ps, cliTs]) {
			expect(text).not.toMatch(/^\s*(npm|npx|pnpm|yarn)\s+(install|add|i|exec|run)\b/m);
			expect(text).not.toMatch(/\$\(\s*opencode\s/);
		}
	});

	test("every installer's arg loop takes both flags, and the usage text names them", () => {
		const sh = readFileSync(join(ROOT, "scripts/setup-hooks.sh"), "utf8");
		const relay = readFileSync(join(ROOT, "scripts/setup-relay.sh"), "utf8");
		const setupTs = readFileSync(join(ROOT, "src/server/routes/setup.ts"), "utf8");
		const ps = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf8");
		for (const text of [sh, relay, setupTs]) {
			expect(text).toMatch(/--opencode-force\)\s*\\?\$?OPENCODE_FORCE/);
			expect(text).toMatch(/--no-opencode\)\s*\\?\$?NO_OPENCODE/);
		}
		expect(ps).toContain("[switch]$OpenCodeForce");
		expect(ps).toContain("[switch]$NoOpenCode");
		expect(sh).toContain(
			"--agent  Agent type: claude_code (default), codex_cli, copilot_cli, or opencode",
		);
	});
});

describe("OpenCode install: the `agentpulse exclude check` row (plan step 22)", () => {
	async function row(ctx: Ctx): Promise<{ line: string; out: string }> {
		const res = await spawn(
			[process.execPath, join(ROOT, "bin/cli.ts"), "exclude", "check", ctx.root],
			ctx,
			envFor(ctx),
		);
		const line = res.out.split("\n").find((l) => l.trim().startsWith("OpenCode ")) ?? "";
		return { line, out: res.out };
	}

	test("never installed: not installed, nothing to warn about, and the skip-variable note is a row of its own", async () => {
		const ctx = makeCtx();
		const { line, out } = await row(ctx);
		expect(line).toMatch(/OpenCode\s+plugin\s+not installed/);
		expect(out).toContain("AGENTPULSE_SKIP isn't seen by a running OpenCode 2 service");
		expect(out).not.toContain("warning: OpenCode");
		expect(line.toLowerCase()).not.toContain("enforced");
	});

	test("installed by this version: installed, whichever server URL it was written for; an edit makes it modified", async () => {
		const ctx = makeCtx();
		sdkMarker(ctx);
		await cliSite.run(ctx, { url: "https://other-server.example.test" });
		const ok = await row(ctx);
		expect(ok.line).toMatch(/OpenCode\s+plugin\s+installed(\s|$)/);
		expect(ok.line.toLowerCase()).not.toContain("enforced");
		expect(ok.out).not.toContain("warning: OpenCode");
		const file = join(ctx.plugins, ALL_FILES[ALL_FILES.length - 1] as string);
		writeFileSync(file, `${readFileSync(file, "utf8")}\n// edited\n`);
		const bad = await row(ctx);
		expect(bad.line).toContain("modified: re-run setup");
		expect(bad.out).toContain("warning: OpenCode");
	});

	test("a cold config folder says why the 1.x plugin is missing and how to add it", async () => {
		const ctx = makeCtx();
		mkdirSync(ctx.config, { recursive: true });
		await cliSite.run(ctx);
		const { line } = await row(ctx);
		expect(line).toContain("1.x plugin not installed");
		expect(line).toContain("agentpulse setup --opencode-force");
	});

	test("our 1.x plugin without the SDK (the stall) is a warning", async () => {
		const ctx = makeCtx();
		mkdirSync(ctx.config, { recursive: true });
		await cliSite.run(ctx, { force: true });
		const { line, out } = await row(ctx);
		expect(line).toContain("plugin SDK is missing");
		expect(out).toContain("warning: OpenCode");
	});
});
