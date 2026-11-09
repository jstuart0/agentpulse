/**
 * The measurement scenarios of Phase 0 (AGEN-141) that need a long-running OpenCode: `serve` (drive a headless
 * server over HTTP: permission accept, abort, two directories), `service` (the 2.x background service: shared
 * state, the skip switch, replacing the plugin) and `exit` (does the last event of a short run get out).
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenCodeLine } from "../lib/opencode-canary-pins.js";
import type { OpenCodeChild } from "../lib/opencode-canary-spawn.js";
import { opencodeLaunchdLabels } from "../lib/opencode-canary-watch.js";
import { ownOpenCodePids } from "../lib/opencode-own-pids.js";
import { events, type J, analyzeV1Call, distinct, eventNamesAfter } from "./analyze.js";
import {
	type CaptureOut,
	type Collected,
	type GateRow,
	type MeasureContext,
	type MeasureOutput,
	collect,
	loads,
	row,
	saveRecords,
	tally,
} from "./measure-kit.js";
import {
	type Place,
	makePlace,
	probeSource,
	projectDir,
	readProbe,
	runTurn,
	startLong,
	waitFor,
} from "./world.js";

/** `ps -o comm=` of a pid: documents what the binaries call themselves (never used to select a process). */
const commOf = (pid: number): string =>
	spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" })
		.stdout.trim()
		.split("/")
		.pop() ?? "";

let portCursor = 24_500 + Math.floor(Math.random() * 2000);
const nextPort = () => ++portCursor;

export interface Server {
	line: OpenCodeLine;
	place: Place;
	child: OpenCodeChild;
	base: string;
	headers: Record<string, string>;
	cwd: string;
}

async function startServer(
	ctx: MeasureContext,
	line: OpenCodeLine,
	name: string,
	permission?: Record<string, string>,
): Promise<Server> {
	const place = makePlace(ctx.world, line, name, permission ? { permission } : {});
	ctx.noteDataHome(place.sandbox.paths.XDG_DATA_HOME);
	const cwd = projectDir(ctx.world, `${line}-${name}`);
	const port = nextPort();
	const child = await startLong(
		ctx.world,
		place,
		["serve", "--port", String(port), "--hostname", "127.0.0.1"],
		cwd,
		"serve",
		{
			extraEnv: { OPENCODE_SERVER_PASSWORD: "pw" },
			timeoutMs: 240_000,
		},
	);
	const base = `http://127.0.0.1:${port}`;
	const headers = {
		authorization: `Basic ${btoa("opencode:pw")}`,
		"content-type": "application/json",
	};
	const up = await waitFor(
		async () => {
			try {
				return (await fetch(`${base}/global/health`, { headers })).status > 0;
			} catch {
				return false;
			}
		},
		30_000,
		300,
	);
	if (!up) throw new Error(`${line} serve did not come up`);
	return { line, place, child, base, headers, cwd };
}

async function stopServer(server: Server): Promise<void> {
	server.child.kill();
	await server.child.exited;
}

/** A request to the served OpenCode that gives up (a hung server must not hang the canary). */
const ask = (url: string, init?: RequestInit) =>
	fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });

const q = (dir: string) => `directory=${encodeURIComponent(dir)}`;

export async function createSession(s: Server, dir: string): Promise<string> {
	if (s.line === "v1") {
		const r = await ask(`${s.base}/session?${q(dir)}`, {
			method: "POST",
			headers: s.headers,
			body: "{}",
		});
		return ((await r.json()) as J).id as string;
	}
	const r = await ask(`${s.base}/api/session`, {
		method: "POST",
		headers: s.headers,
		body: JSON.stringify({ location: { directory: dir } }),
	});
	return ((await r.json()) as J).data.id as string;
}

export async function prompt(s: Server, id: string, dir: string, text: string): Promise<void> {
	if (s.line === "v1") {
		await ask(`${s.base}/session/${id}/prompt_async?${q(dir)}`, {
			method: "POST",
			headers: s.headers,
			body: JSON.stringify({ parts: [{ type: "text", text }] }),
		});
	} else {
		await ask(`${s.base}/api/session/${id}/prompt`, {
			method: "POST",
			headers: s.headers,
			body: JSON.stringify({ text }),
		});
	}
}

export async function pendingPermissions(s: Server, id: string, dir: string): Promise<J[]> {
	const url =
		s.line === "v1" ? `${s.base}/permission?${q(dir)}` : `${s.base}/api/session/${id}/permission`;
	const body = (await (await ask(url, { headers: s.headers })).json()) as J;
	return (s.line === "v1" ? body : body.data) ?? [];
}

export async function replyPermission(
	s: Server,
	id: string,
	dir: string,
	requestID: string,
): Promise<void> {
	if (s.line === "v1") {
		await ask(`${s.base}/permission/${requestID}/reply?${q(dir)}`, {
			method: "POST",
			headers: s.headers,
			body: JSON.stringify({ reply: "once" }),
		});
	} else {
		await ask(`${s.base}/api/session/${id}/permission/${requestID}/reply`, {
			method: "POST",
			headers: s.headers,
			body: JSON.stringify({ decision: "once" }),
		});
	}
}

export async function interrupt(s: Server, id: string, dir: string): Promise<void> {
	const url =
		s.line === "v1"
			? `${s.base}/session/${id}/abort?${q(dir)}`
			: `${s.base}/api/session/${id}/interrupt`;
	await ask(url, { method: "POST", headers: s.headers });
}

const endsTurn = (line: OpenCodeLine, e: J, id: string): boolean =>
	line === "v1"
		? e.type === "session.idle" && e.properties?.sessionID === id
		: (e.type === "session.execution.succeeded" || e.type === "session.execution.failed") &&
			e.data?.sessionID === id;

const waitTurnEnd = (s: Server, id: string, ms = 30_000) =>
	waitFor(() => events(readProbe(s.place)).some((e) => endsTurn(s.line, e.event, id)), ms, 250);

// ---------------------------------------------------------------------------------------------------------
// serve: G8, G12, G13, G15 (V1)

async function serveScenario(ctx: MeasureContext): Promise<MeasureOutput> {
	const gates: GateRow[] = [];
	const captures: CaptureOut[] = [];
	const evidence: Record<string, unknown> = {};
	const cmd = "--measure --only serve";
	const ask = { edit: "ask", write: "ask", bash: "allow", read: "allow", task: "allow" };
	const tokens12: string[] = [];
	const tokens13: string[] = [];
	const tokens8: string[] = [];
	let a12 = "";
	let a13 = "";
	let a8 = "";
	const procNames: Record<string, string[]> = {};
	let v2PermissionSeen = false;
	let abortDistinct = true;

	for (const line of ["v1", "v2"] as const) {
		// Permission accept.
		const s = await startServer(ctx, line, "perm", ask);
		procNames[line] = ownOpenCodePids(s.place.sandbox.paths.XDG_DATA_HOME).map(commOf);
		ctx.world.rule.projectDir = s.cwd;
		const id = await createSession(s, s.cwd);
		await prompt(s, id, s.cwd, "PERMASK please");
		let pending: J[] = [];
		await waitFor(
			async () => {
				pending = await pendingPermissions(s, id, s.cwd);
				return pending.length > 0;
			},
			25_000,
			300,
		);
		const first = pending[0];
		if (first) await replyPermission(s, id, s.cwd, first.id);
		await waitTurnEnd(s, id);
		let records = readProbe(s.place);
		saveRecords(ctx, line, "permission-accept", records);
		captures.push({
			line,
			name: "permission-accept",
			scenario: "serve",
			prompt: "PERMASK please",
			records,
		});
		const asked = events(records).filter((e) => e.event.type === "permission.asked");
		const replied = events(records).filter((e) => e.event.type === "permission.replied");
		if (line === "v1") {
			const callID = asked[0]?.event.properties?.tool?.callID as string | undefined;
			const after = records.filter(
				(r) => r.kind === "tool.execute.after" && r.data.i?.callID === callID,
			);
			const before = records.filter(
				(r) => r.kind === "tool.execute.before" && r.data.i?.callID === callID,
			);
			const parts = callID ? analyzeV1Call(records, callID) : null;
			evidence.v1Accept = {
				callID,
				asked: asked.length,
				replied: replied.map((r) => r.event.properties),
				before: before.length,
				after: after.length,
				parts,
			};
			a12 = `V1 permission.asked carries tool.callID: ${callID ? "yes" : "NO"} (${asked.length} asked). After reply "once" the call's tool.execute.after fires with the same callID: ${after.length > 0 ? "yes" : "no"}; permission.replied carries ${Object.keys(replied[0]?.event.properties ?? {}).join(", ")} and no callID.`;
			tokens12.push(
				`v1.asked_callid=${callID ? "present" : "absent"}`,
				`v1.accept_post_same_callid=${after.length > 0 ? "yes" : "no"}`,
				`v1.replied_has_callid=${replied[0]?.event.properties?.tool?.callID || replied[0]?.event.properties?.callID ? "yes" : "no"}`,
			);
		} else {
			v2PermissionSeen = asked.length > 0;
			const askedData = asked[0]?.event.data ?? {};
			a8 = `V2 with permission edit:"ask" (served, replied through the API with decision "once"): events ${
				distinct(
					events(records)
						.map((e) => String(e.event.type))
						.filter((t) => t.startsWith("permission.")),
				).join(", ") || "none"
			}; asked data keys ${Object.keys(askedData).join(", ") || "n/a"}; the call id is at source.id (${askedData.source?.id ?? "n/a"}); replied data keys ${Object.keys(replied[0]?.event.data ?? {}).join(", ") || "n/a"}.`;
			tokens8.push(
				`v2.permission_events=${
					distinct(
						events(records)
							.map((e) => String(e.event.type))
							.filter((t) => t.startsWith("permission.")),
					).join("+") || "none"
				}`,
				`v2.asked_call_id_at=${askedData.source?.id ? "data.source.id" : "none"}`,
			);
			evidence.v2Accept = {
				asked: asked.map((a) => a.event),
				replied: replied.map((r) => r.event),
			};
		}
		await stopServer(s);

		// Abort.
		const t = await startServer(ctx, line, "abort");
		ctx.world.rule.projectDir = t.cwd;
		const sid = await createSession(t, t.cwd);
		await prompt(t, sid, t.cwd, "SLOWCALL abort me");
		const started = await waitFor(
			() =>
				readProbe(t.place).some(
					(r) => r.kind === "tool.execute.before" || r.kind === "tool.before",
				),
			25_000,
			200,
		);
		const mark = readProbe(t.place).length;
		await interrupt(t, sid, t.cwd);
		await Bun.sleep(7000);
		records = readProbe(t.place);
		saveRecords(ctx, line, "abort", records);
		captures.push({ line, name: "abort", scenario: "serve", prompt: "SLOWCALL abort me", records });
		const names = eventNamesAfter(records, mark - 1);
		const errors = events(records)
			.filter((e) => e.i >= mark)
			.filter(
				(e) =>
					e.event.type === "session.error" ||
					e.event.type === "session.execution.failed" ||
					e.event.type === "session.step.failed",
			)
			.map((e) => ({
				type: e.event.type,
				error: e.event.properties?.error ?? e.event.data?.error,
			}));
		const signal = errors[0]?.error?.name ?? errors[0]?.error?.type ?? "none";
		const distinctAbort = signal !== "none" && /abort|interrupt|cancel/i.test(String(signal));
		if (!distinctAbort) abortDistinct = false;
		a13 += ` ${line === "v1" ? "V1 (POST /session/:id/abort)" : "V2 (POST /api/session/:id/interrupt)"} during a running shell call (started: ${started}): events after, in order: ${distinct(names).join(" > ") || "none"}; first error/failure signal ${JSON.stringify(errors[0] ?? null).slice(0, 200)}.`;
		tokens13.push(
			`${line}.abort_events=${distinct(names).join(">") || "none"}`,
			`${line}.abort_signal=${signal}`,
		);
		evidence[`${line}Abort`] = { names, errors };
		await stopServer(t);
	}
	gates.push(
		row(
			"G12",
			"V1: is tool.callID ever absent on permission.asked? Does an accepted ask produce the call's Post with the same callID?",
			a12,
			"pass",
			tokens12,
			cmd,
		),
		row(
			"G13",
			"Abort (V1 Esc via API, V2 abort): which events, in what order?",
			a13.trim(),
			abortDistinct ? "branch-distinct-abort" : "branch-no-distinct-abort",
			tokens13,
			cmd,
		),
		row(
			"G8",
			'V2 with permission: { edit: "ask" }: event names and fields?',
			a8,
			v2PermissionSeen ? "pass" : "branch-no-v2-permission",
			tokens8,
			cmd,
		),
	);

	gates.push(
		row(
			"G14",
			"(part 3) What do the binaries call themselves in the process table?",
			`\`ps -o comm=\` of a running \`serve\`: 1.x ${JSON.stringify(procNames.v1 ?? [])}, 2.x ${JSON.stringify(procNames.v2 ?? [])}. Documented only: processes are found by this run's XDG_DATA_HOME in their environment, never by name.`,
			"pass",
			[
				`v1.process_name=${procNames.v1?.[0] ?? "unknown"}`,
				`v2.process_name=${procNames.v2?.[0] ?? "unknown"}`,
			],
			cmd,
		),
	);

	// G15, V1: one server, two directories, both busy at once.
	const s = await startServer(ctx, "v1", "fanout");
	const dirs = [projectDir(ctx.world, "v1-fanout-a"), projectDir(ctx.world, "v1-fanout-b")];
	const ids: string[] = [];
	for (const d of dirs) ids.push(await createSession(s, d));
	await Promise.all(ids.map((id, i) => prompt(s, id, dirs[i] as string, "SHELLOK both")));
	await Promise.all(ids.map((id) => waitTurnEnd(s, id)));
	const records = readProbe(s.place);
	saveRecords(ctx, "v1", "fanout", records);
	const dirOf = new Map<string, string>();
	for (const e of events(records)) {
		if (e.event.type === "session.created")
			dirOf.set(e.event.properties.sessionID, e.event.properties.info.directory);
	}
	const toolHooks = records.filter((r) => r.kind === "tool.execute.before");
	const known = toolHooks.filter((r) => dirOf.has(r.data.i.sessionID));
	const mismatched = known.filter((r) => dirOf.get(r.data.i.sessionID) !== r.data.directory);
	const unknownDir = toolHooks.length - known.length;
	const perCall = tally(toolHooks.map((r) => `${r.data.i.sessionID}:${r.data.i.callID}`));
	const idsSeen = tally(events(records).map((e) => e.event.id));
	const duplicatedEvents = Object.values(idsSeen).filter((n) => n > 1).length;
	evidence.v1Fanout = {
		toolHooks: toolHooks.length,
		mismatched: mismatched.length,
		loads: loads(records).length,
		duplicatedEvents,
	};
	gates.push(
		row(
			"G15",
			"Is a tool.hook for a call in project A ever invoked on the instance loaded for project B? Which instance runs a session's tool hooks?",
			`V1 serve with two directories, both turns at once: ${loads(records).length} plugin instances loaded; ${toolHooks.length} tool.execute.before hooks, ${mismatched.length} of the ${known.length} whose session directory was seen ran on an instance whose directory differs from the session's (${unknownDir} session.created events were never seen by the plugin); each call's hook fired ${Object.values(perCall).every((n) => n === 1) ? "once" : "more than once"}; ${duplicatedEvents} bus events were delivered twice.`,
			"pass",
			[
				`v1.tool_hook_fanout=${mismatched.length > 0 ? "yes" : "no"}`,
				`v1.bus_event_fanout=${duplicatedEvents > 0 ? "yes" : "no"}`,
			],
			cmd,
		),
	);
	await stopServer(s);
	return { id: "serve", gates, captures, evidence };
}

// ---------------------------------------------------------------------------------------------------------
// exit: G6

async function exitScenario(ctx: MeasureContext): Promise<MeasureOutput> {
	const cmd = "--measure --only exit";
	const evidence: Record<string, unknown> = {};
	const tokens: string[] = [];
	const parts: string[] = [];
	let lost = false;
	const turnEndPosts = () =>
		ctx.world.capture.posts.filter((p) => {
			try {
				return (JSON.parse(p.body) as J).kind === "turn-end";
			} catch {
				return false;
			}
		}).length;
	for (const line of ["v1", "v2"] as const) {
		let arrived = 0;
		const runs: Collected[] = [];
		for (let i = 1; i <= 5; i++) {
			const before = turnEndPosts();
			const c = await collect(ctx, line, `exit-${i}`, { prompt: "SHELLOK again" });
			await Bun.sleep(300);
			arrived += turnEndPosts() - before;
			runs.push(c);
		}
		const beforeExit = runs.filter((c) =>
			c.records.some((r) => r.kind === "process.beforeExit"),
		).length;
		const exit = runs.filter((c) => c.records.some((r) => r.kind === "process.exit")).length;
		const cleanup = runs.filter((c) => c.records.some((r) => r.kind === "cleanup")).length;
		evidence[line] = { arrived, beforeExit, exit, cleanup, codes: runs.map((c) => c.code) };
		if (arrived < 5) lost = true;
		parts.push(
			`${line}: the turn-end POST arrived in ${arrived} of 5 short \`run\`s; process "beforeExit" fired in ${beforeExit} of 5, "exit" in ${exit} of 5${line === "v2" ? `; the plugin's cleanup function ran in ${cleanup} of 5` : ""}.`,
		);
		tokens.push(
			`${line}.turn_end_post=${arrived}/5`,
			`${line}.beforeExit=${beforeExit}/5`,
			`${line}.exit_event=${exit}/5`,
		);
		if (line === "v2") tokens.push(`v2.cleanup_on_shutdown=${cleanup}/5`);
	}
	return {
		id: "exit",
		gates: [
			row(
				"G6",
				"After opencode run exits, did the turn-end POST arrive (both lines, no service)? Does beforeExit fire, or only exit? Does V2 call a plugin cleanup on shutdown?",
				parts.join(" "),
				lost ? "branch-lost-turn-end" : "pass",
				tokens,
				cmd,
			),
		],
		captures: [],
		evidence,
	};
}

// ---------------------------------------------------------------------------------------------------------
// service: G4, G5, G11, G14, G15 (V2)

async function serviceScenario(ctx: MeasureContext): Promise<MeasureOutput> {
	const cmd = "--measure --only service";
	const evidence: Record<string, unknown> = {};
	const gates: GateRow[] = [];
	const captures: CaptureOut[] = [];
	const labelsBefore = opencodeLaunchdLabels();
	const place = makePlace(ctx.world, "v2", "svc", {});
	ctx.noteDataHome(place.sandbox.paths.XDG_DATA_HOME);
	const dataHome = place.sandbox.paths.XDG_DATA_HOME;
	const cwdOf = (n: string) => projectDir(ctx.world, `v2-svc-${n}`);
	const cli = async (args: string[], label: string) =>
		runTurn(ctx.world, place, { cwd: cwdOf("ctl"), args, timeoutMs: 40_000, label });
	const turn = (n: string, extraEnv?: Record<string, string>, args?: string[]) =>
		runTurn(ctx.world, place, {
			cwd: cwdOf(n),
			prompt: "SHELLOK hi",
			timeoutMs: 40_000,
			...(extraEnv ? { extraEnv } : {}),
			...(args ? { args } : {}),
			label: `turn-${n}`,
		});

	const statusBefore = (await cli(["service", "status"], "status-before")).stdout.trim();
	const start = (await cli(["service", "start"], "start")).stdout.trim();
	const servicePids = ownOpenCodePids(dataHome);
	const statusDuring = (await cli(["service", "status"], "status-during")).stdout.trim();
	const labelsDuring = opencodeLaunchdLabels();
	const listening = spawnSync(
		"lsof",
		["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", servicePids.join(",") || "0"],
		{ encoding: "utf8" },
	).stdout;
	const port = /:(\d+)/.exec(statusDuring)?.[1];
	const statusIsOurs = Boolean(port) && listening.includes(`:${port}`);

	// G4: three projects on one service.
	for (const n of ["a", "b", "c"]) await turn(n);
	// Two at once, for G15.
	await Promise.all([turn("d"), turn("e")]);
	let records = readProbe(place);
	saveRecords(ctx, "v2", "service-main", records);
	captures.push({
		line: "v2",
		name: "service-shared",
		scenario: "service",
		prompt: "SHELLOK hi (five projects, one service)",
		records,
	});
	const counters = loads(records).map((r) => r.data.counter as number);
	const loadPids = distinct(loads(records).map((r) => r.pid));
	const shared =
		loads(records).length >= 3 &&
		loadPids.length === 1 &&
		counters
			.slice()
			.sort((a, b) => a - b)
			.join() === counters.map((_, i) => i + 1).join();
	const dirOf = new Map<string, string>();
	for (const e of events(records)) {
		if (e.event.type === "session.created")
			dirOf.set(
				e.event.data.sessionID,
				e.event.data.location?.directory ?? e.event.location?.directory,
			);
	}
	const toolHooks = records.filter((r) => r.kind === "tool.before");
	const knownHooks = toolHooks.filter((r) => dirOf.has(r.data.event.sessionID));
	const mismatched = knownHooks.filter(
		(r) => dirOf.get(r.data.event.sessionID) !== r.data.directory,
	);
	const unknownDir = toolHooks.length - knownHooks.length;
	const hooksPerCall = tally(toolHooks.map((r) => `${r.data.event.sessionID}:${r.data.event.id}`));
	const deliveries = tally(
		events(records)
			.filter((e) => e.event.type === "session.execution.succeeded")
			.map((e) => String(e.event.id)),
	);
	const fanoutMax = Math.max(0, ...Object.values(deliveries));
	evidence.g4 = {
		counters,
		loadPids,
		shared,
		fanoutMax,
		mismatched: mismatched.length,
		toolHooks: toolHooks.length,
	};
	gates.push(
		row(
			"G4",
			"3 projects on one V2 service: shared globalThis? (Symbol.for counter)",
			`Plugin setup ran ${loads(records).length} times in ${loadPids.length} process(es) for 5 projects; the Symbol.for counter read ${counters.join(", ")}: globalThis is ${shared ? "SHARED" : "not shared"} across instances. One session.execution.succeeded id was delivered to up to ${fanoutMax} instance(s).`,
			shared ? "branch-shared" : "branch-not-shared",
			[`shared=${shared ? "yes" : "no"}`, `v2.event_fanout_max=${fanoutMax}`],
			cmd,
		),
		row(
			"G15",
			"(part 2) V2: is a tool.hook for a call in project A ever invoked on the instance of project B?",
			`V2 service, five projects (two at once): ${toolHooks.length} tool.before hooks, ${mismatched.length} of the ${knownHooks.length} whose session directory was seen ran on an instance whose location.directory differs from the session's (${unknownDir} session.created events were never seen: a session created before its project's plugin instance subscribed is invisible to it); each call's hook fired ${Object.values(hooksPerCall).every((n) => n === 1) ? "once" : "more than once"}.`,
			"pass",
			[
				`v2.tool_hook_fanout=${mismatched.length > 0 || Object.values(hooksPerCall).some((n) => n > 1) ? "yes" : "no"}`,
			],
			cmd,
		),
	);

	// G5: the skip switch with the service running, then without.
	const markSkip = readProbe(place).length;
	await turn("skip-svc", { AGENTPULSE_SKIP: "1" });
	const skipSvc = readProbe(place)
		.slice(markSkip)
		.filter((r) => r.kind === "tool.before")
		.map((r) => r.data.skip);
	const v1Skip = await collect(ctx, "v1", "skip", {
		prompt: "SHELLOK hi",
		extraEnv: { AGENTPULSE_SKIP: "1" },
	});
	const skipV1 = v1Skip.records
		.filter((r) => r.kind === "tool.execute.before")
		.map((r) => r.data.skip);
	const standalone = await turn("skip-standalone", { AGENTPULSE_SKIP: "1" }, [
		"run",
		"--standalone",
		"SHELLOK hi",
	]);
	const skipStandalone = readProbe(place)
		.slice(markSkip)
		.filter((r) => r.kind === "tool.before")
		.map((r) => r.data.skip);
	evidence.g5svc = { skipSvc, skipStandalone, standaloneCode: standalone.code };

	// G11: replace the plugin file while the service runs.
	const tagsFor = (from: number, dir: string) =>
		distinct(
			readProbe(place)
				.slice(from)
				.filter((r) => r.kind === "tool.before" && r.data.directory === dir)
				.map((r) => r.tag),
		);
	const dirA = cwdOf("a");
	const dirNew = cwdOf("fresh");
	writeFileSync(join(place.pluginsDir, "probe.js"), probeSource("v2", "B"));
	let mark = readProbe(place).length;
	await turn("a");
	const tagsA = tagsFor(mark, dirA);
	mark = readProbe(place).length;
	await turn("fresh");
	const tagsFresh = tagsFor(mark, dirNew);
	const loadsAfter = loads(readProbe(place).slice(markSkip)).map(
		(r) => `${r.tag}@${r.data.location?.directory?.split("/").pop()}`,
	);
	evidence.g11 = { tagsA, tagsFresh, loadsAfter };

	// Stop and start again: which file runs now?
	await cli(["service", "stop"], "stop");
	await Bun.sleep(1500);
	const strayAfterStop = ownOpenCodePids(dataHome);
	await cli(["service", "start"], "start-2");
	mark = readProbe(place).length;
	await turn("a");
	const tagsRestart = tagsFor(mark, dirA);

	// Skip without a service: stop it, then run (a private server per run).
	await cli(["service", "stop"], "stop-2");
	await Bun.sleep(1500);
	const markNoSvc = readProbe(place).length;
	await turn("skip-none", { AGENTPULSE_SKIP: "1" });
	const skipNone = readProbe(place)
		.slice(markNoSvc)
		.filter((r) => r.kind === "tool.before")
		.map((r) => r.data.skip);
	const statusAfter = (await cli(["service", "status"], "status-after")).stdout.trim();
	records = readProbe(place);
	saveRecords(ctx, "v2", "service-all", records);
	const labelsAfter = opencodeLaunchdLabels();

	gates.push(
		row(
			"G5",
			"Does AGENTPULSE_SKIP=1 opencode run reach the plugin with a V2 service running? Without?",
			`V2 with the background service running, \`AGENTPULSE_SKIP=1 opencode run\`: the plugin's tool hook saw AGENTPULSE_SKIP=${JSON.stringify(skipSvc[0] ?? null)} (the service process's own environment). With \`--standalone\` (private server) it saw ${JSON.stringify(skipStandalone[skipStandalone.length - 1] ?? null)}. With no service running (the run starts its own private server) it saw ${JSON.stringify(skipNone[0] ?? null)}. V1 (no service exists on 1.x; the plugin runs in the same process as the run): the tool hook saw AGENTPULSE_SKIP=${JSON.stringify(skipV1[0] ?? null)}.`,
			skipSvc[0] === "1" ? "pass" : "branch-service-blind",
			[
				`v2.skip_with_service=${skipSvc[0] === "1" ? "seen" : "not_seen"}`,
				`v2.skip_standalone=${skipStandalone.at(-1) === "1" ? "seen" : "not_seen"}`,
				`v2.skip_no_service=${skipNone[0] === "1" ? "seen" : "not_seen"}`,
				`v1.skip_in_process=${skipV1[0] === "1" ? "seen" : "not_seen"}`,
			],
			cmd,
		),
		row(
			"G11",
			"With a V2 service running, replacing the plugin file: reloaded, kept, or both versions loaded?",
			`Service running with plugin tag A loaded for project a; file replaced with tag B. A new run in project a (already loaded) used tag(s) ${tagsA.join("+") || "none"}; a run in a project the service had not seen used tag(s) ${tagsFresh.join("+") || "none"}; after \`service stop\` and \`service start\` a run in project a used ${tagsRestart.join("+") || "none"}. Stray opencode processes after stop: ${strayAfterStop.length}.`,
			"pass",
			[
				`v2.replace_loaded=${tagsA.join("+") || "none"}`,
				`v2.replace_new_project=${tagsFresh.join("+") || "none"}`,
				`v2.replace_after_restart=${tagsRestart.join("+") || "none"}`,
			],
			cmd,
		),
		row(
			"G14",
			"Does service status under a scratch env see only a scratch service? Is there a --standalone mode?",
			`\`service status\` printed ${JSON.stringify(statusBefore)} before start, ${JSON.stringify(statusDuring)} while running (the port is the one this run's service pid listens on: ${statusIsOurs}), ${JSON.stringify(statusAfter)} after stop. \`service start\` printed ${JSON.stringify(start)} and left ${servicePids.length} process(es) of this run (parent pid 1, found by the run's XDG_DATA_HOME). \`run --standalone\` completed (exit ${standalone.code}) on a private server. launchd labels containing "opencode": before ${JSON.stringify(labelsBefore)}, while running ${JSON.stringify(labelsDuring)}, after ${JSON.stringify(labelsAfter)}.`,
			statusIsOurs && labelsDuring.length === labelsBefore.length
				? "pass"
				: "branch-service-registers",
			[
				`v2.service_status=${statusIsOurs ? "scratch_only" : "unverified"}`,
				`v2.standalone=${standalone.code === 0 ? "yes" : "no"}`,
				`v2.service_launchd_label=${labelsDuring.length > labelsBefore.length ? "yes" : "no"}`,
			],
			cmd,
		),
	);
	return { id: "service", gates, captures, evidence };
}

export const LIVE_SCENARIOS = {
	serve: { run: serveScenario },
	exit: { run: exitScenario },
	service: { needsService: true, run: serviceScenario },
};
