/**
 * The product scenarios of the OpenCode live canary (AGEN-141, plan step 20): the real plugins, loaded the way an
 * installer lays them out, inside a real OpenCode 1.x and 2.x, posting to an in-process server that records every
 * raw POST (with a random 0-50 ms delay so arrival order isn't luck) and forwards each to the real ingest routes.
 * Everything runs through `lib/opencode-canary-spawn.ts`; the model is the stub. The plugins are installed by running
 * the real `scripts/setup-hooks.sh` against a scratch HOME (the relay scenario excepted: see `installRelayPlugins`).
 * This file is the kit; the scenarios are in `product.ts` and `product-more.ts`.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildBashExcludeScript } from "../../src/shared/hook-command.ts";
import { buildOpenCodePluginFiles } from "../../src/shared/opencode-plugin.ts";
import type { Expectation } from "../lib/canary-verdict.ts";
import { type Line, applyMutation, applySetupMutation } from "../lib/opencode-canary-mutations.ts";
import { makePlace, projectDir, runTurn } from "./world.ts";
import type { Place, World } from "./world.ts";

export interface ProductPost {
	t: number;
	headers: Record<string, string>;
	body: Record<string, any>;
}

export interface ProductServer {
	origin: string;
	posts: ProductPost[];
	/** Requests the real ingest route answered with an error (a bad key, a malformed body). */
	rejected: Array<{ status: number; headers: Record<string, string> }>;
	delayMs: { fixed: number | null };
	/** A real key minted in the in-process database; the plugin's direct-mode requests carry it. */
	key: string;
	rows(): Promise<{ sessions: Array<Record<string, any>>; events: Array<Record<string, any>> }>;
	reset(): Promise<void>;
	stop(): void;
}

/** The in-process server: records, delays, and forwards each POST to the real hook route with a test database. */
export async function startProductServer(): Promise<ProductServer> {
	process.env.AP_CANARY_PRODUCT = "1";
	await import("../../src/server/services/ai/__test_db.js");
	const { Hono } = await import("hono");
	const { config } = await import("../../src/server/config.js");
	const { getDb, initializeDatabase } = await import("../../src/server/db/client.js");
	const { createApiKey } = await import("../../src/server/auth/api-key.js");
	const { events, sessions } = await import("../../src/server/db/schema/index.js");
	const { ingest, getInFlightCount } = await import("../../src/server/routes/ingest.js");
	await initializeDatabase();
	// Real auth: the plugin's key file and Authorization header are part of what the canary proves.
	config.disableAuth = false;
	const { key } = await createApiKey("opencode-canary", ["ingest"]);
	const app = new Hono().route("/api/v1", ingest);
	const posts: ProductPost[] = [];
	const delayMs = { fixed: null as number | null };
	const rejected: Array<{ status: number; headers: Record<string, string> }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const raw = await req.text();
			const headers: Record<string, string> = {};
			req.headers.forEach((v, k) => {
				headers[k] = v;
			});
			let body: Record<string, any> = {};
			try {
				body = JSON.parse(raw);
			} catch {}
			// The jitter comes before the request is recorded, so concurrent POSTs can overtake each other.
			await new Promise((r) => setTimeout(r, delayMs.fixed ?? Math.random() * 50));
			posts.push({ t: Date.now(), headers, body });
			// Like the real route, answer at once and store in the background, in arrival order.
			forwards = forwards.then(() => forward(raw, headers)).catch(() => undefined);
			return Response.json({ ok: true });
		},
	});
	let forwards: Promise<unknown> = Promise.resolve();
	const settle = async () => {
		for (let i = 0; i < 400; i++) {
			await forwards;
			if (getInFlightCount() === 0) return;
			await new Promise((r) => setTimeout(r, 10));
		}
	};
	async function forward(raw: string, headers: Record<string, string>) {
		{
			const res = await app.request("/api/v1/hooks", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-agent-type": headers["x-agent-type"] ?? "opencode",
					...(headers.authorization ? { authorization: headers.authorization } : {}),
					...(headers["x-agentpulse-host"]
						? { "x-agentpulse-host": headers["x-agentpulse-host"] }
						: {}),
					...(headers["x-agentpulse-delivery-id"]
						? { "x-agentpulse-delivery-id": headers["x-agentpulse-delivery-id"] }
						: {}),
				},
				body: raw,
			});
			if (res.status >= 400) rejected.push({ status: res.status, headers });
			for (let i = 0; i < 200 && getInFlightCount() > 0; i++)
				await new Promise((r) => setTimeout(r, 5));
		}
	}
	return {
		origin: `http://127.0.0.1:${server.port}`,
		posts,
		delayMs,
		key,
		rejected,
		async rows() {
			await settle();
			return {
				sessions: await getDb().select().from(sessions),
				events: await getDb().select().from(events),
			};
		},
		async reset() {
			await settle();
			posts.length = 0;
			rejected.length = 0;
			await getDb().delete(events).execute();
			await getDb().delete(sessions).execute();
		},
		stop: () => void server.stop(true),
	};
}

export interface ProductCtx {
	world: World;
	server: ProductServer;
	mutation: string | null;
	noteDataHome: (dir: string) => void;
}

export interface ProductResult {
	scenario: string;
	line: Line;
	mutation: string | null;
	expectations: Expectation[];
	notRun?: string;
	detail?: unknown;
}

export const NOISE = /\b(ERROR|WARN)\b|agentpulse|plugin/i;

export function expect(
	list: Expectation[],
	name: string,
	kind: Expectation["kind"],
	ok: boolean,
	detail?: unknown,
) {
	list.push({ name, kind, ok, ...(detail === undefined ? {} : { detail }) });
}

/** The relay scenario's layout: the `direct: false` plugin text for the in-process relay's URL, laid out as G9b says. */
export function installRelayPlugins(
	place: Place,
	origin: string,
	options: { mutation?: string | null; lines?: Line[] } = {},
): void {
	// The relay installer puts the exclude check beside the plugins; without it a rules file fails closed.
	const agentpulse = join(place.sandbox.paths.HOME, ".agentpulse");
	mkdirSync(agentpulse, { recursive: true });
	chmodSync(agentpulse, 0o700);
	rmSync(join(agentpulse, "exclude-check.sh"), { force: true });
	writeFileSync(join(agentpulse, "exclude-check.sh"), buildBashExcludeScript(), { mode: 0o500 });
	const files = buildOpenCodePluginFiles({ baseUrl: origin, direct: false });
	for (const file of files) {
		const line: Line = file.name.includes("-1") ? "v1" : "v2";
		if (options.lines && !options.lines.includes(line)) continue;
		const text =
			options.mutation && line === place.line
				? applyMutation(options.mutation, line, file.text)
				: file.text;
		const target = join(place.pluginsDir, file.name);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, text);
	}
}

export function writeRules(place: Place, rules: string[]): void {
	const home = place.sandbox.paths.HOME;
	const dir = join(home, ".agentpulse");
	mkdirSync(dir, { recursive: true });
	chmodSync(dir, 0o700);
	writeFileSync(join(dir, "exclude"), `${rules.join("\n")}\n`, { mode: 0o600 });
	chmodSync(join(dir, "exclude"), 0o600);
}

/** One body per delivery id: the exit flush may send an in-flight item a second time, and the server keeps one. */
export const bodiesOf = (s: ProductServer) => {
	const seen = new Set<string>();
	const out: Array<Record<string, any>> = [];
	for (const p of s.posts) {
		const id = p.headers["x-agentpulse-delivery-id"] ?? JSON.stringify(p.body);
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(p.body);
	}
	return out;
};

/** The recorded duration of each tool call in `opencode run --format json` output (OpenCode's own start and end). */
export function toolDurationsMs(stdout: string): number[] {
	const out: number[] = [];
	for (const text of stdout.split("\n")) {
		if (!text.startsWith("{")) continue;
		try {
			const e = JSON.parse(text) as {
				type?: string;
				part?: { state?: { time?: { start?: number; end?: number } } };
			};
			const t = e.part?.state?.time;
			if (e.type === "tool_use" && t && typeof t.start === "number" && typeof t.end === "number") {
				out.push(t.end - t.start);
			}
		} catch {}
	}
	return out;
}

export async function turn(
	ctx: ProductCtx,
	place: Place,
	name: string,
	prompt: string,
	extra: {
		extraEnv?: Record<string, string>;
		json?: boolean;
		settleMs?: number;
		args?: string[];
		timeoutMs?: number;
	} = {},
) {
	const cwd = projectDir(ctx.world, name);
	ctx.noteDataHome(place.sandbox.paths.XDG_DATA_HOME);
	const r = await runTurn(ctx.world, place, {
		cwd,
		timeoutMs: extra.timeoutMs ?? 90_000,
		...(extra.args
			? { args: extra.args }
			: extra.json
				? { args: ["run", "--format", "json", prompt] }
				: { prompt }),
		...(extra.extraEnv ? { extraEnv: extra.extraEnv } : {}),
	});
	// The plugin's chain may still be sending when `run` exits (on 2.x the plugin lives in a private server that
	// can outlive it by a moment): wait until the proxy has heard nothing new for the settle window.
	const window = extra.settleMs ?? 700;
	if (window > 0) {
		let seen = -1;
		let since = Date.now();
		const limit = Date.now() + 10_000;
		while (Date.now() < limit) {
			const n = ctx.server.posts.length;
			if (n !== seen) {
				seen = n;
				since = Date.now();
			} else if (Date.now() - since >= window) break;
			await new Promise((res) => setTimeout(res, 50));
		}
	}
	return { r, cwd };
}

export type ProductScenario = (ctx: ProductCtx, line: Line) => Promise<ProductResult>;

export const result = (
	scenario: string,
	line: Line,
	ctx: ProductCtx,
	expectations: Expectation[],
	detail?: unknown,
): ProductResult => ({
	scenario,
	line,
	mutation: ctx.mutation,
	expectations,
	detail: {
		...(detail as object | undefined),
		posts: ctx.server.posts.map((p) => p.body.hook_event_name),
		rejected: ctx.server.rejected.map((r) => r.status),
	},
});

export interface SetupRun {
	code: number;
	out: string;
	script: string;
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
let scriptCounter = 0;

/** The installer to run: the real one, or (for `no-sdk-check`) a scratch copy with the SDK predicate forced true. */
export function setupScriptFor(ctx: ProductCtx): string {
	const real = join(REPO_ROOT, "scripts", "setup-hooks.sh");
	if (ctx.mutation !== "no-sdk-check") return real;
	const copy = join(ctx.world.root, `setup-hooks-mutated-${++scriptCounter}.sh`);
	writeFileSync(copy, applySetupMutation("no-sdk-check", readFileSync(real, "utf8")), {
		mode: 0o600,
	});
	return copy;
}

/** The real installer's command line (a shell script; it never runs the agent). */
function installerArgv(
	ctx: ProductCtx,
	script: string,
	options: { force?: boolean; no?: boolean; url?: string },
): string[] {
	return [
		"/bin/bash",
		script,
		"--url",
		options.url ?? ctx.server.origin,
		"--key",
		ctx.server.key,
		"--agent",
		"opencode",
		"--no-auth-check",
		...(options.force ? ["--opencode-force"] : []),
		...(options.no ? ["--no-opencode"] : []),
	];
}

/**
 * Runs the real `setup-hooks.sh --agent opencode` against the place's scratch HOME and config folder. The
 * environment is built from nothing; nothing here can name the person's home.
 */
export async function runSetup(
	ctx: ProductCtx,
	place: Place,
	options: { force?: boolean; no?: boolean; script?: string; url?: string } = {},
): Promise<SetupRun> {
	const script = options.script ?? setupScriptFor(ctx);
	const p = place.sandbox.paths;
	const proc = Bun.spawn(installerArgv(ctx, script, options), {
		cwd: ctx.world.root,
		env: {
			HOME: p.HOME,
			XDG_CONFIG_HOME: p.XDG_CONFIG_HOME,
			XDG_DATA_HOME: p.XDG_DATA_HOME,
			XDG_STATE_HOME: p.XDG_STATE_HOME,
			XDG_CACHE_HOME: p.XDG_CACHE_HOME,
			TMPDIR: p.TMPDIR,
			PATH: "/usr/bin:/bin",
			PYTHONDONTWRITEBYTECODE: "1",
			AGENTPULSE_TTY: join(place.sandbox.stateDir, "no-tty"),
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 60_000,
		killSignal: "SIGKILL",
	});
	const [out, err] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	await proc.exited;
	return { code: proc.exitCode ?? -1, out: out + err, script };
}

export type ReadyPlace = Place & { setup: SetupRun };

/** A place with the plugins installed by the real installer (1.x places are warm: `world.v1Warm`). */
export async function ready(
	ctx: ProductCtx,
	line: Line,
	label: string,
	options: {
		cold?: boolean;
		force?: boolean;
		warm?: boolean;
		permission?: Record<string, string>;
	} = {},
): Promise<ReadyPlace> {
	const place = makePlace(ctx.world, line, label, {
		probe: false,
		...(options.permission ? { permission: options.permission } : {}),
		...(options.cold ? { warmFrom: "" } : {}),
		...(options.warm && ctx.world.v1Warm ? { warmFrom: ctx.world.v1Warm } : {}),
	});
	const setup = await runSetup(ctx, place, options.force ? { force: true } : {});
	// The installer's own reachability probe and test event went to the server; they are not the plugin's.
	await ctx.server.reset();
	if (ctx.mutation && ctx.mutation !== "no-sdk-check") patchInstalled(place, line, ctx.mutation);
	return Object.assign(place, { setup });
}

/** Rewrites the base URL in the installed plugin files (for an endpoint the installer's own probe couldn't use). */
export function repointInstalled(place: Place, from: string, to: string): void {
	for (const file of ["agentpulse-opencode-1.js", join("agentpulse-opencode-2", "index.js")]) {
		const path = join(place.pluginsDir, file);
		if (!existsSync(path)) continue;
		const text = readFileSync(path, "utf8");
		const needle = `baseUrl: ${JSON.stringify(from)}`;
		if (!text.includes(needle)) throw new Error(`${file} does not name ${from}`);
		writeFileSync(path, text.replace(needle, `baseUrl: ${JSON.stringify(to)}`));
	}
}

/** Applies a break to the installed plugin file of `line` in place. */
export function patchInstalled(place: Place, line: Line, mutation: string): void {
	const file =
		line === "v1" ? "agentpulse-opencode-1.js" : join("agentpulse-opencode-2", "index.js");
	const path = join(place.pluginsDir, file);
	if (!existsSync(path)) return;
	writeFileSync(path, applyMutation(mutation, line, readFileSync(path, "utf8")));
}

const OVERHEAD_LIMIT_MS = 25;
export const percentile = (xs: number[], q: number) => {
	const sorted = [...xs].sort((a, b) => a - b);
	return sorted[
		Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
	] as number;
};

/**
 * The plugin's cost to a tool call: OpenCode's own recorded start-to-end of the same stub shell call, plugin vs
 * no plugin, paired and interleaved (A B A B ...). Passes when the p95 of the paired differences is at most 25 ms.
 * When the no-plugin runs' own spread (p95 - p5) is over 25 ms the instrument can't resolve it: instrumentInvalid.
 */
export async function overheadScenario(
	ctx: ProductCtx,
	line: Line,
	pairs: number,
): Promise<ProductResult> {
	await ctx.server.reset();
	const withPlugin = await ready(ctx, line, "ovh-with");
	const without = makePlace(ctx.world, line, "ovh-without", { probe: false });
	const diffs: number[] = [];
	const base: number[] = [];
	const ex: Expectation[] = [];
	for (let i = 0; i < pairs; i++) {
		const a = await turn(ctx, withPlugin, `ovh-a-${i}`, "SHELLOK run it", { json: true });
		const b = await turn(ctx, without, `ovh-b-${i}`, "SHELLOK run it", { json: true });
		const da = toolDurationsMs(a.r.stdout);
		const db = toolDurationsMs(b.r.stdout);
		if (da.length === 1 && db.length === 1) {
			diffs.push((da[0] as number) - (db[0] as number));
			base.push(db[0] as number);
		}
	}
	expect(
		ex,
		"every pair gave one tool duration on both arms",
		"instrument",
		diffs.length === pairs,
		{ pairs, got: diffs.length },
	);
	const spread = base.length
		? percentile(base, 0.95) - percentile(base, 0.05)
		: Number.POSITIVE_INFINITY;
	expect(
		ex,
		`the no-plugin runs' own spread is at most ${OVERHEAD_LIMIT_MS} ms`,
		"instrument",
		spread <= OVERHEAD_LIMIT_MS,
		{ spreadMs: spread },
	);
	const p95 = diffs.length ? percentile(diffs, 0.95) : Number.NaN;
	expect(
		ex,
		`the p95 of the paired differences is at most ${OVERHEAD_LIMIT_MS} ms`,
		"claim",
		p95 <= OVERHEAD_LIMIT_MS,
		{ p95Ms: p95, median: diffs.length ? percentile(diffs, 0.5) : null },
	);
	return result("overhead", line, ctx, ex, { diffs, base });
}

export const median = (xs: number[]): number => percentile(xs, 0.5);

/** A stored row's payload as an object (the column holds JSON text on SQLite). */
export const rawOf = (e: Record<string, any>): Record<string, any> => {
	const v = e.rawPayload;
	if (typeof v === "string") {
		try {
			return JSON.parse(v);
		} catch {
			return {};
		}
	}
	return v ?? {};
};

/** The stored rows in id order, trimmed to what the scenarios read and the record shows. */
export async function storedRows(server: ProductServer) {
	const { sessions, events } = await server.rows();
	const ordered = [...events].sort((a, b) => a.id - b.id);
	return {
		sessions,
		events: ordered.map((e) => ({
			id: e.id as number,
			sessionId: e.sessionId as string,
			type: e.eventType as string,
			tool: (e.toolName ?? null) as string | null,
			raw: rawOf(e),
			content: (e.content ?? null) as string | null,
		})),
	};
}
