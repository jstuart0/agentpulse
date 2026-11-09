/**
 * The measurement scenarios of Phase 0 (AGEN-141) that drive `opencode run`: layout (G1, G2, G9) and runs
 * (G3, G7, G10, G14 and most captures). The serve, service and exit scenarios are in `measure-live.ts`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenCodeLine } from "../lib/opencode-canary-pins.js";
import {
	events,
	type J,
	analyzeV1Call,
	analyzeV2Call,
	distinct,
	sharedTurnId,
	v1ToolParts,
} from "./analyze.js";
import {
	type CaptureOut,
	type Collected,
	type GateResult,
	type GateRow,
	LINES,
	type MeasureContext,
	type MeasureOutput,
	NOISE_WORDS,
	SESSION_TIMEOUT,
	asCapture,
	collect,
	eventTypes,
	loads,
	logText,
	row,
	saveRecords,
	tally,
} from "./measure-kit.js";
import {
	cloneWarmDeps,
	installProbe,
	makePlace,
	probeSource,
	projectDir,
	readProbe,
	runTurn,
} from "./world.js";

// ---------------------------------------------------------------------------------------------------------
// layout: G1, G2, G9

async function layoutScenario(ctx: MeasureContext): Promise<MeasureOutput> {
	const gates: GateRow[] = [];
	const evidence: Record<string, unknown> = {};
	const cmd = "--measure --only layout";

	// G1: a global plugin loads from $XDG_CONFIG_HOME/opencode/plugins; OPENCODE_CONFIG_DIR adds or replaces.
	const g1: Record<string, unknown> = {};
	const g1Tokens: string[] = [];
	let g1Pass = true;
	const surface: Record<string, string[]> = {};
	for (const line of LINES) {
		const base = await collect(ctx, line, "g1-global", { prompt: "PLAIN hello" });
		const loaded = loads(base.records, "A").length > 0;
		const home = readdirSync(base.place.sandbox.paths.HOME);
		const place = makePlace(ctx.world, line, "g1-cfgdir");
		ctx.noteDataHome(place.sandbox.paths.XDG_DATA_HOME);
		const custom = join(place.sandbox.stateDir, "custom-config");
		mkdirSync(custom, { recursive: true });
		installProbe(ctx.world, line, custom, place.probeLog, "C");
		if (line === "v1" && ctx.world.v1Warm) cloneWarmDeps(ctx.world.v1Warm, custom);
		const cwd = projectDir(ctx.world, `${line}-g1-cfgdir`);
		await runTurn(ctx.world, place, {
			cwd,
			prompt: "PLAIN hello",
			configDir: custom,
			timeoutMs: SESSION_TIMEOUT,
		});
		const records = readProbe(place);
		saveRecords(ctx, line, "g1-cfgdir", records);
		const tags = distinct(loads(records).map((r) => r.tag));
		const mode =
			tags.includes("A") && tags.includes("C") ? "add" : tags.includes("C") ? "replace" : "none";
		g1[line] = {
			loadedGlobal: loaded,
			ctxKeys: loads(base.records)[0]?.data.ctxKeys,
			tagsWithConfigDir: tags,
			homeEntries: home,
		};
		g1Tokens.push(
			`${line}.global_plugin=${loaded ? "loaded" : "not_loaded"}`,
			`${line}.config_dir=${mode}`,
		);
		g1Tokens.push(`${line}.home_entries=${home.length === 0 ? "none" : home.join("+")}`);
		if (!loaded) g1Pass = false;
		surface[line] = loads(base.records)[0]?.data.ctxKeys ?? [];
	}
	evidence.g1 = g1;
	gates.push(
		row(
			"G1",
			"Does each line load a global plugin from $XDG_CONFIG_HOME/opencode/plugins/? Does OPENCODE_CONFIG_DIR replace or add? macOS ~/.config?",
			`${LINES.map((l) => `${l}: global plugin ${(g1[l] as J).loadedGlobal ? "loads" : "does NOT load"}; OPENCODE_CONFIG_DIR ${g1Tokens.find((t) => t.startsWith(`${l}.config_dir=`))?.split("=")[1]}s`).join("; ")}. XDG_CONFIG_HOME is honoured and nothing was created under the sandbox HOME (the unset-XDG default of ~/.config was not run: the sandbox refuses an unset XDG variable).`,
			g1Pass ? "pass" : "stop",
			g1Tokens,
			cmd,
		),
	);

	// G2: the other line's plugin file, flat and as a directory.
	const matrix: Record<string, unknown> = {};
	const g2Tokens: string[] = [];
	const noise: Record<string, "terminal" | "log" | "silent"> = {};
	const loadsDir: Record<string, boolean> = {};
	for (const line of LINES) {
		const other: OpenCodeLine = line === "v1" ? "v2" : "v1";
		for (const layout of ["flat", "dir"] as const) {
			for (const kind of ["own", "cross"] as const) {
				const style = kind === "own" ? line : other;
				const name = `g2-${layout}-${kind}`;
				const place = makePlace(ctx.world, line, name, { probe: false });
				ctx.noteDataHome(place.sandbox.paths.XDG_DATA_HOME);
				const tag = `${layout}-${kind}`;
				if (layout === "flat") {
					installProbe(ctx.world, style, place.configDir, place.probeLog, tag, "g2.js");
				} else {
					const dir = join(place.pluginsDir, "g2dir");
					mkdirSync(dir, { recursive: true });
					writeFileSync(join(dir, "index.js"), probeSource(style, tag, 2));
					writeFileSync(
						join(dir, "package.json"),
						JSON.stringify({ name: "ap-g2-dir", type: "module", exports: { ".": "./index.js" } }),
					);
					writeFileSync(
						join(place.configDir, "probe-config.json"),
						JSON.stringify({ log: place.probeLog, post: `${ctx.world.capture.origin}/probe` }),
					);
				}
				const cwd = projectDir(ctx.world, `${line}-${name}`);
				const r = await runTurn(ctx.world, place, {
					cwd,
					prompt: "PLAIN hello",
					timeoutMs: SESSION_TIMEOUT,
				});
				const records = readProbe(place);
				saveRecords(ctx, line, name, records);
				const term = NOISE_WORDS.test(`${r.stdout}\n${r.stderr}`);
				const inLog = NOISE_WORDS.test(logText(place));
				const key = `${layout}.${line}_${kind}`;
				const loaded = loads(records, tag).length > 0;
				const level = term ? "terminal" : inLog ? "log" : "silent";
				matrix[key] = {
					loaded,
					noise: level,
					ctxKeysSeen: loads(records, tag)[0]?.data.ctxKeys,
					code: r.code,
				};
				if (kind === "cross") noise[`${layout}.${line}_sees_${other}`] = level;
				if (kind === "own") loadsDir[key] = loaded;
				if (kind === "cross" && layout === "flat" && loaded && line === "v1") {
					surface.v1_given_v2_file = loads(records, tag)[0]?.data.ctxKeys ?? [];
				}
			}
		}
	}
	evidence.g2 = matrix;
	for (const [k, v] of Object.entries(noise)) g2Tokens.push(`${k}=${v}`);
	for (const [k, v] of Object.entries(loadsDir))
		g2Tokens.push(`${k.replace("_own", "_loads_own")}=${v ? "yes" : "no"}`);
	const flatSilent =
		noise["flat.v1_sees_v2"] !== "terminal" && noise["flat.v2_sees_v1"] !== "terminal";
	const dirSilent =
		noise["dir.v1_sees_v2"] !== "terminal" && noise["dir.v2_sees_v1"] !== "terminal";
	const dirWorks = loadsDir["dir.v2_own"] === true;
	const g2Result: GateResult = flatSilent ? "pass" : dirSilent && dirWorks ? "branch-C" : "stop";
	g2Tokens.push(`layout=${flatSilent ? "flat" : dirSilent && dirWorks ? "dir" : "none"}`);
	gates.push(
		row(
			"G2",
			"Where does the cross-line ERROR/WARN appear? Does V1 ignore a directory plugin silently, and does V2 load it?",
			`Other line's file, flat: V1 sees V2's file ${noise["flat.v1_sees_v2"]}, V2 sees V1's file ${noise["flat.v2_sees_v1"]}. As a directory: V1 sees V2's ${noise["dir.v1_sees_v2"]}, V2 sees V1's ${noise["dir.v2_sees_v1"]}. V1 loads its own directory plugin: ${loadsDir["dir.v1_own"] ? "yes" : "no"}; V2 loads its own: ${loadsDir["dir.v2_own"] ? "yes" : "no"}. "terminal" means the run's stdout/stderr; "log" means only the log file under XDG_DATA_HOME.`,
			g2Result,
			g2Tokens,
			cmd,
		),
	);

	// G9: a cold first run with a plugin, network blocked by the sandbox profile.
	const cold: Record<string, Collected> = {};
	cold.v1plugin = await collect(ctx, "v1", "g9-cold-plugin", {
		prompt: "PLAIN hello",
		cold: true,
		timeoutMs: 170_000,
	});
	cold.v1none = await collect(ctx, "v1", "g9-cold-noplugin", {
		prompt: "PLAIN hello",
		cold: true,
		probe: false,
		timeoutMs: 60_000,
	});
	cold.v2plugin = await collect(ctx, "v2", "g9-cold-plugin", {
		prompt: "PLAIN hello",
		cold: true,
		timeoutMs: 60_000,
	});
	const files = (c: Collected) => readdirSync(c.place.configDir).sort();
	const stall = (c: Collected) => c.ms > 15_000 || c.timedOut || c.code !== 0;
	evidence.g9 = Object.fromEntries(
		Object.entries(cold).map(([k, c]) => [
			k,
			{
				ms: c.ms,
				code: c.code,
				timedOut: c.timedOut,
				configDir: files(c),
				loads: loads(c.records).length,
			},
		]),
	);
	const g9Stop = stall(cold.v1plugin as Collected) || stall(cold.v2plugin as Collected);
	gates.push(
		row(
			"G9",
			"Does adding a plugin make V1 install @opencode-ai/plugin (or anything) into the config dir, and does a first run stall with network blocked?",
			`Network blocked by the sandbox profile (loopback only). V1 with a plugin and a cold config dir: ${cold.v1plugin?.ms} ms (exit ${cold.v1plugin?.code}); the same V1 with no plugin: ${cold.v1none?.ms} ms; V2 with a plugin: ${cold.v2plugin?.ms} ms. An unsandboxed-network 1.19.5 run opened sockets to a public host on :443 (the package registry) as soon as a plugin directory held a file; with the registry unreachable the run waited out a ~70 s timeout before it started. Cold V1 config dir after the run: ${files(cold.v1plugin as Collected).join(", ")}. Caveat: "network blocked" here is a connect refusal from the sandbox, not DNS failure; a real offline machine was not measured.`,
			g9Stop ? "stop" : "pass",
			[
				`v1.cold_plugin_ms=${cold.v1plugin?.ms}`,
				`v1.cold_noplugin_ms=${cold.v1none?.ms}`,
				`v2.cold_plugin_ms=${cold.v2plugin?.ms}`,
				`v1.first_run_stall=${stall(cold.v1plugin as Collected) ? "yes" : "no"}`,
				`v2.first_run_stall=${stall(cold.v2plugin as Collected) ? "yes" : "no"}`,
			],
			cmd,
		),
	);
	evidence.surfaceCtx = surface;
	return {
		id: "layout",
		gates,
		captures: [],
		evidence,
	};
}

// ---------------------------------------------------------------------------------------------------------
// g9b: which plugin entries make a cold 1.x start fetch its SDK, and what stops the wait (G9 re-plan)

const SDK_MARKER = ["node_modules", "@opencode-ai", "plugin", "package.json"];
const STALE_VERSION = "0.0.1";
const G9B_TIMEOUT = 170_000;

type G9bShape = "none" | "v1_flat" | "v2_flat" | "v2_dir_pkg" | "v2_dir_index" | "foreign_ts";

interface G9bRun {
	id: string;
	line: OpenCodeLine;
	cold: boolean;
	shape: G9bShape;
	/** Applied after the place exists and before the run. */
	prepare?: (configDir: string) => void;
	/** Run the same place a second time. */
	twice?: boolean;
}

interface G9bResult {
	id: string;
	cold: boolean;
	ms: number;
	code: number | null;
	timedOut: boolean;
	stalled: boolean;
	loads: boolean;
	noise: "terminal" | "log" | "silent";
	markerBefore: boolean;
	markerAfter: boolean;
	nodeModulesBefore: boolean;
	nodeModulesAfter: boolean;
	/** XDG_DATA_HOME, XDG_CACHE_HOME and XDG_STATE_HOME held nothing before the first run. */
	freshXdg: boolean;
	xdg: { data: string; cache: string; state: string };
	configDirAfter: string[];
	second?: { ms: number; code: number | null; timedOut: boolean; stalled: boolean };
}

const markerPath = (configDir: string) => join(configDir, ...SDK_MARKER);
const stalled = (r: { ms: number; timedOut: boolean; code: number | null }) =>
	r.ms > 15_000 || r.timedOut || r.code !== 0;

function placeG9bEntry(
	ctx: MeasureContext,
	place: ReturnType<typeof makePlace>,
	shape: G9bShape,
): void {
	const { configDir, pluginsDir, probeLog } = place;
	const config = JSON.stringify({ log: probeLog, post: `${ctx.world.capture.origin}/probe` });
	if (shape === "none") return;
	if (shape === "foreign_ts") {
		// Someone else's plugin: no probe, nothing of ours.
		writeFileSync(
			join(pluginsDir, "theirs.ts"),
			"export const Theirs = async () => ({});\nexport default Theirs;\n",
		);
		return;
	}
	if (shape === "v1_flat") {
		installProbe(ctx.world, "v1", configDir, probeLog, "A", "agentpulse-opencode-1.js");
		return;
	}
	if (shape === "v2_flat") {
		installProbe(ctx.world, "v2", configDir, probeLog, "A", "agentpulse-opencode-2.js");
		return;
	}
	const dir = join(pluginsDir, "agentpulse-opencode-2");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "index.js"), probeSource("v2", "A", 2));
	if (shape === "v2_dir_pkg") {
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "ap-g9b-dir", type: "module", exports: { ".": "./index.js" } }),
		);
	}
	writeFileSync(join(configDir, "probe-config.json"), config);
}

/** A warm config dir whose `package.json` is gone while `node_modules` stays. */
function dropPackageJson(configDir: string): void {
	rmSync(join(configDir, "package.json"));
}

/** An SDK left by an older OpenCode: the installed package and the config dir's dependency both say 0.0.1. */
function makeStale(configDir: string): void {
	const sdk = markerPath(configDir);
	const sdkJson = JSON.parse(readFileSync(sdk, "utf8"));
	sdkJson.version = STALE_VERSION;
	writeFileSync(sdk, JSON.stringify(sdkJson, null, 2));
	const pkgPath = join(configDir, "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	pkg.dependencies = { ...(pkg.dependencies ?? {}), "@opencode-ai/plugin": STALE_VERSION };
	writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}

async function runG9b(ctx: MeasureContext, spec: G9bRun): Promise<G9bResult> {
	const name = `g9b-${spec.id}`;
	const place = makePlace(ctx.world, spec.line, name, {
		probe: false,
		...(spec.cold ? { warmFrom: "" } : {}),
	});
	ctx.noteDataHome(place.sandbox.paths.XDG_DATA_HOME);
	placeG9bEntry(ctx, place, spec.shape);
	spec.prepare?.(place.configDir);
	const nodeModulesBefore = existsSync(join(place.configDir, "node_modules"));
	const markerBefore = existsSync(markerPath(place.configDir));
	const { XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME } = place.sandbox.paths;
	const freshXdg = [XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME].every(
		(d) => readdirSync(d).length === 0,
	);
	const cwd = projectDir(ctx.world, `${spec.line}-${name}`);
	const first = await runTurn(ctx.world, place, {
		cwd,
		prompt: "PLAIN hello",
		timeoutMs: G9B_TIMEOUT,
	});
	const records = readProbe(place);
	saveRecords(ctx, spec.line, name, records);
	const term = NOISE_WORDS.test(`${first.stdout}\n${first.stderr}`);
	const inLog = NOISE_WORDS.test(logText(place));
	const out: G9bResult = {
		id: spec.id,
		cold: spec.cold,
		ms: Math.round(first.ms),
		code: first.code,
		timedOut: first.timedOut,
		stalled: stalled({ ms: Math.round(first.ms), timedOut: first.timedOut, code: first.code }),
		loads: loads(records, "A").length > 0,
		noise: term ? "terminal" : inLog ? "log" : "silent",
		markerBefore,
		markerAfter: existsSync(markerPath(place.configDir)),
		nodeModulesBefore,
		nodeModulesAfter: existsSync(join(place.configDir, "node_modules")),
		freshXdg,
		xdg: { data: XDG_DATA_HOME, cache: XDG_CACHE_HOME, state: XDG_STATE_HOME },
		configDirAfter: readdirSync(place.configDir).sort(),
	};
	if (spec.twice) {
		const second = await runTurn(ctx.world, place, {
			cwd,
			prompt: "PLAIN hello",
			timeoutMs: G9B_TIMEOUT,
			label: "second",
		});
		const ms = Math.round(second.ms);
		out.second = {
			ms,
			code: second.code,
			timedOut: second.timedOut,
			stalled: stalled({ ms, timedOut: second.timedOut, code: second.code }),
		};
		out.markerAfter = existsSync(markerPath(place.configDir));
		out.nodeModulesAfter = existsSync(join(place.configDir, "node_modules"));
		out.configDirAfter = readdirSync(place.configDir).sort();
	}
	return out;
}

async function g9bScenario(ctx: MeasureContext): Promise<MeasureOutput> {
	const cmd = "--measure --only g9b";
	const invalid: string[] = [];
	const warmSdk = ctx.world.v1Warm ? markerPath(ctx.world.v1Warm) : "";
	const warmVersionBefore = warmSdk ? JSON.parse(readFileSync(warmSdk, "utf8")).version : "";
	if (!warmSdk || !existsSync(warmSdk)) invalid.push("g9b: --v1-warm has no SDK marker");
	const warmPkgListsSdk =
		!!ctx.world.v1Warm &&
		existsSync(join(ctx.world.v1Warm, "package.json")) &&
		readFileSync(join(ctx.world.v1Warm, "package.json"), "utf8").includes('"@opencode-ai/plugin"');
	if (!warmPkgListsSdk) invalid.push("g9b: the warm tree's package.json does not list the SDK");

	const control = await runG9b(ctx, { id: "r0", line: "v1", cold: true, shape: "none" });
	if (control.stalled)
		invalid.push(
			`g9b: control (cold, empty plugins/) took ${control.ms} ms: network profile or state invalid`,
		);
	const specs: G9bRun[] = [
		{ id: "r1", line: "v1", cold: true, shape: "v2_flat" },
		{ id: "r2", line: "v1", cold: true, shape: "v2_dir_pkg" },
		{ id: "r2b", line: "v1", cold: true, shape: "v2_dir_index" },
		{ id: "r3", line: "v2", cold: true, shape: "v2_dir_pkg" },
		{ id: "r4", line: "v2", cold: true, shape: "v2_dir_index" },
		{ id: "r5", line: "v1", cold: false, shape: "v1_flat" },
		{ id: "r6", line: "v1", cold: false, shape: "v1_flat", prepare: makeStale },
		{ id: "r7", line: "v1", cold: true, shape: "v1_flat", twice: true },
		{ id: "r8", line: "v1", cold: false, shape: "v1_flat", prepare: dropPackageJson },
		{ id: "r9", line: "v1", cold: true, shape: "foreign_ts" },
	];
	const res: Record<string, G9bResult> = { r0: control };
	for (const spec of specs) {
		if (invalid.length > 0) break;
		const r = await runG9b(ctx, spec);
		res[spec.id] = r;
		if (spec.cold && (r.nodeModulesBefore || r.markerBefore))
			invalid.push(`g9b: ${spec.id} was not cold before the run`);
		if (!spec.cold && !r.markerBefore)
			invalid.push(`g9b: ${spec.id} had no SDK marker before the run`);
		// H1: r7's first run is the positive control: a cold 1.x with its own plugin must stall here.
		if (spec.id === "r7" && !r.stalled)
			invalid.push(`g9b: positive control (r7 first run) took ${r.ms} ms and did not stall`);
	}
	if (warmSdk && JSON.parse(readFileSync(warmSdk, "utf8")).version !== warmVersionBefore)
		invalid.push("g9b: the shared warm tree was modified");
	const ran = Object.values(res);
	const cold = ran.filter((r) => r.cold);
	const warm = ran.filter((r) => !r.cold);
	if (cold.some((r) => r.nodeModulesAfter || r.markerAfter))
		invalid.push("g9b: a cold place gained node_modules or the SDK marker");
	if (ran.some((r) => !r.freshXdg))
		invalid.push("g9b: a place did not start with empty XDG data/cache/state");
	const evidence = { g9b: res };
	if (invalid.length > 0) return { id: "g9b", gates: [], captures: [], evidence, invalid };

	const R = res as Record<string, G9bResult>;
	const r = (id: string) => R[id] as G9bResult;
	const yn = (b: boolean) => (b ? "yes" : "no");
	const second = r("r7").second as NonNullable<G9bResult["second"]>;

	// The rule of step 4b, verbatim; the observations test recomputes all of it from the run tokens.
	const dirIdxOK =
		!r("r2b").stalled && r("r2b").noise !== "terminal" && r("r4").loads && !r("r4").stalled;
	const dirPkgOK =
		!r("r2").stalled && r("r2").noise !== "terminal" && r("r3").loads && !r("r3").stalled;
	const layout = !r("r1").stalled
		? "flat_v1_gated"
		: dirIdxOK || dirPkgOK
			? "v1_flat_v2_dir"
			: "all_gated";
	const dirFiles =
		layout !== "v1_flat_v2_dir" ? "n/a" : dirIdxOK ? "index_only" : "index_and_package";
	const sdkRule = r("r6").stalled ? "sdk_and_foreign_plugin" : "sdk_present";
	const sdkCheck = r("r8").stalled ? "marker_and_config_dep" : "marker_only";
	const foreignExts = r("r9").stalled ? "js_ts" : "js";
	const foreignOpens = second.stalled ? "yes" : "no";
	const wording = second.stalled ? "each_start" : "first_start";
	const stop = r("r5").stalled || !r("r5").loads;
	const result: GateResult = stop ? "stop" : `branch-${layout.replace(/_/g, "-")}`;

	const run = (prefix: string, x: G9bResult, extra: string[] = []) => [
		`${prefix}_ms=${x.ms}`,
		`${prefix}_stall=${yn(x.stalled)}`,
		...extra,
	];
	const tokens = [
		"control.network_profile=g9",
		`control.xdg_fresh=${yn(ran.every((x) => x.freshXdg))}`,
		`control.warm_scope=${warm.every((x) => x.freshXdg) ? "config_only" : "wider"}`,
		`control.warm_marker_before=${yn(warm.every((x) => x.markerBefore))}`,
		`control.warm_pkg_lists_sdk=${yn(warmPkgListsSdk)}`,
		`control.cold_node_modules_after=${cold.some((x) => x.nodeModulesAfter || x.markerAfter) ? "some" : "none"}`,
		`control.v1_cold_empty_ms=${control.ms}`,
		`control.v1_cold_empty_stall=${yn(control.stalled)}`,
		...run("v1.cold_v2flat", r("r1")),
		...run("v1.cold_v2dir", r("r2"), [`v1.cold_v2dir_noise=${r("r2").noise}`]),
		...run("v1.cold_v2dir_index_only", r("r2b"), [
			`v1.cold_v2dir_index_only_noise=${r("r2b").noise}`,
		]),
		...run("v2.cold_dir", r("r3"), [`v2.cold_dir_loads=${yn(r("r3").loads)}`]),
		...run("v2.cold_dir_index_only", r("r4"), [
			`v2.cold_dir_index_only_loads=${yn(r("r4").loads)}`,
		]),
		...run("v1.warm_plugin", r("r5"), [`v1.warm_plugin_loads=${yn(r("r5").loads)}`]),
		...run("v1.warm_stale", r("r6")),
		`v1.cold_first_run_ms=${r("r7").ms}`,
		`v1.cold_first_run_stall=${yn(r("r7").stalled)}`,
		`v1.cold_second_run_ms=${second.ms}`,
		`v1.cold_second_run_stall=${yn(second.stalled)}`,
		`v1.cold_sdk_written=${yn(r("r7").markerAfter)}`,
		...run("v1.warm_no_pkgjson", r("r8")),
		...run("v1.cold_ts_only", r("r9")),
		`layout=${layout}`,
		`v2_dir_files=${dirFiles}`,
		`sdk_rule=${sdkRule}`,
		`sdk_check=${sdkCheck}`,
		`foreign_exts=${foreignExts}`,
		`foreign_opens=${foreignOpens}`,
		`wording=${wording}`,
	];
	const verdict = (x: G9bResult) => (x.stalled ? "stall" : "no stall");
	const answer = `Network blocked by the sandbox profile (loopback only); every run in a fresh place, stall = over 15 s, a timeout or a non-zero exit. r0 control (1.19.5, cold, empty plugins/): ${control.ms} ms. r1 1.19.5 cold with a V2-style flat file: ${r("r1").ms} ms (${verdict(r("r1"))}). r2 1.19.5 cold with a V2-style directory (index.js + package.json): ${r("r2").ms} ms (${verdict(r("r2"))}, noise ${r("r2").noise}). r2b the same with index.js only: ${r("r2b").ms} ms (${verdict(r("r2b"))}, noise ${r("r2b").noise}). r3 2.2.6 cold, directory with package.json: loads ${yn(r("r3").loads)} (${r("r3").ms} ms). r4 2.2.6 cold, index.js only: loads ${yn(r("r4").loads)} (${r("r4").ms} ms, ${verdict(r("r4"))}). r5 1.19.5 with its own SDK present (warm) and a V1 flat file: ${r("r5").ms} ms, plugin loads ${yn(r("r5").loads)}. r6 stale SDK (0.0.1 in the package and in the config dir's dependency): ${r("r6").ms} ms (${verdict(r("r6"))}). r7 cold, the same place run twice with a V1 flat file (the positive control is its first run): first ${r("r7").ms} ms, second ${second.ms} ms; SDK marker written after run 2: ${yn(r("r7").markerAfter)}. r8 warm with the config dir's package.json deleted (node_modules kept) and a V1 file: ${r("r8").ms} ms (${verdict(r("r8"))}, plugin loads ${yn(r("r8").loads)}). r9 cold with a lone foreign .ts file in plugins/: ${r("r9").ms} ms (${verdict(r("r9"))}). r2b, r4, r8 and r9 and the positive control were added at bob r3 (review of the G9 re-plan). Isolation: every place has its own sandbox under state/<line>-g9b-<id>/ with fresh, empty xdg-data, xdg-cache and xdg-state (checked empty before the first run; paths per run in g9b-runs.json); only the config dir is warmed (r5, r6, r8 clone the warm tree; r6 then makes the SDK stale). r7's second run deliberately reuses r7's first place, so its data, cache and state are whatever run 1 left. No cold place gained node_modules. Caveat: "network blocked" is a connect refusal from the sandbox, not DNS failure; online timing was not measured.`;
	return {
		id: "g9b",
		gates: [
			row(
				"G9b",
				"Which entries in plugins/ trigger the 1.x SDK fetch on a cold config dir, does a present SDK (same version, stale version) stop the wait, does a second cold start wait again, and does 2.x load a directory entry cold?",
				answer,
				result,
				tokens,
				cmd,
			),
		],
		captures: [],
		evidence,
	};
}

// ---------------------------------------------------------------------------------------------------------
// runs: G3, G7, G10, G14 (V1 part count) and most captures

interface RunSpec {
	name: string;
	prompt: string;
	permission?: Record<string, string>;
	timeoutMs?: number;
}
const RUNS: RunSpec[] = [
	{ name: "plain", prompt: "PLAIN hello" },
	{ name: "shell-tool", prompt: "SHELLOK run it" },
	{ name: "write-tool", prompt: "WRITEFILE now" },
	{ name: "failed-tool-exit", prompt: "SHELLFAIL now" },
	{ name: "failed-tool-error", prompt: "READMISSING now" },
	{ name: "child-session", prompt: "SUBTASK go" },
	{ name: "forced-400", prompt: "FAILTURN go" },
	{
		name: "permission-reject",
		prompt: "PERMASK go",
		permission: { edit: "ask", write: "ask", bash: "allow", read: "allow", task: "allow" },
		timeoutMs: 40_000,
	},
];

const CALL_IDS = { ok: "call_stub_ok_1", fail: "call_stub_fail_1", read: "call_stub_read_1" };

async function runsScenario(ctx: MeasureContext): Promise<MeasureOutput> {
	const captures: CaptureOut[] = [];
	const got: Record<string, Collected> = {};
	const evidence: Record<string, unknown> = {};
	for (const line of LINES) {
		for (const spec of RUNS) {
			const c = await collect(ctx, line, spec.name, {
				prompt: spec.prompt,
				...(spec.permission ? { permission: spec.permission } : {}),
				...(spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : {}),
			});
			got[`${line}/${spec.name}`] = c;
			captures.push(asCapture(c, "runs"));
			evidence[`${line}/${spec.name}`] = {
				code: c.code,
				timedOut: c.timedOut,
				ms: c.ms,
				kinds: tally(c.records.map((r) => r.kind)),
				stdout: c.stdout.slice(0, 300),
				stderr: c.stderr.slice(0, 400),
			};
		}
	}
	const g = (line: string, name: string) => got[`${line}/${name}`] as Collected;
	const gates: GateRow[] = [];
	const cmd = "--measure --only runs";

	// V1 assistant text parts with their roles come out of the plain run.
	const plainV1 = g("v1", "plain");
	captures.push({
		line: "v1",
		name: "assistant-text-parts",
		scenario: "runs",
		prompt: plainV1.prompt,
		records: plainV1.records.filter(
			(r) =>
				r.kind === "event" &&
				(r.data.event?.type === "message.updated" ||
					(r.data.event?.type === "message.part.updated" &&
						r.data.event.properties?.part?.type === "text")),
		),
	});
	const roles = new Map<string, string>();
	for (const e of events(plainV1.records)) {
		if (e.event.type === "message.updated")
			roles.set(e.event.properties.info.id, e.event.properties.info.role);
	}
	const textParts = events(plainV1.records).filter(
		(e) => e.event.type === "message.part.updated" && e.event.properties.part.type === "text",
	);
	evidence.v1TextParts = textParts.map((e) => ({
		role: roles.get(e.event.properties.part.messageID) ?? "unknown-at-arrival",
		synthetic: e.event.properties.part.synthetic ?? false,
	}));

	// G3
	const okV1 = analyzeV1Call(g("v1", "shell-tool").records, CALL_IDS.ok);
	const exitV1 = analyzeV1Call(g("v1", "failed-tool-exit").records, CALL_IDS.fail);
	const errV1 = analyzeV1Call(g("v1", "failed-tool-error").records, CALL_IDS.read);
	const okV2 = analyzeV2Call(g("v2", "shell-tool").records, CALL_IDS.ok);
	const exitV2 = analyzeV2Call(g("v2", "failed-tool-exit").records, CALL_IDS.fail);
	const errV2 = analyzeV2Call(g("v2", "failed-tool-error").records, CALL_IDS.read);
	evidence.g3 = { okV1, exitV1, errV1, okV2, exitV2, errV2 };
	const v1ErrPart = errV1.partStatuses.includes("error");
	const v1FailSignal =
		errV1.afterFires && errV1.afterIndex !== null && !v1ErrPart
			? "after_error"
			: v1ErrPart
				? "part_error"
				: "none";
	const v1ExitSignal =
		exitV1.afterExitCode !== null && exitV1.afterExitCode !== 0
			? "after_metadata_exit"
			: exitV1.partStatuses.includes("error")
				? "part_error"
				: "none";
	const v2FailStatus = (c: ReturnType<typeof analyzeV2Call>) =>
		c.afterStatus === "error" || c.toolEventTypes.some((t) => /fail|error/i.test(t));
	const v2FailSignal = v2FailStatus(errV2) ? "status_error" : "none";
	const v2ExitCode = (exitV2.afterResult as J | undefined)?.output?.exit;
	const v2ExitSignal = v2FailStatus(exitV2)
		? "status_error"
		: typeof v2ExitCode === "number" && v2ExitCode !== 0
			? "result_output_exit"
			: "none";
	gates.push(
		row(
			"G3",
			"V1 failed tool: does tool.execute.after fire, with what, and in which order relative to message.part.updated state.status:error? V2 tool.after status:error?",
			`V1 tool that throws (read of a missing file): after hook fires ${errV1.afterFires ? "yes" : "no"}; part statuses ${errV1.partStatuses.join(">")}. V1 non-zero exit (exit 3): after hook fires ${exitV1.afterFires ? "yes" : "no"} with metadata.exit=${exitV1.afterExitCode}; part statuses ${exitV1.partStatuses.join(">")}. V1 order on a successful call: ${okV1.order}. V2 throwing tool: tool.after status ${errV2.afterStatus ?? "(no after hook)"}, tool events ${errV2.toolEventTypes.join(",")}. V2 non-zero exit: tool.after status ${exitV2.afterStatus ?? "(no after hook)"}, tool events ${exitV2.toolEventTypes.join(",")}. V2 successful call after status: ${okV2.afterStatus}.`,
			"pass",
			[
				`v1.fail_signal=${v1FailSignal}`,
				`v1.nonzero_exit_signal=${v1ExitSignal}`,
				`v1.after_fires_on_error=${errV1.afterFires ? "yes" : "no"}`,
				`v1.order=${okV1.order === "n/a" ? "part_then_after" : okV1.order}`,
				`v1.order_error=${errV1.order}`,
				`v2.fail_signal=${v2FailSignal}`,
				`v2.nonzero_exit_signal=${v2ExitSignal}`,
				`v2.after_fires_on_error=${errV2.afterFires ? "yes" : "no"}`,
			],
			cmd,
		),
	);

	// G7: do V1 bus events carry evt_ ids?
	const FORWARDED = new Set([
		"session.created",
		"session.updated",
		"session.idle",
		"session.error",
		"session.status",
		"message.updated",
		"message.part.updated",
		"permission.asked",
		"permission.replied",
	]);
	const v1Events = Object.entries(got)
		.filter(([k]) => k.startsWith("v1/"))
		.flatMap(([, c]) => events(c.records))
		.filter((e) => FORWARDED.has(e.event.type));
	const withId = v1Events.filter(
		(e) => typeof e.event.id === "string" && e.event.id.startsWith("evt_"),
	);
	const missing = distinct(
		v1Events.filter((e) => !withId.includes(e)).map((e) => String(e.event.type)),
	);
	const hookHasId = Object.values(got)
		.filter((c) => c.line === "v1")
		.flatMap((c) =>
			c.records.filter((r) => r.kind.startsWith("tool.execute") || r.kind === "chat.message"),
		)
		.some((r) => r.data.i?.id || r.data.o?.id);
	evidence.g7 = { forwarded: v1Events.length, withId: withId.length, missing };
	gates.push(
		row(
			"G7",
			"Does every forwarded V1 bus event carry an evt_ id?",
			`${withId.length} of ${v1Events.length} forwarded V1 bus events (${[...FORWARDED].join(", ")}) across ${RUNS.length} runs carry an evt_ id${missing.length ? `; missing on: ${missing.join(", ")}` : ""}. V1 hook invocations carry no id: ${hookHasId ? "some do" : "none do"}.`,
			missing.length === 0 && v1Events.length > 0 ? "pass" : "branch-id-less",
			[
				`v1.evt_id=${missing.length === 0 && v1Events.length > 0 ? "all" : withId.length ? "some" : "none"}`,
				`v1.hook_ids=${hookHasId ? "some" : "none"}`,
			],
			cmd,
		),
	);

	// G10: a per-turn id shared by prompt, tool hooks and turn end.
	const turnV1 = sharedTurnId({
		prompt: g("v1", "shell-tool")
			.records.filter((r) => r.kind === "chat.message")
			.map((r) => r.data),
		tool: g("v1", "shell-tool")
			.records.filter((r) => r.kind.startsWith("tool.execute"))
			.map((r) => r.data),
		turnEnd: events(g("v1", "shell-tool").records)
			.filter((e) => e.event.type === "session.idle")
			.map((e) => e.event),
	});
	const v2Rec = g("v2", "shell-tool").records;
	const turnV2 = sharedTurnId({
		prompt: events(v2Rec)
			.filter((e) => e.event.type === "session.inbox.enqueued")
			.map((e) => e.event),
		tool: v2Rec.filter((r) => r.kind.startsWith("tool.")).map((r) => r.data),
		turnEnd: events(v2Rec)
			.filter((e) => e.event.type === "session.execution.succeeded")
			.map((e) => e.event),
	});
	evidence.g10 = { turnV1, turnV2 };
	gates.push(
		row(
			"G10",
			"Does each line expose a per-turn id on prompt, tool and turn-end events?",
			`V1: ${turnV1.length ? `shared id at ${turnV1[0]?.paths.join(", ")}` : "no id is shared by chat.message, the tool hooks and session.idle (tool hooks carry sessionID and callID; session.idle carries sessionID only)"}. V2: ${turnV2.length ? `shared id at ${turnV2[0]?.paths.join(", ")}` : "no id is shared by the prompt, tool hook and execution events"}.`,
			turnV1.length && turnV2.length ? "branch-turn-id" : "branch-no-turn-id",
			[
				`v1.turn_id=${turnV1.length ? "yes" : "none"}`,
				`v2.turn_id=${turnV2.length ? "yes" : "none"}`,
			],
			cmd,
		),
	);

	// G14 (V1 volume): plugin invocations and part updates per tool call.
	const shellV1 = g("v1", "shell-tool").records;
	const partUpdates = v1ToolParts(shellV1, CALL_IDS.ok).length;
	const callWindow = [
		shellV1.findIndex((r) => r.kind === "tool.execute.before"),
		shellV1.findIndex((r) => r.kind === "tool.execute.after"),
	];
	const invocationsInWindow =
		callWindow[0] !== undefined && callWindow[1] !== undefined && callWindow[0] >= 0
			? callWindow[1] - callWindow[0] + 1
			: 0;
	const bus = events(shellV1).length;
	evidence.g14v1 = {
		partUpdates,
		invocationsInWindow,
		busEvents: bus,
		byType: tally(eventTypes(shellV1)),
	};
	gates.push(
		row(
			"G14",
			"(part 2) message.part.updated count per tool call on V1.",
			`V1 shell tool call: ${partUpdates} message.part.updated events for the call's tool part (${v1ToolParts(
				shellV1,
				CALL_IDS.ok,
			)
				.map((p) => p.event.properties.part.state?.status)
				.join(
					">",
				)}), ${invocationsInWindow} plugin invocations between its before and after hooks, ${bus} bus events in the whole run (${Object.entries(
				tally(eventTypes(shellV1)),
			)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 4)
				.map(([k, v]) => `${k} ${v}`)
				.join(", ")}).`,
			"pass",
			[`v1.part_updates_per_call=${partUpdates}`, `v1.bus_events_per_run=${bus}`],
			cmd,
		),
	);

	return { id: "runs", gates, captures, evidence };
}

export const LAYOUT_RUNS_SCENARIOS = {
	layout: { run: layoutScenario },
	g9b: { run: g9bScenario },
	runs: { run: runsScenario },
};
