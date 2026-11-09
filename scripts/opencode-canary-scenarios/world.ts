/**
 * The canary's world (AGEN-141, phase 0): one scratch run directory, the model stub, a capture endpoint and the
 * "places" (one throwaway OpenCode person each: home, XDG tree, config with the stub provider and a measurement
 * probe). Everything OpenCode touches is under `root`. Nothing here starts OpenCode except through
 * `lib/opencode-canary-spawn.ts`.
 */
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type LlmStubServer,
	startLlmStubServer,
} from "../../src/server/test-utils/llm-stub-server.js";
import type { OpenCodeLine } from "../lib/opencode-canary-pins.js";
import {
	type OpenCodeChild,
	type OpenCodeRunResult,
	type Sandbox,
	makeSandbox,
	runOpenCode,
	startOpenCode,
} from "../lib/opencode-canary-spawn.js";
import { type RuleWorld, canaryRules } from "./stub-rules.js";

export interface CapturedPost {
	t: number;
	path: string;
	headers: Record<string, string>;
	body: string;
}

export interface CaptureServer {
	origin: string;
	posts: CapturedPost[];
	/** How many raw POSTs carried each id (`id`, `data.id`, `X-AgentPulse-Delivery-Id`). */
	countsById(): Map<string, number>;
	stop(): void;
}

/** A loopback endpoint that records every POST it gets, before anything is forwarded. */
export function startCaptureServer(): CaptureServer {
	const posts: CapturedPost[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const headers: Record<string, string> = {};
			req.headers.forEach((v, k) => {
				headers[k] = v;
			});
			const body = await req.text();
			posts.push({
				t: Date.now(),
				path: new URL(req.url).pathname,
				headers,
				body: body.slice(0, 65_536),
			});
			return new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
		},
	});
	return {
		origin: `http://127.0.0.1:${server.port}`,
		posts,
		countsById() {
			const counts = new Map<string, number>();
			for (const p of posts) {
				let id: string | undefined = p.headers["x-agentpulse-delivery-id"];
				if (!id) {
					try {
						const parsed = JSON.parse(p.body) as { id?: string; data?: { id?: string } };
						id = parsed.id ?? parsed.data?.id;
					} catch {}
				}
				if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
			}
			return counts;
		},
		stop: () => void server.stop(true),
	};
}

export interface World {
	/** The run's scratch root: everything lives under it. */
	root: string;
	bins: Record<OpenCodeLine, string>;
	/** A warm 1.x config directory to clone into 1.x places (see `PlaceOptions.warmFrom`). */
	v1Warm?: string;
	stub: LlmStubServer;
	rule: RuleWorld;
	capture: CaptureServer;
	/** Raw logs, one directory per scenario, for the record. */
	logs: string;
}

export function makeWorld(
	root: string,
	bins: Record<OpenCodeLine, string>,
	v1Warm?: string,
): World {
	mkdirSync(join(root, "logs"), { recursive: true });
	mkdirSync(join(root, "proj"), { recursive: true });
	const rule: RuleWorld = { scratchRoot: root, projectDir: join(root, "proj", "default") };
	const stub = startLlmStubServer({ rules: (body, record) => canaryRules(rule)(body, record) });
	return {
		root,
		bins,
		...(v1Warm ? { v1Warm } : {}),
		stub,
		rule,
		capture: startCaptureServer(),
		logs: join(root, "logs"),
	};
}

export function stopWorld(world: World): void {
	world.capture.stop();
	world.stub.reset();
	void world.stub.stop().catch(() => undefined);
}

export interface Place {
	line: OpenCodeLine;
	label: string;
	sandbox: Sandbox;
	/** `<xdg-config>/opencode`, OpenCode's global config directory. */
	configDir: string;
	pluginsDir: string;
	probeLog: string;
}

const PROBE_SOURCES: Record<OpenCodeLine, string> = {
	v1: join(import.meta.dir, "probes", "probe-v1.js"),
	v2: join(import.meta.dir, "probes", "probe-v2.js"),
};

export interface PlaceOptions {
	/** The permission block for opencode.json. */
	permission?: Record<string, string>;
	/** Install the probe (default true). */
	probe?: boolean;
	/** Replaces `@@PROBE_TAG@@` in the probe source. */
	probeTag?: string;
	/** The file name inside `plugins/` (default `probe.js`). */
	probeFile?: string;
	/** Write config and plugins here instead of the XDG config dir (`OPENCODE_CONFIG_DIR` runs). */
	configDirOverride?: string;
	/**
	 * 1.x only. A config directory a previous online run already filled with its plugin SDK
	 * (`package.json`, `node_modules`, lock files); cloned in so the run doesn't wait on the network, which a
	 * canary doesn't have (G9 measures what happens without it).
	 */
	warmFrom?: string;
}

/** A new place: sandbox, config with the stub provider and the permission block, and the probe plugin. */
export function makePlace(
	world: World,
	line: OpenCodeLine,
	label: string,
	options: PlaceOptions = {},
): Place {
	const sandbox = makeSandbox(world.root, `${line}-${label}`);
	const configDir = options.configDirOverride ?? join(sandbox.paths.XDG_CONFIG_HOME, "opencode");
	const pluginsDir = join(configDir, "plugins");
	mkdirSync(pluginsDir, { recursive: true });
	const config = {
		$schema: "https://opencode.ai/config.json",
		autoupdate: false,
		share: "disabled",
		model: "stub/stub-model",
		small_model: "stub/stub-model",
		provider: {
			stub: {
				npm: "@ai-sdk/openai-compatible",
				name: "Stub",
				options: { baseURL: `${world.stub.origin}/v1`, apiKey: "x" },
				models: {
					"stub-model": {
						name: "Stub",
						tool_call: true,
						limit: { context: 100_000, output: 8000 },
					},
				},
			},
		},
		permission: options.permission ?? {
			bash: "allow",
			edit: "allow",
			write: "allow",
			task: "allow",
			read: "allow",
		},
	};
	writeFileSync(join(configDir, "opencode.json"), JSON.stringify(config));
	const warm = options.warmFrom ?? (line === "v1" ? world.v1Warm : undefined);
	if (warm && options.warmFrom !== "") cloneWarmDeps(warm, configDir);
	const probeLog = join(sandbox.stateDir, "probe.jsonl");
	if (options.probe !== false) {
		installProbe(
			world,
			line,
			configDir,
			probeLog,
			options.probeTag ?? "A",
			options.probeFile ?? "probe.js",
		);
	}
	return { line, label, sandbox, configDir, pluginsDir, probeLog };
}

/** The probe source of `line`, with its tag filled in. `depth` is how many directories the file sits below `plugins/`, plus one (a flat file is 1, `plugins/x/index.js` is 2); 0 keeps the flat path. */
export function probeSource(line: OpenCodeLine, tag: string, depth = 0): string {
	let source = readFileSync(PROBE_SOURCES[line], "utf8").replace("@@PROBE_TAG@@", tag);
	if (depth > 0) {
		source = source.replace(
			'path.join(here, "..", "probe-config.json")',
			`path.join(here, ${Array(depth).fill('".."').join(", ")}, "probe-config.json")`,
		);
	}
	return source;
}

/** Puts a probe plugin (flat, in `<configDir>/plugins/<file>`) and its settings file in place. */
export function installProbe(
	world: World,
	line: OpenCodeLine,
	configDir: string,
	probeLog: string,
	tag: string,
	file = "probe.js",
): void {
	mkdirSync(join(configDir, "plugins"), { recursive: true });
	writeFileSync(join(configDir, "plugins", file), probeSource(line, tag));
	writeFileSync(
		join(configDir, "probe-config.json"),
		JSON.stringify({ log: probeLog, post: `${world.capture.origin}/probe` }),
	);
}

export function cloneWarmDeps(from: string, to: string): void {
	for (const name of [
		"package.json",
		"node_modules",
		"bun.lock",
		"package-lock.json",
		".gitignore",
	]) {
		const source = join(from, name);
		if (!existsSync(source)) continue;
		// `cp -c` clones on APFS (the 60 MB tree costs nothing); it falls back to a copy elsewhere.
		const r = spawnSync("cp", ["-cR", source, join(to, name)]);
		if (r.status !== 0) spawnSync("cp", ["-R", source, join(to, name)]);
	}
}

export function projectDir(world: World, name: string): string {
	const dir = join(world.root, "proj", name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export interface TurnOptions {
	cwd: string;
	args?: string[];
	prompt?: string;
	timeoutMs?: number;
	extraEnv?: Record<string, string>;
	configDir?: string;
	label?: string;
}

let runCounter = 0;
const logBase = (world: World, place: Place, label?: string) =>
	join(
		world.logs,
		`${String(++runCounter).padStart(3, "0")}-${place.line}-${place.label}-${label ?? "run"}`,
	);

/** `opencode run <prompt>` in `cwd`; sets the stub's project directory first. */
export function runTurn(
	world: World,
	place: Place,
	options: TurnOptions,
): Promise<OpenCodeRunResult> {
	world.rule.projectDir = options.cwd;
	return runOpenCode({
		line: place.line,
		bin: world.bins[place.line],
		args: options.args ?? ["run", options.prompt ?? "PLAIN hello"],
		sandbox: place.sandbox,
		cwd: options.cwd,
		...(options.configDir ? { configDir: options.configDir } : {}),
		...(options.extraEnv ? { extraEnv: options.extraEnv } : {}),
		timeoutMs: options.timeoutMs ?? 60_000,
		logBase: logBase(world, place, options.label),
	});
}

export function startLong(
	world: World,
	place: Place,
	args: string[],
	cwd: string,
	label: string,
	extra: { configDir?: string; extraEnv?: Record<string, string>; timeoutMs?: number } = {},
): Promise<OpenCodeChild> {
	world.rule.projectDir = cwd;
	return startOpenCode({
		line: place.line,
		bin: world.bins[place.line],
		args,
		sandbox: place.sandbox,
		cwd,
		...(extra.configDir ? { configDir: extra.configDir } : {}),
		...(extra.extraEnv ? { extraEnv: extra.extraEnv } : {}),
		timeoutMs: extra.timeoutMs ?? 300_000,
		logBase: logBase(world, place, label),
	});
}

export interface ProbeRecord {
	t: number;
	pid: number;
	tag: string;
	kind: string;
	// biome-ignore lint/suspicious/noExplicitAny: probe logs are untyped JSON from two OpenCode lines.
	data: Record<string, any>;
}

export function readProbe(place: Place): ProbeRecord[] {
	if (!existsSync(place.probeLog)) return [];
	return readFileSync(place.probeLog, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as ProbeRecord;
			} catch {
				return { t: 0, pid: 0, tag: "", kind: "unparsed", data: { line } };
			}
		});
}

export function clearProbe(place: Place): void {
	writeFileSync(place.probeLog, "");
}

/** Waits until `predicate()` is true or `ms` pass. */
export async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	ms: number,
	step = 100,
): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await predicate()) return true;
		await Bun.sleep(step);
	}
	return predicate();
}

export const listDir = (dir: string): string[] => {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
};

export function copyInto(source: string, dir: string, name: string): void {
	mkdirSync(dir, { recursive: true });
	copyFileSync(source, join(dir, name));
}
