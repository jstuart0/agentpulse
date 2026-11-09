/**
 * The long-running scenarios of the OpenCode canary (AGEN-141, plan step 31): `serve` (a headless server driven
 * over HTTP), `permission` (an ask answered, and an ask refused) and `multi-project` (one process, several
 * projects: the 2.x background service, or a 1.x `serve` with two directories; direct and through the relay).
 * Everything starts through `lib/opencode-canary-spawn.ts`. A service is started only under the place's scratch
 * environment and stopped with `service stop`; a leftover is found by this run's XDG_DATA_HOME, never by name.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getOperationalStatus,
	hasOutstandingPermissionWait,
} from "../../src/shared/session-state.ts";
import type { Expectation } from "../lib/canary-verdict.ts";
import { QUEUE_LOG, SEEN_LOG } from "../lib/opencode-canary-mutations.ts";
import type { OpenCodeLine } from "../lib/opencode-canary-pins.ts";
import {
	type Server,
	createSession,
	pendingPermissions,
	prompt,
	replyPermission,
} from "./measure-live.ts";
import {
	type ProductCtx,
	type ProductScenario,
	type ReadyPlace,
	expect,
	installRelayPlugins,
	patchInstalled,
	ready,
	result,
	runSetup,
	storedRows,
	turn,
	writeRules,
} from "./product-kit.ts";
import { type Place, makePlace, projectDir, runTurn, startLong, waitFor } from "./world.ts";

type Rows = Awaited<ReturnType<typeof storedRows>>;
type StoredEvent = Rows["events"][number];

let portCursor = 26_500 + Math.floor(Math.random() * 2000);
const nextPort = () => ++portCursor;
const SERVE_ASK = { edit: "ask", write: "ask", bash: "allow", read: "allow", task: "allow" };
/** Relay rounds that did not return; the scenario names them in its record. */
export const pumpStalls: string[] = [];
const trace = (msg: string) => {
	if (process.env.AP_CANARY_TRACE) console.error(`[trace] ${msg}`);
};
const brief = (rows: StoredEvent[]) => rows.map((e) => `${e.type}${e.tool ? `:${e.tool}` : ""}`);
const toolUseOf = (e: StoredEvent): string | undefined =>
	e.raw.tool_use_id ?? e.raw.data?.tool_use_id;

/** `serve` in the place's own sandbox, once the plugins are in place. */
async function serveUp(ctx: ProductCtx, place: Place, name: string): Promise<Server> {
	const cwd = projectDir(ctx.world, `${place.line}-${name}`);
	ctx.noteDataHome(place.sandbox.paths.XDG_DATA_HOME);
	const port = nextPort();
	const child = await startLong(
		ctx.world,
		place,
		["serve", "--port", String(port), "--hostname", "127.0.0.1"],
		cwd,
		`serve-${name}`,
		{ extraEnv: { OPENCODE_SERVER_PASSWORD: "pw" }, timeoutMs: 280_000 },
	);
	const base = `http://127.0.0.1:${port}`;
	const headers = {
		authorization: `Basic ${btoa("opencode:pw")}`,
		"content-type": "application/json",
	};
	const up = await waitFor(
		async () => {
			try {
				return (
					(await fetch(`${base}/global/health`, { headers, signal: AbortSignal.timeout(3000) }))
						.status > 0
				);
			} catch {
				return false;
			}
		},
		30_000,
		300,
	);
	if (!up) {
		child.kill();
		throw new Error(`${place.line} serve did not come up`);
	}
	return { line: place.line, place, child, base, headers, cwd };
}

async function serveDown(s: Server): Promise<void> {
	s.child.kill();
	await s.child.exited;
}

const stopCount = (r: Rows, sid?: string) =>
	r.events.filter((e) => e.type === "Stop" && (sid === undefined || e.sessionId === sid)).length;

async function waitForStop(ctx: ProductCtx, want: number, ms = 40_000): Promise<Rows> {
	await waitFor(async () => stopCount(await storedRows(ctx.server)) >= want, ms, 250);
	await Bun.sleep(500);
	return storedRows(ctx.server);
}

const permissionWaiting = (s: Record<string, any>) => hasOutstandingPermissionWait(s as never);
const operational = (s: Record<string, any>) => getOperationalStatus(s as never);

export const SERVE_SCENARIOS: Record<string, ProductScenario> = {
	serve: async (ctx, line) => {
		await ctx.server.reset();
		const place = await ready(ctx, line, "serve");
		const ex: Expectation[] = [];
		const s = await serveUp(ctx, place, "serve");
		try {
			ctx.world.rule.projectDir = s.cwd;
			const id = await createSession(s, s.cwd);
			await prompt(s, id, s.cwd, "SHELLOK run it");
			const rows = await waitForStop(ctx, 1);
			const types = brief(rows.events);
			expect(ex, "the served run produced a turn end", "precondition", stopCount(rows) === 1, {
				types,
			});
			const order = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
			let at = -1;
			const inOrder = order.every((t) => {
				const i = rows.events.findIndex((e, k) => k > at && e.type === t);
				at = i;
				return i >= 0;
			});
			expect(ex, "the same rows as a one-shot run: prompt, tool pair, Stop", "claim", inOrder, {
				types,
			});
			const session = rows.sessions[0];
			expect(
				ex,
				"the stored session is an opencode session and is not working",
				"claim",
				rows.sessions.length === 1 &&
					session?.agentType === "opencode" &&
					session?.isWorking === false,
				{ agentType: session?.agentType, isWorking: session?.isWorking },
			);
			return result("serve", line, ctx, ex, { types });
		} finally {
			await serveDown(s);
		}
	},

	permission: async (ctx, line) => {
		const ex: Expectation[] = [];
		// Refused: a headless `run` cannot answer an ask, so OpenCode refuses it.
		await ctx.server.reset();
		const refuse = await ready(ctx, line, "perm-reject", { permission: SERVE_ASK });
		const run = await turn(ctx, refuse, "perm-reject", "PERMASK go", { timeoutMs: 60_000 });
		expect(ex, "opencode ran to its end", "instrument", !run.r.timedOut);
		let rows = await storedRows(ctx.server);
		const ask = rows.events.find((e) => e.type === "PermissionRequest");
		const denied = rows.events.find((e) => e.type === "PermissionDenied");
		expect(ex, "an ask and a reply were both captured", "precondition", Boolean(ask && denied), {
			types: brief(rows.events),
		});
		const waitingAfterRefuse = rows.sessions.some((x) => permissionWaiting(x));
		// The Post that follows a refused tool also clears the wait, so the link itself is what shows the reply works:
		// the reply carries the ask's own tool-use id.
		const linked = Boolean(ask && denied && toolUseOf(ask) === toolUseOf(denied));
		expect(ex, "a rejected ask is cleared by the reply", "claim", linked && !waitingAfterRefuse, {
			ask: ask && toolUseOf(ask),
			denied: denied && toolUseOf(denied),
			metadata: rows.sessions[0]?.metadata,
		});

		// Accepted: served, answered through the API.
		await ctx.server.reset();
		const place = await ready(ctx, line, "perm-accept", { permission: SERVE_ASK });
		const s = await serveUp(ctx, place, "perm-accept");
		try {
			ctx.world.rule.projectDir = s.cwd;
			const id = await createSession(s, s.cwd);
			await prompt(s, id, s.cwd, "PERMASK please");
			let pending: any[] = [];
			await waitFor(
				async () => {
					pending = await pendingPermissions(s, id, s.cwd);
					return pending.length > 0;
				},
				30_000,
				300,
			);
			expect(ex, "OpenCode holds a pending ask", "instrument", pending.length > 0);
			await waitFor(
				async () =>
					(await storedRows(ctx.server)).events.some((e) => e.type === "PermissionRequest"),
				10_000,
				250,
			);
			rows = await storedRows(ctx.server);
			expect(
				ex,
				"a pending ask makes the session WAITING",
				"claim",
				rows.sessions.length === 1 &&
					permissionWaiting(rows.sessions[0] as never) &&
					operational(rows.sessions[0] as never) === "waiting",
				{ metadata: rows.sessions[0]?.metadata },
			);
			if (pending[0]) await replyPermission(s, id, s.cwd, pending[0].id);
			rows = await waitForStop(ctx, 1);
			const post = rows.events.find(
				(e) => e.type === "PostToolUse" && toolUseOf(e) === "call_stub_perm_1",
			);
			expect(
				ex,
				"an accepted ask is cleared when the tool completes",
				"claim",
				Boolean(post) && !rows.sessions.some((x) => permissionWaiting(x)),
				{ types: brief(rows.events), metadata: rows.sessions[0]?.metadata },
			);
		} finally {
			await serveDown(s);
		}
		return result("permission", line, ctx, ex);
	},

	"multi-project": async (ctx, line) => {
		const ex: Expectation[] = [];
		pumpStalls.length = 0;
		for (const mode of ["direct", "relay"] as const) await multiProject(ctx, line, mode, ex);
		return result("multi-project", line, ctx, ex, { pumpStalls: [...pumpStalls] });
	},
};

// ---------------------------------------------------------------------------------------------------------
// multi-project

const STAGES: Record<string, number> = {
	"session.created": 0,
	"chat.message": 1,
	"session.inbox.enqueued": 1,
	"tool.execute.before": 2,
	"tool.before": 2,
	"tool.execute.after": 3,
	"tool.after": 3,
	"session.idle": 4,
	"session.execution.succeeded": 4,
};

function orderViolations(posts: ProductCtx["server"]["posts"]): string[] {
	const bySession = new Map<string, number[]>();
	for (const p of posts) {
		const sid = p.body.session_id as string | undefined;
		const stage = STAGES[p.body.hook_event_name as string];
		if (!sid || stage === undefined) continue;
		bySession.set(sid, [...(bySession.get(sid) ?? []), stage]);
	}
	const bad: string[] = [];
	for (const [sid, stages] of bySession) {
		for (let i = 1; i < stages.length; i++) {
			if ((stages[i] as number) < (stages[i - 1] as number)) {
				bad.push(`${sid}:${stages.join(",")}`);
				break;
			}
		}
	}
	return bad;
}

function duplicateDeliveries(posts: ProductCtx["server"]["posts"]): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const p of posts) {
		const id = p.headers["x-agentpulse-delivery-id"];
		if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return [...counts].filter(([, n]) => n > 1);
}

const g4Shared = (): boolean =>
	readFileSync(
		join(import.meta.dir, "../../src/server/services/agents/__fixtures__/opencode/OBSERVATIONS.md"),
		"utf8",
	).includes("`shared=yes`");

async function multiProject(
	ctx: ProductCtx,
	line: OpenCodeLine,
	mode: "direct" | "relay",
	ex: Expectation[],
): Promise<void> {
	const tag = mode === "relay" ? " (through the relay)" : "";
	const label = `mp-${mode}`;
	await ctx.server.reset();
	let relayStop: (() => Promise<void>) | undefined;
	let pump: (() => Promise<void>) | undefined;
	const place = makePlace(ctx.world, line, label, { probe: false });
	ctx.noteDataHome(place.sandbox.paths.XDG_DATA_HOME);
	const install = async (): Promise<void> => {
		if (mode === "direct") {
			const setup = await runSetup(ctx, place);
			expect(ex, `the real installer wrote the plugins${tag}`, "instrument", setup.code === 0);
			await ctx.server.reset();
			if (ctx.mutation && ctx.mutation !== "no-sdk-check")
				patchInstalled(place, line, ctx.mutation);
			return;
		}
		const { mkdirSync, mkdtempSync, realpathSync } = await import("node:fs");
		const root = realpathSync(mkdtempSync(join(ctx.world.root, "relay-mp-")));
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
		relayStop = () => relay.stop();
		pump = async () => {
			// A round that does not return in 20 s is recorded and abandoned (the run goes on and says so).
			const round = (async () => {
				for (let i = 0; i < 6; i++) await R.processHookQueue(relay.ctx);
			})();
			const timer = new Promise<string>((res) => setTimeout(() => res("timeout"), 20_000).unref());
			if ((await Promise.race([round.then(() => "done"), timer])) === "timeout") {
				pumpStalls.push(`${mode}: processHookQueue did not return in 20 s`);
				trace(`${mode}: pump stalled`);
			}
		};
		installRelayPlugins(place, `http://127.0.0.1:${relay.port}`, { mutation: ctx.mutation });
	};
	const cleanup: Array<() => Promise<void>> = [];
	try {
		if (line === "v2")
			await multiProjectService(ctx, place, install, ex, tag, () => pump?.(), cleanup);
		else await multiProjectServe(ctx, place, install, ex, tag, () => pump?.(), cleanup);
	} finally {
		trace(`${mode}: cleanup`);
		for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
		trace(`${mode}: relay stop`);
		await relayStop?.();
		trace(`${mode}: done`);
	}
}

/** The checks both lines share, run on what the proxy and the stored rows hold after the turns. */
async function sharedChecks(
	ctx: ProductCtx,
	ex: Expectation[],
	tag: string,
	turns: Array<{ cwd: string }>,
): Promise<void> {
	const rows = await storedRows(ctx.server);
	const dirs = new Set(rows.sessions.map((x) => x.cwd));
	expect(
		ex,
		`each project's turn stored one Stop and the session is not working${tag}`,
		"claim",
		turns.every((t) => rows.sessions.some((x) => x.cwd === t.cwd && x.isWorking === false)) &&
			turns.every((t) => {
				const sid = rows.sessions.find((x) => x.cwd === t.cwd)?.sessionId;
				return sid !== undefined && stopCount(rows, sid) === 1;
			}),
		{ dirs: [...dirs], stops: rows.events.filter((e) => e.type === "Stop").length },
	);
	const cwdOfSession = new Map(rows.sessions.map((x) => [x.sessionId as string, x.cwd as string]));
	const misplaced = ctx.server.posts.filter((p) => {
		const want = cwdOfSession.get(p.body.session_id as string);
		return want !== undefined && p.body.cwd !== want;
	});
	expect(
		ex,
		"every POST of a project's session carries that project's directory",
		"claim",
		misplaced.length === 0,
		{ misplaced: misplaced.slice(0, 3).map((p) => [p.body.hook_event_name, p.body.cwd]) },
	);
	expect(
		ex,
		"one raw POST reaches the proxy per delivery id",
		"claim",
		duplicateDeliveries(ctx.server.posts).length === 0,
		{ duplicated: duplicateDeliveries(ctx.server.posts).slice(0, 4) },
	);
	const bad = orderViolations(ctx.server.posts);
	expect(ex, "each session's events arrive in event order", "claim", bad.length === 0, {
		bad: bad.slice(0, 3),
	});
}

async function excludedPair(
	ctx: ProductCtx,
	ex: Expectation[],
	tag: string,
	runIn: (dir: string) => Promise<void>,
	place: ReadyPlace | ReturnType<typeof makePlace>,
	pump: () => Promise<void> | undefined,
): Promise<void> {
	await ctx.server.reset();
	const a = projectDir(ctx.world, `mp-excluded-${Math.random().toString(36).slice(2, 8)}`);
	const b = projectDir(ctx.world, `mp-included-${Math.random().toString(36).slice(2, 8)}`);
	writeRules(place, [a]);
	const modelBefore = ctx.world.stub.requests().length;
	await Promise.all([runIn(a), runIn(b)]);
	await pump();
	await Bun.sleep(800);
	await pump();
	const rows = await storedRows(ctx.server);
	const forA =
		rows.sessions.filter((x) => x.cwd === a).length +
		ctx.server.posts.filter((p) => p.body.cwd === a).length;
	const forB = rows.sessions.filter((x) => x.cwd === b).length;
	// Independent of the plugin and of what it sent: the model was asked for a turn in both projects.
	const modelTurns = ctx.world.stub
		.requests()
		.slice(modelBefore)
		.filter((q) => q.body.includes("PLAIN hello") && q.body.includes('"tools"')).length;
	expect(
		ex,
		"both projects' sessions were active together (the model served a turn in each)",
		"precondition",
		modelTurns >= 2,
		{ modelTurns },
	);
	expect(
		ex,
		"an excluded project sends nothing and the included one does",
		"claim",
		forA === 0 && forB === 1 && stopCount(rows) === 1,
		{ forA, forB, stops: stopCount(rows), posts: ctx.server.posts.length },
	);
}

async function multiProjectServe(
	ctx: ProductCtx,
	place: ReturnType<typeof makePlace>,
	install: () => Promise<void>,
	ex: Expectation[],
	tag: string,
	pump: () => Promise<void> | undefined,
	cleanup: Array<() => Promise<void>>,
): Promise<void> {
	trace("serve: install");
	await install();
	trace("serve: up");
	const s = await serveUp(ctx, place, `mp${tag ? "-r" : ""}`);
	cleanup.push(() => serveDown(s));
	const turns = [
		projectDir(ctx.world, `mp-p1${tag ? "r" : ""}`),
		projectDir(ctx.world, `mp-p2${tag ? "r" : ""}`),
	];
	for (const dir of turns) {
		ctx.world.rule.projectDir = dir;
		trace(`serve: create ${dir}`);
		const id = await createSession(s, dir);
		trace("serve: prompt");
		await prompt(s, id, dir, "SHELLOK run it");
		trace("serve: wait");
		await waitFor(
			async () => {
				trace("serve: pump");
				await pump();
				trace("serve: rows");
				return stopCount(await storedRows(ctx.server)) >= turns.indexOf(dir) + 1;
			},
			40_000,
			250,
		);
	}
	trace("serve: turns done");
	await pump();
	await Bun.sleep(800);
	await pump();
	trace("serve: pumped");
	expect(ex, `two projects served by one process${tag}`, "precondition", true);
	await sharedChecks(
		ctx,
		ex,
		tag,
		turns.map((cwd) => ({ cwd })),
	);
	trace("serve: excludedPair");
	await excludedPair(
		ctx,
		ex,
		tag,
		async (dir) => {
			ctx.world.rule.projectDir = dir;
			const id = await createSession(s, dir);
			await prompt(s, id, dir, "PLAIN hello");
			await Bun.sleep(5000);
		},
		place,
		pump,
	);
}

async function multiProjectService(
	ctx: ProductCtx,
	place: ReturnType<typeof makePlace>,
	install: () => Promise<void>,
	ex: Expectation[],
	tag: string,
	pump: () => Promise<void> | undefined,
	cleanup: Array<() => Promise<void>>,
): Promise<void> {
	const stubMark = ctx.world.stub.requests().length;
	const cwdOf = (n: string) => projectDir(ctx.world, `v2-mp-${n}${tag ? "r" : ""}`);
	const cli = (args: string[], label: string, cwd = cwdOf("ctl")) =>
		runTurn(ctx.world, place, { cwd, args, timeoutMs: 40_000, label });
	trace("service: start");
	const started = await cli(["service", "start"], "start");
	cleanup.push(async () => void (await cli(["service", "stop"], "stop")));
	expect(ex, `the background service started${tag}`, "instrument", started.code === 0, {
		out: started.stdout.slice(0, 120),
	});
	// A project the service loads BEFORE the plugin exists: nobody owns what runs in it.
	const unowned = cwdOf("unowned");
	const first = await runTurn(ctx.world, place, {
		cwd: unowned,
		args: ["run", "--format", "json", "PLAIN hello"],
		timeoutMs: 60_000,
		label: "unowned-1",
	});
	trace("service: install");
	await install();
	trace("service: turns");
	const runIn = (name: string) =>
		runTurn(ctx.world, place, {
			cwd: cwdOf(name),
			args: ["run", "SHELLOK run it"],
			timeoutMs: 60_000,
			label: `turn-${name}`,
		});
	const turns = ["a", "b", "c"];
	const outs = [];
	for (const n of turns) outs.push(await runIn(n));
	trace("service: continue");
	// Continue the unowned project's session: instances that never saw it would all forward its turn end.
	const again = await runTurn(ctx.world, place, {
		cwd: unowned,
		args: ["run", "--continue", "--format", "json", "PLAIN again"],
		timeoutMs: 60_000,
		label: "unowned-2",
	});
	trace("service: pump");
	await pump();
	await Bun.sleep(1200);
	await pump();
	const home = place.sandbox.paths.HOME;
	const logLines = (name: string): string[] =>
		existsSync(join(home, name))
			? readFileSync(join(home, name), "utf8").split("\n").filter(Boolean)
			: [];
	if (ctx.mutation === "no-seen-set") {
		expect(
			ex,
			`the seen-set had something to drop: two instances forwarded one event${tag}`,
			"precondition",
			logLines(SEEN_LOG).length >= 1,
			{ hits: logLines(SEEN_LOG).slice(0, 3) },
		);
	}
	if (ctx.mutation === "per-instance-queue") {
		const instances = new Map<string, Set<string>>();
		for (const line of logLines(QUEUE_LOG)) {
			const [sid, inst] = line.split(" ");
			if (sid && inst) instances.set(sid, (instances.get(sid) ?? new Set()).add(inst));
		}
		expect(
			ex,
			`two instances' chains served one session${tag}`,
			"precondition",
			[...instances.values()].some((set) => set.size >= 2),
			{ sessions: instances.size },
		);
	}
	expect(
		ex,
		`every run exited 0${tag}`,
		"instrument",
		[first, ...outs, again].every((r) => r.code === 0 && !r.timedOut),
		{ codes: [first, ...outs, again].map((r) => r.code), again: again.stderr.slice(0, 200) },
	);
	expect(
		ex,
		"the observed layout is one process with shared state (G4)",
		"precondition",
		g4Shared(),
	);
	// Independent of what the plugin sent: the model served a tool turn in each of the three projects.
	const toolTurns = ctx.world.stub
		.requests()
		.slice(stubMark)
		.filter((q) => q.body.includes("SHELLOK run it") && q.body.includes('"tools"')).length;
	expect(
		ex,
		`three projects ran on the one service (the model served three tool turns)${tag}`,
		"precondition",
		toolTurns >= 3,
		{ toolTurns },
	);
	const idOf = (text: string) => /"sessionID":"(ses_[A-Za-z0-9]+)"/.exec(text)?.[1];
	const unownedId = idOf(again.stdout) ?? idOf(first.stdout);
	expect(
		ex,
		`a session no instance owns exists: it ran a second turn after the plugin was installed${tag}`,
		"precondition",
		Boolean(unownedId) && idOf(first.stdout) === idOf(again.stdout),
		{ unownedId },
	);
	await sharedChecks(
		ctx,
		ex,
		tag,
		turns.map((n) => ({ cwd: cwdOf(n) })),
	);
	await excludedPair(
		ctx,
		ex,
		tag,
		async (dir) => {
			const r = await runTurn(ctx.world, place, {
				cwd: dir,
				args: ["run", "PLAIN hello"],
				timeoutMs: 60_000,
				label: "excl",
			});
			ex.push({
				name: `a run in ${dir.split("/").pop()} exited 0`,
				kind: "instrument",
				ok: r.code === 0,
			});
		},
		place,
		pump,
	);
}
