/**
 * The product scenarios of the OpenCode live canary (AGEN-141, plan steps 20 and 31), core set: `plain`, `tool`,
 * `stall`, `exclude`, `cross-line`, plus the runner. The kit (server, installer, helpers) is `product-kit.ts`;
 * the rest of the table is `product-more.ts`. Mutations patch the installed plugin (or the scratch copy of
 * `setup-hooks.sh`) and each names the one expectation that must then fail.
 */
import { chmodSync, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseOpenCodeEnvelope } from "../../src/shared/opencode-wire.ts";
import type { Expectation } from "../lib/canary-verdict.ts";
import { type Line, MUTATION_LINES } from "../lib/opencode-canary-mutations.ts";
import {
	NOISE,
	type ProductCtx,
	type ProductResult,
	type ProductScenario,
	bodiesOf,
	expect,
	median,
	overheadScenario,
	patchInstalled,
	ready,
	repointInstalled,
	result,
	runSetup,
	startProductServer,
	toolDurationsMs,
	turn,
	writeRules,
} from "./product-kit.ts";
import { MORE_SCENARIOS } from "./product-more.ts";
import { makePlace, projectDir } from "./world.ts";
import type { World } from "./world.ts";

export { toolDurationsMs } from "./product-kit.ts";
export type { ProductResult } from "./product-kit.ts";

/**
 * The plugin's exit flush may spend 300 ms on a stalled endpoint (EXIT_BUDGET_MS in the plugin) and starts curl,
 * so a stalled run costs the budget plus the process start. The plan's "+ 300 ms" has no room for the second part
 * (measured 312 to 335 ms over, three times in a row); 100 ms of slack separates that from a hook that waits
 * (await-post adds the POST's 2 s timeout).
 */
const EXIT_BUDGET_MS = 300;
const SPAWN_SLACK_MS = 100;

export const CORE_SCENARIOS: Record<string, ProductScenario> = {
	plain: async (ctx, line) => {
		await ctx.server.reset();
		const place = await ready(ctx, line, "plain");
		const { r, cwd: cwdOfPlain } = await turn(ctx, place, "plain", "PLAIN hello");
		const ex: Expectation[] = [];
		expect(ex, "opencode exited 0 without timing out", "instrument", r.code === 0 && !r.timedOut, {
			code: r.code,
		});
		expect(ex, "the real installer wrote the plugins", "instrument", place.setup.code === 0, {
			setup: place.setup.out.slice(0, 300),
		});
		const bodies = bodiesOf(ctx.server);
		expect(ex, "the plugin posted", "precondition", bodies.length >= 2, { n: bodies.length });
		expect(
			ex,
			"every body passes the wire parser",
			"claim",
			bodies.every((b) => parseOpenCodeEnvelope(b) !== null),
			{
				bad: bodies
					.filter((b) => parseOpenCodeEnvelope(b) === null)
					.slice(0, 2)
					.map((b) => JSON.stringify(b).slice(0, 400)),
			},
		);
		expect(
			ex,
			"the prompt was posted once",
			"claim",
			bodies.filter((b) => /^(chat\.message|session\.inbox\.enqueued)$/.test(b.hook_event_name))
				.length === 1,
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
		expect(
			ex,
			"the session row carries the project directory and the reporting host",
			"claim",
			rows.sessions[0]?.cwd === cwdOfPlain && Boolean(rows.sessions[0]?.reportedHost),
			{ cwd: rows.sessions[0]?.cwd, host: rows.sessions[0]?.reportedHost },
		);
		expect(ex, "the terminal shows nothing from the plugin", "claim", !NOISE.test(r.stderr), {
			stderr: r.stderr.slice(0, 200),
		});
		return result("plain", line, ctx, ex);
	},

	tool: async (ctx, line) => {
		await ctx.server.reset();
		const place = await ready(ctx, line, "tool");
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
		const ex: Expectation[] = [];
		const hang = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { open() {}, data() {}, close() {} },
		});
		try {
			const base = makePlace(ctx.world, line, "stall-base", { probe: false });
			const withPlugin = makePlace(ctx.world, line, "stall-plugin", { probe: false });
			const setup = await runSetup(ctx, withPlugin);
			await ctx.server.reset();
			// The installer's reachability probe needs an answer, so it ran against the real server; the plugin's
			// base URL is then pointed at the endpoint that never answers.
			repointInstalled(withPlugin, ctx.server.origin, `http://127.0.0.1:${hang.port}`);
			if (ctx.mutation) patchInstalled(withPlugin, line, ctx.mutation);
			expect(ex, "the real installer wrote the plugins", "instrument", setup.code === 0, {
				setup: setup.out.slice(0, 300),
			});
			// Interleaved (baseline, stalled, baseline, ...) so a change in the machine's load hits both arms.
			const baselineWall: number[] = [];
			const baselineTool: number[] = [];
			const wall: number[] = [];
			const tool: number[] = [];
			let exits = 0;
			for (let i = 0; i < 3; i++) {
				const b = await turn(ctx, base, `stall-base-${i}`, "SHELLOK run it", { json: true });
				baselineWall.push(b.r.ms);
				baselineTool.push(...toolDurationsMs(b.r.stdout));
				const s = await turn(ctx, withPlugin, `stall-run-${i}`, "SHELLOK run it", { json: true });
				wall.push(s.r.ms);
				tool.push(...toolDurationsMs(s.r.stdout));
				if (s.r.code === 0 && !s.r.timedOut) exits++;
			}
			expect(
				ex,
				"three baseline runs (no plugin) each made one tool call",
				"precondition",
				baselineTool.length === 3,
				{ baselineWall, baselineTool },
			);
			expect(ex, "opencode exited 0 without timing out", "instrument", exits === 3, { exits });
			expect(ex, "every stalled run made one tool call", "precondition", tool.length === 3, {
				tool,
			});
			expect(
				ex,
				"the endpoint never answered (nothing reached the real route)",
				"precondition",
				ctx.server.posts.length === 0,
			);
			// OpenCode's own recorded time for the call, against the same call with no plugin at all.
			const toolMs = median(tool);
			const toolBase = median(baselineTool);
			expect(ex, "the tool hook does not wait for the server", "claim", toolMs <= toolBase + 150, {
				toolMs,
				toolBase,
			});
			const wallMs = median(wall);
			const wallBase = median(baselineWall);
			expect(
				ex,
				"the run's wall time is within the baseline median plus the exit budget and its spawn slack",
				"claim",
				wallMs <= wallBase + EXIT_BUDGET_MS + SPAWN_SLACK_MS,
				{ wall, wallMs, baselineWall, wallBase, limit: EXIT_BUDGET_MS + SPAWN_SLACK_MS },
			);
			return result("stall", line, ctx, ex, { wallMs, wallBase, toolMs, toolBase });
		} finally {
			hang.stop(true);
		}
	},

	exclude: async (ctx, line) => {
		const ex: Expectation[] = [];
		const place = await ready(ctx, line, "exclude");
		const dir = projectDir(ctx.world, "exclude-dir");
		const rulesFile = join(place.sandbox.paths.HOME, ".agentpulse", "exclude");
		await ctx.server.reset();
		writeRules(place, [dir]);
		const st = statSync(rulesFile);
		expect(
			ex,
			"the rules file is present and trusted (mode 0600, ours)",
			"precondition",
			(st.mode & 0o777) === 0o600 && st.uid === process.getuid?.(),
		);
		const first = await turn(ctx, place, "exclude-dir", "SHELLOK run it");
		expect(ex, "opencode exited 0", "instrument", first.r.code === 0 && !first.r.timedOut);
		expect(ex, "an excluded directory sends nothing", "claim", ctx.server.posts.length === 0, {
			n: ctx.server.posts.length,
		});
		// The same rules, but a file the plugin may not trust: it sends nothing anywhere.
		await ctx.server.reset();
		chmodSync(rulesFile, 0o666);
		await turn(ctx, place, "exclude-other", "SHELLOK run it");
		expect(
			ex,
			"invalid rules (a world-writable file) send nothing",
			"claim",
			ctx.server.posts.length === 0,
			{ n: ctx.server.posts.length },
		);
		// Rules removed: rows resume.
		await ctx.server.reset();
		rmSync(rulesFile, { force: true });
		await turn(ctx, place, "exclude-dir", "SHELLOK run it");
		expect(
			ex,
			"with the rules removed the same directory is sent (control)",
			"precondition",
			ctx.server.posts.length >= 3,
			{ n: ctx.server.posts.length },
		);
		expect(
			ex,
			"the sent rows are stored",
			"claim",
			(await ctx.server.rows()).sessions.length === 1,
		);
		return result("exclude", line, ctx, ex);
	},

	"cross-line": async (ctx, line) => {
		await ctx.server.reset();
		const place = await ready(ctx, line, "cross", { warm: true });
		const { r } = await turn(ctx, place, "cross", "SHELLOK run it");
		const ex: Expectation[] = [];
		expect(ex, "opencode exited 0", "instrument", r.code === 0 && !r.timedOut, { code: r.code });
		const present = (f: string) => existsSync(join(place.pluginsDir, f));
		expect(
			ex,
			"both plugin files are installed, the other line's one included",
			"precondition",
			present("agentpulse-opencode-1.js") && present(join("agentpulse-opencode-2", "index.js")),
		);
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
		return result("cross-line", line, ctx, ex, {
			otherFileMessage: `${r.stdout}${r.stderr}`.slice(0, 300) || "(none)",
		});
	},
};

export const PRODUCT_SCENARIOS: Record<string, ProductScenario> = {
	...CORE_SCENARIOS,
	...MORE_SCENARIOS,
};

/** No scenario takes longer; a hung one is an invalid instrument for that line, not the end of the run. */
const SCENARIO_LIMIT_MS = 480_000;

const lineOf = (mutation: string): Line[] => MUTATION_LINES[mutation] ?? ["v1", "v2"];

/** A scenario that throws is an invalid instrument for that line, not the end of the run. */
async function safely(
	scenario: string,
	line: Line,
	ctx: ProductCtx,
	fn: ProductScenario,
): Promise<ProductResult> {
	const t0 = Date.now();
	try {
		const r = await Promise.race([
			fn(ctx, line),
			new Promise<never>((_, reject) => {
				const timer = setTimeout(
					() =>
						reject(new Error(`${scenario} on ${line} did not finish in ${SCENARIO_LIMIT_MS} ms`)),
					SCENARIO_LIMIT_MS,
				);
				timer.unref();
			}),
		]);
		return { ...r, detail: { ...(r.detail as object | undefined), ms: Date.now() - t0 } };
	} catch (error) {
		return {
			scenario,
			line,
			mutation: ctx.mutation,
			expectations: [
				{
					name: "the scenario ran to its end",
					kind: "instrument",
					ok: false,
					detail: String((error as Error)?.stack ?? error).slice(0, 600),
				},
			],
		};
	}
}

/** Runs the unmutated scenarios, then each requested break against the scenario it names, on the lines it applies to. */
export async function runProductScenarios(options: {
	world: World;
	only?: string[];
	mutate: string[];
	mutationsOnly?: boolean;
	overhead?: number;
	noteDataHome: (dir: string) => void;
	onProgress?: (line: string) => void;
}): Promise<ProductResult[]> {
	const { MUTATION_TARGETS } = await import("../lib/opencode-canary-mutations.ts");
	const server = await startProductServer();
	const out: ProductResult[] = [];
	const lines: Line[] = ["v1", "v2"];
	const base = (mutation: string | null): ProductCtx => ({
		world: options.world,
		server,
		mutation,
		noteDataHome: options.noteDataHome,
	});
	try {
		const ids = options.only ?? Object.keys(PRODUCT_SCENARIOS);
		const mutations = options.mutate.includes("all")
			? Object.keys(MUTATION_TARGETS)
			: options.mutate;
		if (options.overhead && options.overhead > 0) {
			for (const line of lines) {
				options.onProgress?.(`[product] overhead ${line} (${options.overhead} pairs)`);
				out.push(await overheadScenario(base(null), line, options.overhead));
			}
		}
		if (!options.mutationsOnly) {
			for (const id of ids) {
				const scenario = PRODUCT_SCENARIOS[id];
				if (!scenario) throw new Error(`no product scenario ${id}`);
				for (const line of lines) {
					options.onProgress?.(`[product] ${id} ${line}`);
					out.push(await safely(id, line, base(null), scenario));
				}
			}
		}
		for (const mutation of mutations) {
			for (const target of MUTATION_TARGETS[mutation] ?? []) {
				if (options.only && !options.only.includes(target.scenario)) continue;
				const scenario = PRODUCT_SCENARIOS[target.scenario];
				if (!scenario)
					throw new Error(`mutation ${mutation} names unknown scenario ${target.scenario}`);
				for (const line of lineOf(mutation)) {
					options.onProgress?.(`[product] ${target.scenario} ${line} (break: ${mutation})`);
					out.push(await safely(target.scenario, line, base(mutation), scenario));
				}
			}
		}
	} finally {
		server.stop();
	}
	return out;
}
