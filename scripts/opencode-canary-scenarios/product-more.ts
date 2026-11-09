/**
 * The rest of the OpenCode canary's scenario table (AGEN-141, plan step 31): failures, a failed turn, a subagent,
 * the skip switch, `--pure`, the exit flush, the relay, and the two installer-and-SDK scenarios of the G9 re-plan.
 * The long-running ones (`serve`, `permission`, `multi-project`) are in `product-serve.ts`.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	OPENCODE_SDK_SKIP_MESSAGE,
	renderOpenCodeMessage,
} from "../../src/shared/opencode-plugin.ts";
import type { Expectation } from "../lib/canary-verdict.ts";
import {
	type ProductCtx,
	type ProductScenario,
	bodiesOf,
	expect,
	installRelayPlugins,
	ready,
	result,
	storedRows,
	turn,
} from "./product-kit.ts";
import { SERVE_SCENARIOS } from "./product-serve.ts";
import { makePlace } from "./world.ts";

export type Row = Awaited<ReturnType<typeof storedRows>>["events"][number];
export const toolUseOf = (e: Row): string | undefined =>
	e.raw.tool_use_id ?? e.raw.data?.tool_use_id;
export const TERMINALS = new Set(["PostToolUse", "PostToolUseFailure"]);
const exited = (r: { code: number | null; timedOut: boolean }) => r.code === 0 && !r.timedOut;
const brief = (rows: Row[]) =>
	rows.map(
		(e) => `${e.type}${e.tool ? `:${e.tool}` : ""}${toolUseOf(e) ? `#${toolUseOf(e)}` : ""}`,
	);

/** The status OpenCode itself printed for a tool call's part (`run --format json`). */
const partStatus = (stdout: string, id: string): string | undefined => {
	for (const text of stdout.split("\n")) {
		if (!text.startsWith("{")) continue;
		try {
			const e = JSON.parse(text) as {
				part?: { callID?: string; state?: { status?: string } };
			};
			if (e.part?.callID === id && e.part.state?.status) return e.part.state.status;
		} catch {}
	}
	return undefined;
};

const OBSERVATIONS = readFileSync(
	join(import.meta.dir, "../../src/server/services/agents/__fixtures__/opencode/OBSERVATIONS.md"),
	"utf8",
);

const FAIL_CALLS = [
	{ prompt: "SHELLFAIL run it", dir: "tool-fail-exit", id: "call_stub_fail_1" },
	{ prompt: "READMISSING read it", dir: "tool-fail-error", id: "call_stub_read_1" },
];

export const MORE_ONLY: Record<string, ProductScenario> = {
	"tool-fail": async (ctx, line) => {
		await ctx.server.reset();
		const place = await ready(ctx, line, "tool-fail");
		const ex: Expectation[] = [];
		const runs = [];
		for (const c of FAIL_CALLS) runs.push(await turn(ctx, place, c.dir, c.prompt, { json: true }));
		expect(
			ex,
			"opencode exited 0 without timing out",
			"instrument",
			runs.every((x) => exited(x.r)),
		);
		const { events } = await storedRows(ctx.server);
		for (const c of FAIL_CALLS) {
			const mine = events.filter((e) => toolUseOf(e) === c.id);
			expect(
				ex,
				`the model saw ${c.id} start (one PreToolUse row)`,
				"precondition",
				mine.filter((e) => e.type === "PreToolUse").length === 1,
				{ rows: brief(mine) },
			);
		}
		if (ctx.mutation === "no-terminal-hold") {
			// The hold only matters for a call whose after hook fired and whose part then ended in error. Whether any
			// 1.x call does is what G3 recorded; the posts can't tell (the plugin sends its own after message for a part error).
			expect(
				ex,
				"G3 recorded both signals for one call (the after hook fired and the part ended in error)",
				"precondition",
				OBSERVATIONS.includes("`v1.after_fires_on_error=yes`"),
			);
		}
		const bad = FAIL_CALLS.filter((c) => {
			const t = events.filter((e) => toolUseOf(e) === c.id && TERMINALS.has(e.type));
			if (!(t.length === 1 && t[0]?.type === "PostToolUseFailure")) return true;
			// What the plugin posted: one terminal message, and it says what the part recorded.
			const sent = bodiesOf(ctx.server).filter(
				(b) => /\.after$/.test(String(b.hook_event_name)) && b.data?.tool_use_id === c.id,
			);
			const partErrored = runs.some((x) => partStatus(x.r.stdout, c.id) === "error");
			return !(sent.length === 1 && (!partErrored || sent[0]?.data.status === "error"));
		}).map((c) => ({ id: c.id, rows: brief(events.filter((e) => toolUseOf(e) === c.id)) }));
		expect(ex, "exactly one terminal row per failed call", "claim", bad.length === 0, { bad });
		expect(
			ex,
			"no PostToolUse is stored for a failed call",
			"claim",
			!events.some(
				(e) => e.type === "PostToolUse" && FAIL_CALLS.some((c) => c.id === toolUseOf(e)),
			),
		);
		return result("tool-fail", line, ctx, ex, { rows: brief(events) });
	},

	"turn-fail": async (ctx, line) => {
		await ctx.server.reset();
		const place = await ready(ctx, line, "turn-fail");
		const ex: Expectation[] = [];
		const { r } = await turn(ctx, place, "turn-fail", "FAILTURN go");
		expect(ex, "opencode ran to its end", "instrument", !r.timedOut);
		const text = `${r.stdout}\n${r.stderr}`;
		expect(
			ex,
			"the provider's failure message was in OpenCode's own output (there was something to leak)",
			"precondition",
			/forced failure/.test(text) ||
				ctx.world.stub.requests().some((q) => q.body.includes("FAILTURN")),
			{ out: text.slice(0, 200) },
		);
		const { events } = await storedRows(ctx.server);
		const err = events.find((e) => e.type === "ErrorOccurred");
		const stop = events.find((e) => e.type === "Stop");
		expect(
			ex,
			"an ErrorOccurred row is followed by a Stop row",
			"claim",
			Boolean(err && stop && err.id < stop.id),
			{ rows: brief(events) },
		);
		const flat = JSON.stringify(err?.raw ?? {}) + (err?.content ?? "");
		expect(
			ex,
			"the error row carries no responseHeaders, keep-alive or message",
			"claim",
			err !== undefined && !/responseHeaders|keep-alive|forced failure|"message"/i.test(flat),
			{ raw: flat.slice(0, 300) },
		);
		const msg = err?.raw.error_message ?? err?.content ?? "";
		expect(
			ex,
			"error_message is the error's name (and HTTP status) only",
			"claim",
			/^[A-Za-z0-9_.-]+( \(HTTP \d{3}\))?$/.test(String(msg)),
			{ msg },
		);
		return result("turn-fail", line, ctx, ex, { rows: brief(events) });
	},

	subagent: async (ctx, line) => {
		await ctx.server.reset();
		const place = await ready(ctx, line, "subagent");
		const ex: Expectation[] = [];
		const { r } = await turn(ctx, place, "subagent", "SUBTASK go");
		expect(ex, "opencode exited 0", "instrument", exited(r));
		const rows = await storedRows(ctx.server);
		const { events } = rows;
		const start = events.find((e) => e.type === "SubagentStart");
		const stop = events.find((e) => e.type === "SubagentStop");
		const child = start?.raw.agent_id as string | undefined;
		expect(
			ex,
			"the model ran the subagent task (a SubagentStart row exists)",
			"precondition",
			Boolean(start && child),
			{ rows: brief(events) },
		);
		expect(
			ex,
			"the parent has SubagentStart and SubagentStop for the same child",
			"claim",
			Boolean(child && stop?.raw.agent_id === child && child !== start?.sessionId),
		);
		const childTools = events.filter((e) => e.raw.agent_id === child && e.tool);
		expect(
			ex,
			"the child's tool calls are rows of the parent session",
			"claim",
			childTools.length >= 2 &&
				childTools.every((e) => e.sessionId === start?.sessionId) &&
				childTools.every((e) => String(toolUseOf(e)).startsWith(`${child}:`)),
			{ rows: brief(childTools) },
		);
		expect(
			ex,
			"no session row exists for the child",
			"claim",
			rows.sessions.length === 1 && !rows.sessions.some((s) => s.sessionId === child),
			{ sessions: rows.sessions.map((s) => s.sessionId) },
		);
		return result("subagent", line, ctx, ex, { rows: brief(events) });
	},

	skip: async (ctx, line) => {
		await ctx.server.reset();
		const place = await ready(ctx, line, "skip");
		const ex: Expectation[] = [];
		const control = await turn(ctx, place, "skip-control", "SHELLOK run it");
		const withControl = ctx.server.posts.length;
		expect(
			ex,
			"the same run without the switch is sent (control)",
			"precondition",
			exited(control.r) && withControl >= 3,
			{ n: withControl },
		);
		await ctx.server.reset();
		const skipped = await turn(ctx, place, "skip-on", "SHELLOK run it", {
			extraEnv: { AGENTPULSE_SKIP: "1" },
		});
		expect(ex, "opencode exited 0", "instrument", exited(skipped.r));
		expect(ex, "AGENTPULSE_SKIP=1 sends nothing", "claim", ctx.server.posts.length === 0, {
			n: ctx.server.posts.length,
		});
		return result("skip", line, ctx, ex);
	},

	pure: async (ctx, line) => {
		if (line === "v2") {
			return { ...result("pure", line, ctx, []), notRun: "--pure is a 1.x switch" };
		}
		await ctx.server.reset();
		const place = await ready(ctx, line, "pure");
		const ex: Expectation[] = [];
		const control = await turn(ctx, place, "pure-control", "SHELLOK run it");
		expect(
			ex,
			"the same run without --pure is sent (control)",
			"precondition",
			exited(control.r) && ctx.server.posts.length >= 3,
		);
		await ctx.server.reset();
		const pure = await turn(ctx, place, "pure-on", "", {
			args: ["run", "--pure", "SHELLOK run it"],
		});
		expect(ex, "opencode exited 0", "instrument", exited(pure.r), {
			out: `${pure.r.stdout}${pure.r.stderr}`.slice(0, 200),
		});
		expect(ex, "--pure loads no plugin: nothing is sent", "claim", ctx.server.posts.length === 0, {
			n: ctx.server.posts.length,
		});
		return result("pure", line, ctx, ex);
	},

	"final-stop": async (ctx, line) => {
		await ctx.server.reset();
		const place = await ready(ctx, line, "final-stop");
		const ex: Expectation[] = [];
		const { r } = await turn(ctx, place, "final-stop", "SHELLOK run it", { settleMs: 0 });
		expect(ex, "opencode exited 0", "instrument", exited(r));
		const { events } = await storedRows(ctx.server);
		const stop = events.filter((e) => e.type === "Stop");
		expect(
			ex,
			"a Stop row is stored by the time the run has exited (the exit flush)",
			"claim",
			stop.length === 1 && stop[0]?.raw.last_assistant_message !== undefined,
			{ rows: brief(events) },
		);
		return result("final-stop", line, ctx, ex);
	},

	relay: async (ctx, line) => {
		await ctx.server.reset();
		const { mkdirSync, mkdtempSync, realpathSync } = await import("node:fs");
		const root = realpathSync(mkdtempSync(join(ctx.world.root, "relay-")));
		const home = join(root, "home");
		const state = join(root, "state");
		for (const d of [home, state, join(home, ".agentpulse")]) mkdirSync(d, { recursive: true });
		const R = await import("../relay.ts?module");
		const relay = await R.startRelay(
			{
				remoteUrl: ctx.server.origin,
				apiKey: ctx.server.key,
				port: 0,
				codexNamePolicy: "codex",
				stateDir: state,
				configPath: null,
			},
			{
				timers: false,
				env: { HOME: home },
				scriptPath: join(import.meta.dir, "..", "relay.ts"),
				log: () => {},
				accountHome: () => undefined,
			} as never,
		);
		try {
			const place = makePlace(ctx.world, line, "relay", { probe: false });
			installRelayPlugins(place, `http://127.0.0.1:${relay.port}`, { mutation: ctx.mutation });
			const ex: Expectation[] = [];
			const { r } = await turn(ctx, place, "relay", "SHELLOK run it");
			for (let i = 0; i < 6; i++) await R.processHookQueue(relay.ctx);
			expect(ex, "opencode exited 0", "instrument", exited(r));
			const { sessions, events } = await storedRows(ctx.server);
			expect(
				ex,
				"the rows arrive through the relay",
				"claim",
				events.some((e) => e.type === "Stop") && sessions[0]?.agentType === "opencode",
				{ rows: brief(events) },
			);
			expect(
				ex,
				"the host is stamped by the relay on every forwarded request",
				"claim",
				ctx.server.posts.length > 0 &&
					ctx.server.posts.every((p) => Boolean(p.headers["x-agentpulse-host"])) &&
					Boolean(sessions[0]?.reportedHost),
				{ host: sessions[0]?.reportedHost },
			);
			return result("relay", line, ctx, ex);
		} finally {
			await relay.stop();
		}
	},

	"v1-cold-skip": async (ctx, line) => {
		const ex: Expectation[] = [];
		await ctx.server.reset();
		const cold = await ready(ctx, line, "cold", { cold: true });
		const marker = join(cold.configDir, "node_modules", "@opencode-ai", "plugin", "package.json");
		expect(
			ex,
			"the config folder is cold before setup (no plugin SDK)",
			"precondition",
			!existsSync(marker),
		);
		const wanted = renderOpenCodeMessage(OPENCODE_SDK_SKIP_MESSAGE, {
			dir: cold.configDir,
			site: "setup-hooks",
		});
		expect(
			ex,
			"the installer printed the skip message",
			"claim",
			cold.setup.out.includes(wanted) && wanted.includes("setup-hooks.sh --opencode-force"),
			{ setup: cold.setup.out.slice(0, 600) },
		);
		expect(ex, "setup exited 0", "instrument", cold.setup.code === 0);
		const hasV1 = existsSync(join(cold.configDir, "plugins", "agentpulse-opencode-1.js"));
		const profile = join(cold.sandbox.stateDir, "loopback-only.sb");
		const control = makePlace(ctx.world, line, "cold-control", { probe: false, warmFrom: "" });
		const base = await turn(ctx, control, "cold-control", "PLAIN hello");
		expect(
			ex,
			"the control run (cold, no plugins) finished under 15 s",
			"precondition",
			exited(base.r) && base.r.ms < 15_000,
			{ ms: base.r.ms },
		);
		const run = await turn(ctx, cold, "cold-run", "PLAIN hello");
		expect(
			ex,
			"the network is refused by the loopback-only profile",
			"precondition",
			existsSync(profile) && /deny network/.test(readFileSync(profile, "utf8")),
		);
		expect(ex, "opencode exited 0", "instrument", exited(run.r), { ms: run.r.ms });
		if (line === "v1") {
			expect(
				ex,
				"the 1.x run finishes in 15 s and within 3 s of the control",
				"claim",
				run.r.ms <= 15_000 && run.r.ms <= base.r.ms + 3_000,
				{ ms: run.r.ms, controlMs: base.r.ms, v1EntryWritten: hasV1 },
			);
			expect(
				ex,
				"the run did not fetch the plugin SDK",
				"claim",
				!existsSync(join(cold.configDir, "node_modules")),
			);
		} else {
			const rows = await storedRows(ctx.server);
			expect(
				ex,
				"a 2.x run from the same config reports its rows",
				"claim",
				rows.events.some((e) => e.type === "Stop"),
				{ rows: brief(rows.events) },
			);
		}
		return result("v1-cold-skip", line, ctx, ex, { v1EntryWritten: hasV1, ms: run.r.ms });
	},

	"v1-warm-install": async (ctx, line) => {
		const ex: Expectation[] = [];
		await ctx.server.reset();
		const place = await ready(ctx, line, "warm", { warm: true });
		const marker = join(place.configDir, "node_modules", "@opencode-ai", "plugin", "package.json");
		expect(
			ex,
			"the config folder is warm before setup (plugin SDK present)",
			"precondition",
			existsSync(marker),
		);
		expect(ex, "setup exited 0", "instrument", place.setup.code === 0);
		expect(
			ex,
			"the real installer wrote the 1.x entry",
			"claim",
			existsSync(join(place.pluginsDir, "agentpulse-opencode-1.js")) &&
				statSync(join(place.pluginsDir, "agentpulse-opencode-1.js")).size > 1000,
		);
		expect(
			ex,
			"setup printed no skip message",
			"claim",
			!/OpenCode (1\.x )?plugin: not installed/.test(place.setup.out),
			{ setup: place.setup.out.slice(0, 400) },
		);
		const { r } = await turn(ctx, place, "warm", "SHELLOK run it");
		expect(ex, "opencode exited 0", "instrument", exited(r));
		const { events } = await storedRows(ctx.server);
		const lines = new Set(bodiesOf(ctx.server).map((b) => b.opencode?.line));
		expect(
			ex,
			"the plain rows arrive from the running line",
			"claim",
			events.some((e) => e.type === "Stop") && lines.has(line === "v1" ? 1 : 2),
			{ rows: brief(events), lines: [...lines] },
		);
		return result("v1-warm-install", line, ctx, ex);
	},
};

export const MORE_SCENARIOS: Record<string, ProductScenario> = {
	...MORE_ONLY,
	...SERVE_SCENARIOS,
};
export type { ProductCtx };
