/**
 * The OpenCode live canary (AGEN-141). Phase 0 has `--measure` only: it runs the measurement gates G1-G15 and
 * writes the raw record, the captures and the gate answers; later phases add the product scenarios.
 *
 *   bun scripts/opencode-observe-canary.ts --measure --v1-bin <path> --v2-bin <path> --work <scratch dir>
 *       [--only <id,id>] [--result <file>] [--keep-alive <pid,pid>]
 *
 * Safety: OpenCode starts only through `lib/opencode-canary-spawn.ts` (pinned binary, sandbox asserted before
 * every spawn, stdin closed). Before and after the run it snapshots the person's real OpenCode, `.agentpulse`,
 * `.claude` and `.codex` directories and the launchd labels, and fails on any change. Loopback only; the model
 * is a stub. A process is signalled only by a pid this run started or one naming this run's XDG_DATA_HOME.
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { EXIT } from "./lib/canary-verdict.js";
import { OPENCODE_PINS, type OpenCodeLine } from "./lib/opencode-canary-pins.js";
import { REAL_HOME } from "./lib/opencode-canary-safety.js";
import {
	assertPinnedBinary,
	makeSandbox,
	runOpenCode,
	startedPids,
} from "./lib/opencode-canary-spawn.js";
import {
	type RealStateSnapshot,
	bootoutOwnLabels,
	diffLabels,
	diffRealState,
	launchdServiceLabels,
	nonLoopbackPeers,
	opencodeLaunchdLabels,
	snapshotRealState,
} from "./lib/opencode-canary-watch.js";
import { ownOpenCodePids } from "./lib/opencode-own-pids.js";
import { installOpenCodeGuard } from "./opencode-canary-guard.js";
import type { Rec } from "./opencode-canary-scenarios/analyze.js";
import {
	PARTIAL_SCENARIOS,
	emitFixtures,
	insertGateRows,
} from "./opencode-canary-scenarios/emit.js";
import { MEASURE_SCENARIOS } from "./opencode-canary-scenarios/index.js";
import type { MeasureOutput } from "./opencode-canary-scenarios/measure-kit.js";
import { makeWorld, stopWorld } from "./opencode-canary-scenarios/world.js";

interface Options {
	measure: boolean;
	v1Bin?: string;
	v2Bin?: string;
	v1Warm?: string;
	emit?: string;
	work?: string;
	only?: string[];
	result?: string;
	keepAlive: number[];
}

function parseArgs(argv: string[]): Options {
	const options: Options = { measure: false, keepAlive: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} needs a value`);
			return value;
		};
		if (arg === "--measure") options.measure = true;
		else if (arg === "--v1-bin") options.v1Bin = next();
		else if (arg === "--v2-bin") options.v2Bin = next();
		else if (arg === "--emit") options.emit = next();
		else if (arg === "--v1-warm") options.v1Warm = next();
		else if (arg === "--work") options.work = next();
		else if (arg === "--only") options.only = next().split(",");
		else if (arg === "--result") options.result = next();
		else if (arg === "--keep-alive") options.keepAlive = next().split(",").map(Number);
		else throw new Error(`unknown option ${arg}`);
	}
	return options;
}

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/** Read-only look at which processes' command lines mention the supervisor (never signalled). */
function supervisorPids(): number[] {
	const r = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 32 << 20 });
	return r.stdout
		.split("\n")
		.filter(
			(l) => /agentpulse/.test(l) && /supervisor/.test(l) && !/opencode-observe-canary/.test(l),
		)
		.map((l) => Number(l.trim().split(/\s+/)[0]))
		.filter((n) => Number.isInteger(n) && n !== process.pid);
}

async function main(): Promise<number> {
	let options: Options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(String((error as Error).message));
		return EXIT.usage;
	}
	if (!options.measure || !options.v1Bin || !options.v2Bin || !options.work) {
		console.error(
			"usage: --measure --v1-bin <path> --v2-bin <path> --work <dir> [--only ids] [--result file]",
		);
		return EXIT.usage;
	}
	mkdirSync(options.work, { recursive: true });
	const root = realpathSync(resolve(options.work));
	const bins: Record<OpenCodeLine, string> = {
		v1: resolve(options.v1Bin),
		v2: resolve(options.v2Bin),
	};
	const guard = installOpenCodeGuard();

	// Pins first: the checksum of each binary, before any run.
	for (const line of ["v1", "v2"] as const) await assertPinnedBinary(bins[line], line);

	const before: RealStateSnapshot = snapshotRealState(REAL_HOME);
	const launchdBefore = launchdServiceLabels();
	const labelsBefore = opencodeLaunchdLabels();
	const supervisorBefore = supervisorPids();
	const keepAlive = [...new Set([...options.keepAlive, ...supervisorBefore])];

	// A V2 run is refused when launchd already holds an opencode label: a service run could not be told apart.
	if (labelsBefore.length > 0) {
		console.error(`refused: launchd already has ${labelsBefore.join(", ")}`);
		return EXIT.instrumentInvalid;
	}

	const world = makeWorld(root, bins, options.v1Warm ? resolve(options.v1Warm) : undefined);
	guard.onCleanup(() => stopWorld(world));

	// The network watch: every second, the sockets of this run's own pids must all be loopback.
	const violations: string[] = [];
	const dataHomes = new Set<string>();
	const sampler = setInterval(() => {
		const pids = new Set<number>(startedPids);
		for (const home of dataHomes) for (const pid of ownOpenCodePids(home)) pids.add(pid);
		for (const line of nonLoopbackPeers([...pids])) violations.push(line);
	}, 1000);
	sampler.unref();

	const outputs: MeasureOutput[] = [];
	const perScenarioChanges: string[] = [];
	const instrument: string[] = [];
	try {
		// The version of each binary, through the sandbox like every other run.
		const versions: Record<string, string> = {};
		for (const line of ["v1", "v2"] as const) {
			const sandbox = makeSandbox(root, `version-${line}`);
			dataHomes.add(sandbox.paths.XDG_DATA_HOME);
			guard.addDataHome(sandbox.paths.XDG_DATA_HOME);
			mkdirSync(join(root, "proj", "version"), { recursive: true });
			const r = await runOpenCode({
				line,
				bin: bins[line],
				args: ["--version"],
				sandbox,
				cwd: join(root, "proj", "version"),
				timeoutMs: 20_000,
				logBase: join(world.logs, `version-${line}`),
			});
			versions[line] = r.stdout.trim();
			if (!OPENCODE_PINS[line].versionOutput.test(versions[line])) {
				instrument.push(`${line} --version printed ${JSON.stringify(versions[line])}`);
			}
		}
		const ids = options.only ?? Object.keys(MEASURE_SCENARIOS);
		for (const id of ids) {
			const scenario = MEASURE_SCENARIOS[id];
			if (!scenario) {
				console.error(`no measurement scenario ${id}`);
				return EXIT.usage;
			}
			console.error(`[measure] ${id}`);
			const scenarioBefore = snapshotRealState(REAL_HOME);
			const out = await scenario.run({
				world,
				versions,
				noteDataHome: (dir) => {
					dataHomes.add(dir);
					guard.addDataHome(dir);
				},
			});
			outputs.push(out);
			instrument.push(...(out.invalid ?? []));
			const moved = diffRealState(scenarioBefore, snapshotRealState(REAL_HOME)).failures;
			if (moved.length > 0) perScenarioChanges.push(...moved.map((m) => `${id}: ${m}`));
		}
	} finally {
		clearInterval(sampler);
	}

	const after = snapshotRealState(REAL_HOME);
	const { failures: wholeRun, informational } = diffRealState(before, after);
	const changes = [...wholeRun, ...perScenarioChanges];
	const labelsAfter = opencodeLaunchdLabels();
	const newLabels = labelsAfter.filter((l) => !labelsBefore.includes(l));
	const bootout = newLabels.length ? bootoutOwnLabels(newLabels, root) : [];
	const launchdDiff = diffLabels(launchdBefore, launchdServiceLabels());
	const strayPids = [...dataHomes].flatMap((h) => ownOpenCodePids(h));
	const keepAliveReport = Object.fromEntries(keepAlive.map((pid) => [pid, alive(pid)]));

	const record = {
		gates: outputs.flatMap((o) => o.gates),
		safety: {
			realStateChanges: changes,
			otherAgentsMoved: informational.length,
			launchdLabelsBefore: labelsBefore,
			launchdLabelsAfter: labelsAfter,
			launchdLabelDiff: launchdDiff,
			bootout,
			nonLoopbackPeers: violations,
			strayOpenCodePids: strayPids,
			keepAlive: keepAliveReport,
			instrument,
		},
	};
	const resultPath = options.result ?? join(root, "measure-result.json");
	writeFileSync(resultPath, JSON.stringify({ ...record, outputs }, null, 2));
	console.error(`[measure] wrote ${resultPath}`);
	guard.cleanup();

	if (
		options.emit &&
		changes.length === 0 &&
		instrument.length === 0 &&
		outputs.length > 0 &&
		outputs.every((o) => PARTIAL_SCENARIOS.has(o.id))
	) {
		insertGateRows({
			rows: outputs.flatMap((o) => o.gates),
			versions: { v1: OPENCODE_PINS.v1.version, v2: OPENCODE_PINS.v2.version },
			outDir: resolve(options.emit),
			work: root,
			realHome: REAL_HOME,
			evidence: Object.assign({}, ...outputs.map((o) => o.evidence)),
		});
		spawnSync("bunx", ["biome", "format", "--write", resolve(options.emit)], { encoding: "utf8" });
		console.error(
			`[measure] inserted ${outputs.flatMap((o) => o.gates).length} gate row(s) into ${options.emit}`,
		);
	} else if (options.emit && changes.length === 0) {
		const allRecords: Record<"v1" | "v2", Rec[]> = { v1: [], v2: [] };
		for (const line of ["v1", "v2"] as const) {
			const dir = join(root, "records", line);
			if (!existsSync(dir)) continue;
			for (const file of readdirSync(dir)) {
				for (const text of readFileSync(join(dir, file), "utf8").split("\n")) {
					if (text) allRecords[line].push(JSON.parse(text) as Rec);
				}
			}
		}
		const layout = outputs.find((o) => o.id === "layout")?.evidence.surfaceCtx as
			| Record<string, string[]>
			| undefined;
		const emitted = emitFixtures({
			outputs,
			versions: { v1: OPENCODE_PINS.v1.version, v2: OPENCODE_PINS.v2.version },
			outDir: resolve(options.emit),
			work: root,
			realHome: REAL_HOME,
			allRecords,
			reducedCtx: layout?.v1_given_v2_file ?? [],
		});
		// The repository formats JSON; a fixture written compact would fail `bun run check`.
		spawnSync("bunx", ["biome", "format", "--write", resolve(options.emit)], { encoding: "utf8" });
		console.error(`[measure] emitted ${emitted.files.length} captures to ${options.emit}`);
	}

	const unsafe =
		changes.length > 0 ||
		newLabels.length > 0 ||
		violations.length > 0 ||
		strayPids.length > 0 ||
		Object.values(keepAliveReport).some((a) => !a);
	if (unsafe) return EXIT.fail;
	if (instrument.length > 0) return EXIT.instrumentInvalid;
	return EXIT.ok;
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.error(error);
		process.exit(EXIT.fail);
	},
);
