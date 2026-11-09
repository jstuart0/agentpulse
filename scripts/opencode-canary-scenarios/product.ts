/**
 * The product scenarios of the OpenCode live canary (AGEN-141, plan step 20): the real plugins, loaded the way an
 * installer lays them out, inside a real OpenCode 1.x and 2.x, posting to an in-process server that records every
 * raw POST (with a random 0-50 ms delay so arrival order isn't luck) and forwards each to the real ingest routes.
 * Everything runs through `lib/opencode-canary-spawn.ts`; the model is the stub.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBashExcludeScript } from "../../src/shared/hook-command.ts";
import { buildOpenCodePluginFiles } from "../../src/shared/opencode-plugin.ts";
import { parseOpenCodeEnvelope } from "../../src/shared/opencode-wire.ts";
import type { Expectation } from "../lib/canary-verdict.ts";
import { type Line, applyMutation } from "../lib/opencode-canary-mutations.ts";
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
	delayMs: { fixed: number | null };
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
	const { events, sessions } = await import("../../src/server/db/schema/index.js");
	const { ingest, getInFlightCount } = await import("../../src/server/routes/ingest.js");
	await initializeDatabase();
	config.disableAuth = true;
	const app = new Hono().route("/api/v1", ingest);
	const posts: ProductPost[] = [];
	const delayMs = { fixed: null as number | null };
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
			posts.push({ t: Date.now(), headers, body });
			await new Promise((r) => setTimeout(r, delayMs.fixed ?? Math.random() * 50));
			await app.request("/api/v1/hooks", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-agent-type": "opencode",
					...(headers["x-agentpulse-delivery-id"]
						? { "x-agentpulse-delivery-id": headers["x-agentpulse-delivery-id"] }
						: {}),
				},
				body: raw,
			});
			for (let i = 0; i < 200 && getInFlightCount() > 0; i++)
				await new Promise((r) => setTimeout(r, 5));
			return Response.json({ ok: true });
		},
	});
	return {
		origin: `http://127.0.0.1:${server.port}`,
		posts,
		delayMs,
		async rows() {
			return {
				sessions: await getDb().select().from(sessions),
				events: await getDb().select().from(events),
			};
		},
		async reset() {
			posts.length = 0;
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

const NOISE = /\b(ERROR|WARN)\b|agentpulse|plugin/i;

function expect(
	list: Expectation[],
	name: string,
	kind: Expectation["kind"],
	ok: boolean,
	detail?: unknown,
) {
	list.push({ name, kind, ok, ...(detail === undefined ? {} : { detail }) });
}

/** Lays the plugins out the way the installer does (G9b: 1.x flat, 2.x a directory with index.js) and applies a break. */
export function installProductPlugins(
	place: Place,
	origin: string,
	options: { mutation?: string | null; lines?: Line[] } = {},
): void {
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

function writeRules(place: Place, rules: string[]): void {
	const home = place.sandbox.paths.HOME;
	const dir = join(home, ".agentpulse");
	mkdirSync(dir, { recursive: true });
	chmodSync(dir, 0o700);
	writeFileSync(join(dir, "exclude"), `${rules.join("\n")}\n`, { mode: 0o600 });
	chmodSync(join(dir, "exclude"), 0o600);
	writeFileSync(join(dir, "exclude-check.sh"), buildBashExcludeScript(), { mode: 0o500 });
}

/** One body per delivery id: the exit flush may send an in-flight item a second time, and the server keeps one. */
const bodiesOf = (s: ProductServer) => {
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
	extra: { extraEnv?: Record<string, string>; json?: boolean } = {},
) {
	const cwd = projectDir(ctx.world, name);
	ctx.noteDataHome(place.sandbox.paths.XDG_DATA_HOME);
	const r = await runTurn(ctx.world, place, {
		cwd,
		timeoutMs: 90_000,
		...(extra.json ? { args: ["run", "--format", "json", prompt] } : { prompt }),
		...(extra.extraEnv ? { extraEnv: extra.extraEnv } : {}),
	});
	// The plugin's chain may still be sending when OpenCode exits; give it the 2 s a POST may take.
	await new Promise((res) => setTimeout(res, 600));
	return { r, cwd };
}

export type ProductScenario = (ctx: ProductCtx, line: Line) => Promise<ProductResult>;

const result = (
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
	...(detail === undefined ? {} : { detail }),
});

const ready = (ctx: ProductCtx, line: Line, label: string) => {
	const place = makePlace(ctx.world, line, label, { probe: false });
	installProductPlugins(place, ctx.server.origin, { mutation: ctx.mutation });
	return place;
};

export const PRODUCT_SCENARIOS: Record<string, ProductScenario> = {
	plain: async (ctx, line) => {
		await ctx.server.reset();
		const place = ready(ctx, line, "plain");
		const { r } = await turn(ctx, place, "plain", "PLAIN hello");
		const ex: Expectation[] = [];
		expect(ex, "opencode exited 0 without timing out", "instrument", r.code === 0 && !r.timedOut, {
			code: r.code,
		});
		const bodies = bodiesOf(ctx.server);
		expect(ex, "the plugin posted", "precondition", bodies.length >= 2, { n: bodies.length });
		expect(
			ex,
			"every body passes the wire parser",
			"claim",
			bodies.every((b) => parseOpenCodeEnvelope(b) !== null),
		);
		expect(
			ex,
			"the prompt was posted once",
			"claim",
			bodies.filter((b) => /chat.message|inbox/.test(b.hook_event_name)).length === 1,
		);
		const end = bodies.filter((b) => /session.idle|execution.succeeded/.test(b.hook_event_name));
		expect(
			ex,
			"the turn end carries the assistant's text, once",
			"claim",
			end.length === 1 && end[0]?.last_assistant_message === "STUB-PLAIN reply",
			{ end: end.map((e) => e.last_assistant_message) },
		);
		const rows = await ctx.server.rows();
		expect(
			ex,
			"the stored session is an opencode session",
			"claim",
			rows.sessions.length === 1 && rows.sessions[0]?.agentType === "opencode",
		);
		expect(ex, "the terminal shows nothing from the plugin", "claim", !NOISE.test(r.stderr), {
			stderr: r.stderr.slice(0, 200),
		});
		return result("plain", line, ctx, ex);
	},

	tool: async (ctx, line) => {
		await ctx.server.reset();
		const place = ready(ctx, line, "tool");
		const { r } = await turn(ctx, place, "tool", "SHELLOK run it");
		const ex: Expectation[] = [];
		expect(ex, "opencode exited 0 without timing out", "instrument", r.code === 0 && !r.timedOut, {
			code: r.code,
		});
		const bodies = bodiesOf(ctx.server);
		const tools = bodies.filter(
			(b) => /before|after/.test(b.hook_event_name) && b.data?.tool_use_id === "call_stub_ok_1",
		);
		const after = tools.filter((b) => /after/.test(b.hook_event_name));
		expect(
			ex,
			"the tool call succeeds and is reported once",
			"claim",
			tools.length === 2 &&
				after.length === 1 &&
				after[0]?.data.status === "completed" &&
				after[0]?.data.exit_code === 0 &&
				after[0]?.data.output === "ok",
			{ tools: tools.map((t) => t.hook_event_name), after: after[0]?.data },
		);
		const rows = await ctx.server.rows();
		const kinds = rows.events.filter((e) => e.toolName).map((e) => e.eventType);
		expect(
			ex,
			"the stored rows are one PreToolUse and one PostToolUse",
			"claim",
			kinds.filter((k) => k === "PreToolUse").length === 1 &&
				kinds.filter((k) => k === "PostToolUse").length === 1,
			{ kinds },
		);
		return result("tool", line, ctx, ex);
	},

	stall: async (ctx, line) => {
		await ctx.server.reset();
		ctx.server.delayMs.fixed = 300;
		try {
			const place = ready(ctx, line, "stall");
			const { r } = await turn(ctx, place, "stall", "SHELLOK run it", { json: true });
			const ex: Expectation[] = [];
			expect(
				ex,
				"opencode exited 0 without timing out",
				"instrument",
				r.code === 0 && !r.timedOut,
				{ code: r.code },
			);
			const durations = toolDurationsMs(r.stdout);
			expect(
				ex,
				"OpenCode recorded the tool call's duration",
				"precondition",
				durations.length === 1,
				{ durations },
			);
			// The server holds each answer 300 ms. A hook that waited would put at least that into the call's own time.
			expect(
				ex,
				"the tool hook does not wait for the server",
				"claim",
				durations.length === 1 && (durations[0] as number) < 150,
				{ toolMs: durations[0] },
			);
			return result("stall", line, ctx, ex, { toolMs: durations[0] });
		} finally {
			ctx.server.delayMs.fixed = null;
		}
	},

	"multi-project": async (ctx, line) => {
		await ctx.server.reset();
		const place = ready(ctx, line, "multi");
		const a = await turn(ctx, place, "multi-a", "PLAIN hello");
		const b = await turn(ctx, place, "multi-b", "PLAIN hello");
		const ex: Expectation[] = [];
		expect(ex, "both runs exited 0", "instrument", a.r.code === 0 && b.r.code === 0);
		const dirs = new Set(bodiesOf(ctx.server).map((x) => x.cwd));
		expect(
			ex,
			"each project's session posted with its own directory",
			"claim",
			dirs.size === 2 && dirs.has(a.cwd) && dirs.has(b.cwd),
			{ dirs: [...dirs] },
		);
		const rows = await ctx.server.rows();
		expect(ex, "two sessions are stored", "claim", rows.sessions.length === 2);
		// excluded A / included B
		await ctx.server.reset();
		const place2 = ready(ctx, line, "multi-x");
		const ca = projectDir(ctx.world, "multi-excluded");
		writeRules(place2, [ca]);
		await turn(ctx, place2, "multi-excluded", "PLAIN hello");
		const sentForA = ctx.server.posts.length;
		await turn(ctx, place2, "multi-included", "PLAIN hello");
		expect(
			ex,
			"an excluded project sends nothing and the included one does",
			"claim",
			sentForA === 0 && ctx.server.posts.length >= 2,
			{ sentForA, total: ctx.server.posts.length },
		);
		return result("multi-project", line, ctx, ex);
	},

	exclude: async (ctx, line) => {
		await ctx.server.reset();
		const ex: Expectation[] = [];
		const place = ready(ctx, line, "exclude");
		const dir = projectDir(ctx.world, "exclude-dir");
		writeRules(place, [dir]);
		const first = await turn(ctx, place, "exclude-dir", "SHELLOK run it");
		expect(ex, "opencode exited 0", "instrument", first.r.code === 0);
		expect(ex, "an excluded directory sends nothing", "claim", ctx.server.posts.length === 0, {
			n: ctx.server.posts.length,
		});
		const place2 = ready(ctx, line, "skip");
		await turn(ctx, place2, "skip-dir", "SHELLOK run it", { extraEnv: { AGENTPULSE_SKIP: "1" } });
		expect(ex, "AGENTPULSE_SKIP=1 sends nothing", "claim", ctx.server.posts.length === 0, {
			n: ctx.server.posts.length,
		});
		const place3 = ready(ctx, line, "control");
		await turn(ctx, place3, "control-dir", "SHELLOK run it");
		expect(
			ex,
			"the same run with neither is sent (control)",
			"precondition",
			ctx.server.posts.length >= 3,
		);
		return result("exclude", line, ctx, ex);
	},

	"cross-line": async (ctx, line) => {
		await ctx.server.reset();
		const place = makePlace(ctx.world, line, "cross", { probe: false });
		installProductPlugins(place, ctx.server.origin, { mutation: ctx.mutation });
		const { r } = await turn(ctx, place, "cross", "SHELLOK run it");
		const ex: Expectation[] = [];
		expect(ex, "opencode exited 0", "instrument", r.code === 0 && !r.timedOut, { code: r.code });
		expect(ex, "both plugins are installed, the other line's one included", "precondition", true);
		const lines = new Set(bodiesOf(ctx.server).map((b) => b.opencode?.line));
		expect(
			ex,
			"only the running line's plugin posts",
			"claim",
			lines.size === 1 && lines.has(line === "v1" ? 1 : 2),
			{ lines: [...lines] },
		);
		expect(
			ex,
			"the terminal shows no ERROR or WARN from the other line's plugin",
			"claim",
			!/\b(ERROR|WARN)\b/.test(`${r.stdout}\n${r.stderr}`),
			{ out: `${r.stdout}${r.stderr}`.slice(0, 300) },
		);
		return result("cross-line", line, ctx, ex);
	},
};

export const tmpRoot = () => mkdtempSync(join(tmpdir(), "ap-oc-canary-"));

const OVERHEAD_LIMIT_MS = 25;
const percentile = (xs: number[], q: number) => {
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
	const withPlugin = ready(ctx, line, "ovh-with");
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

/** Runs the unmutated scenarios, then each requested break against the scenario it names, on both lines. */
export async function runProductScenarios(options: {
	world: World;
	only?: string[];
	mutate: string[];
	overhead?: number;
	noteDataHome: (dir: string) => void;
	onProgress?: (line: string) => void;
}): Promise<ProductResult[]> {
	const { MUTATION_TARGETS } = await import("../lib/opencode-canary-mutations.ts");
	const server = await startProductServer();
	const out: ProductResult[] = [];
	const lines: Line[] = ["v1", "v2"];
	try {
		const ids = options.only ?? Object.keys(PRODUCT_SCENARIOS);
		if (options.overhead && options.overhead > 0) {
			for (const line of lines) {
				options.onProgress?.(`[product] overhead ${line} (${options.overhead} pairs)`);
				out.push(
					await overheadScenario(
						{ world: options.world, server, mutation: null, noteDataHome: options.noteDataHome },
						line,
						options.overhead,
					),
				);
			}
		}
		const mutations = options.mutate.includes("all")
			? Object.keys(MUTATION_TARGETS)
			: options.mutate;
		for (const id of ids) {
			const scenario = PRODUCT_SCENARIOS[id];
			if (!scenario) throw new Error(`no product scenario ${id}`);
			for (const line of lines) {
				options.onProgress?.(`[product] ${id} ${line}`);
				out.push(
					await scenario(
						{ world: options.world, server, mutation: null, noteDataHome: options.noteDataHome },
						line,
					),
				);
			}
		}
		for (const mutation of mutations) {
			for (const target of MUTATION_TARGETS[mutation] ?? []) {
				const scenario = PRODUCT_SCENARIOS[target.scenario];
				if (!scenario)
					throw new Error(`mutation ${mutation} names unknown scenario ${target.scenario}`);
				for (const line of lines) {
					options.onProgress?.(`[product] ${target.scenario} ${line} (break: ${mutation})`);
					out.push(
						await scenario(
							{ world: options.world, server, mutation, noteDataHome: options.noteDataHome },
							line,
						),
					);
				}
			}
		}
	} finally {
		server.stop();
	}
	return out;
}
