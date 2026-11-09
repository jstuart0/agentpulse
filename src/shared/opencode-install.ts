/**
 * `agentpulse setup`'s OpenCode step (AGEN-141): writes, keeps or removes the
 * plugin entries in OpenCode's global `plugins/` directory. It never runs
 * `opencode`; it only looks at paths. The shell and PowerShell installers do
 * the same thing from scripts/opencode-installer/ and are held equal to this
 * by scripts/opencode-plugin-install.test.ts.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmdirSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
	OPENCODE_FORCE_MARKER,
	OPENCODE_G9B,
	OPENCODE_LAYOUT,
	OPENCODE_PLUGIN_HEADER_PREFIX,
	OPENCODE_SDK_CONFIG_DEP,
	OPENCODE_SDK_MARKER,
	OPENCODE_SERVER_FIRST_NOTE,
	OPENCODE_SERVICE_SKIP_NOTE,
	type OpenCodeG9b,
	buildOpenCodePluginFiles,
	isForeignPluginName,
	openCodeEntries,
	planOpenCodeInstall,
	renderOpenCodeMessage,
	resolveOpenCodeConfigDir,
	resolveOpenCodeDataDir,
} from "./opencode-plugin.js";
import { writeConfigFileSyncNoFollow, writePrivateFileSyncNoFollow } from "./private-file.js";

export interface OpenCodeInstallOptions {
	home: string;
	env: Record<string, string | undefined>;
	baseUrl: string;
	direct: boolean;
	force: boolean;
	noOpenCode: boolean;
	/** Whether a binary of that name is on PATH. Never executed. */
	onPath: (name: string) => boolean;
	log: (line: string) => void;
	warn: (line: string) => void;
}

export interface OpenCodeInstallResult {
	/** False when the installer refused something (a symlink); nothing was written or removed then. */
	ok: boolean;
	/** At least one plugin entry is on disk after this run. */
	installed: boolean;
}

function lstatOrNull(path: string) {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

function isRegularFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function firstLineIsOurs(path: string): boolean {
	try {
		return (
			readFileSync(path, "utf8").split("\n", 1)[0]?.startsWith(OPENCODE_PLUGIN_HEADER_PREFIX) ===
			true
		);
	} catch {
		return false;
	}
}

function stampNow(): string {
	return new Date()
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

/** The plugin SDK is in the config folder: the marker file and, when the shipped check says so, the dependency in package.json. Links are followed. */
export function openCodeSdkPresent(cfg: string): boolean {
	if (!isRegularFile(join(cfg, OPENCODE_SDK_MARKER))) return false;
	if (OPENCODE_G9B.sdkCheck === "marker_only") return true;
	const pkg = join(cfg, "package.json");
	return isRegularFile(pkg) && readFileSync(pkg, "utf8").includes(OPENCODE_SDK_CONFIG_DEP);
}

/** `plugins/` holds a plain file (links followed) that counts as another plugin: not ours, not a dot file, a listed extension. */
export function foreignPluginPresent(
	plugins: string,
	foreignExts: OpenCodeG9b["foreignExts"] = OPENCODE_G9B.foreignExts,
): boolean {
	try {
		for (const d of readdirSync(plugins, { withFileTypes: true })) {
			if (isForeignPluginName(d.name, foreignExts) && isRegularFile(join(plugins, d.name))) {
				return true;
			}
		}
	} catch {
		// no plugins directory yet
	}
	return false;
}

export function installOpenCode(opts: OpenCodeInstallOptions): OpenCodeInstallResult {
	const { home, env, log, warn } = opts;
	const { dir: cfg, fromEnv } = resolveOpenCodeConfigDir(env, home);
	const plugins = join(cfg, "plugins");
	const data = resolveOpenCodeDataDir(env, home);
	const entries = openCodeEntries();
	const backups = join(home, ".agentpulse", "backups", "opencode");
	const forceMarker = join(home, OPENCODE_FORCE_MARKER);
	const remembersForce = OPENCODE_LAYOUT === "all_gated";

	const detected = opts.onPath("opencode") || existsSync(cfg) || existsSync(data);
	if (!detected && !opts.noOpenCode) {
		log(
			"  - OpenCode not detected (no `opencode` on PATH, no config or data folder); nothing written.",
		);
		return { ok: true, installed: false };
	}

	// Links first: nothing below writes or removes anything until none of these is a link.
	const guarded = [
		cfg,
		plugins,
		...entries.filter((e) => e.file.includes("/")).map((e) => join(plugins, e.entry)),
	];
	for (const p of guarded) {
		if (lstatOrNull(p)?.isSymbolicLink()) {
			warn(
				`  ✗ OpenCode: refusing to touch ${p}: it is a symlink. Nothing was written or removed.`,
			);
			return { ok: false, installed: false };
		}
	}

	const backup = (path: string): void => {
		mkdirSync(backups, { recursive: true, mode: 0o700 });
		const to = join(backups, `${basename(path)}.${stampNow()}`);
		renameSync(path, to);
		log(`  ✓ Moved ${path} to ${to}`);
	};

	const removeOurs = (e: ReturnType<typeof openCodeEntries>[number]): void => {
		const top = join(plugins, e.entry);
		const st = lstatOrNull(top);
		if (!st) return;
		if (e.file === e.entry) {
			if (st.isFile() && firstLineIsOurs(top)) {
				unlinkSync(top);
				log(`  ✓ Removed OpenCode plugin ${top}`);
			}
			return;
		}
		if (!st.isDirectory()) return;
		const index = join(top, "index.js");
		if (!firstLineIsOurs(index)) return;
		const names = readdirSync(top);
		if (names.every((n) => n === "index.js")) {
			unlinkSync(index);
			rmdirSync(top);
			log(`  ✓ Removed OpenCode plugin ${top}`);
		} else {
			backup(top);
		}
	};

	if (opts.noOpenCode) {
		for (const e of entries) removeOurs(e);
		if (remembersForce && lstatOrNull(forceMarker)) {
			unlinkSync(forceMarker);
			log(`  ✓ Removed ${forceMarker}`);
		}
		log("  - OpenCode plugins removed (--no-opencode).");
		return { ok: true, installed: false };
	}

	const sdkPresent = openCodeSdkPresent(cfg);
	const foreign = foreignPluginPresent(plugins);
	let forceRemembered = false;
	if (remembersForce) {
		const st = lstatOrNull(forceMarker);
		if (st?.isSymbolicLink() || (st && !st.isFile())) {
			warn(`  - Ignoring ${forceMarker}: it is not a plain file of yours.`);
		} else if (st && typeof process.getuid === "function" && st.uid === process.getuid()) {
			forceRemembered = true;
		}
	}

	const plan = planOpenCodeInstall({
		sdkPresent,
		foreignPluginPresent: foreign,
		forceFlag: opts.force,
		forceRemembered,
	});
	const texts = new Map(
		buildOpenCodePluginFiles({ baseUrl: opts.baseUrl, direct: opts.direct }).map((f) => [
			f.name,
			f.text,
		]),
	);

	for (const name of plan.remove) {
		const e = entries.find((x) => x.entry === name);
		if (e) removeOurs(e);
	}
	if (fromEnv) log(`  - OPENCODE_CONFIG_DIR is set; installing into ${cfg}/plugins.`);
	let touched = false;
	for (const w of plan.write) {
		const e = entries.find((x) => x.entry === w.entry);
		if (!e) continue;
		const text = texts.get(e.file) as string;
		const abs = join(plugins, e.file);
		const top = join(plugins, e.entry);
		const topStat = lstatOrNull(top);
		if (e.file !== e.entry && topStat && !topStat.isDirectory()) backup(top);
		mkdirSync(join(abs, ".."), { recursive: true });
		const existing = lstatOrNull(abs);
		if (existing?.isFile()) {
			if (readFileSync(abs, "utf8") === text) {
				log(`  ✓ OpenCode plugin unchanged: ${abs}`);
				touched = true;
				continue;
			}
			if (!firstLineIsOurs(abs)) backup(abs);
		}
		writeConfigFileSyncNoFollow(abs, text);
		log(`  ✓ OpenCode plugin → ${abs}`);
		touched = true;
	}
	if (plan.forceMarker === "write") {
		mkdirSync(join(home, ".agentpulse"), { recursive: true, mode: 0o700 });
		writePrivateFileSyncNoFollow(forceMarker, "1\n");
	}
	for (const m of plan.messages) {
		log(`  ${renderOpenCodeMessage(m, { dir: cfg, site: "cli" })}`);
	}
	if (touched) {
		log(`  ${OPENCODE_SERVER_FIRST_NOTE}`);
		log(`  ${OPENCODE_SERVICE_SKIP_NOTE}`);
	}
	return { ok: true, installed: touched };
}
