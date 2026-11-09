/**
 * Test kit for the OpenCode plugins (AGEN-141): loads a filled plugin from a
 * temp file, fakes the context each line gives it (from the captured key
 * lists), replays a Phase 0 capture through it, and collects what it POSTs.
 * Used by scripts/opencode-plugin-*.test.ts and the live canary's self-tests.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENCODE_PLUGIN_HASHES } from "../../src/shared/opencode-plugin-text.generated.ts";
import { buildPlugin } from "./opencode-plugin-embed.ts";

const PLUGIN_SOURCES = {
	core: readFileSync(join(import.meta.dir, "../opencode-plugin/core.js"), "utf8"),
	v1: readFileSync(join(import.meta.dir, "../opencode-plugin/agentpulse-opencode-1.js"), "utf8"),
	v2: readFileSync(join(import.meta.dir, "../opencode-plugin/agentpulse-opencode-2.js"), "utf8"),
};
/** The plugin text with the test seam kept in: what the tests load. The installers never carry it. */
const SEAM_TEMPLATES = {
	v1: buildPlugin(PLUGIN_SOURCES, "v1", { seam: true }).text,
	v2: buildPlugin(PLUGIN_SOURCES, "v2", { seam: true }).text,
};

export const FIXTURES = join(
	import.meta.dir,
	"../../src/server/services/agents/__fixtures__/opencode",
);

process.env.AP_TEST_SEAM = "1";
const SEAM = Symbol.for("agentpulse.opencode.seam");

export interface Seam {
	env?: Record<string, string | undefined>;
	platform?: string;
	getuid?: (() => number) | undefined;
	now?: () => number;
	fetch?: typeof fetch;
}

export type Line = "v1" | "v2";

let counter = 0;
const tmpRoot = mkdtempSync(join(tmpdir(), "ap-oc-plugin-"));

export function scratchDir(name: string): string {
	const dir = join(tmpRoot, `${name}-${String(++counter).padStart(5, "0")}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Fresh process-wide state, as after a restart. */
export function resetRecord(line: Line): void {
	const key = Symbol.for(`agentpulse.opencode.${OPENCODE_PLUGIN_HASHES[line]}`);
	(globalThis as Record<symbol, unknown>)[key] = undefined;
}

export function recordOf(line: Line): Record<string, any> {
	const key = Symbol.for(`agentpulse.opencode.${OPENCODE_PLUGIN_HASHES[line]}`);
	return (globalThis as Record<symbol, any>)[key];
}

export function fillTemplate(
	line: Line,
	baseUrl: string,
	direct = false,
	mutate?: (t: string) => string,
): string {
	const base = SEAM_TEMPLATES[line]
		.split("@@AP_OPENCODE_BASE_URL@@")
		.join(baseUrl)
		.split("@@AP_OPENCODE_DIRECT@@")
		.join(direct ? "1" : "0");
	return mutate ? mutate(base) : base;
}

export async function loadPluginModule(
	line: Line,
	baseUrl: string,
	seam: Seam,
	opts: { direct?: boolean; mutate?: (t: string) => string } = {},
): Promise<any> {
	const file = join(scratchDir(`plugin-${line}`), "plugin.js");
	writeFileSync(file, fillTemplate(line, baseUrl, opts.direct ?? false, opts.mutate));
	(globalThis as Record<symbol, unknown>)[SEAM] = seam;
	return import(`${file}?v=${++counter}`);
}

export interface Received {
	headers: Record<string, string>;
	body: any;
	raw: string;
	url: string;
}

export function startCollector(options: { delayMs?: () => number; hang?: boolean } = {}) {
	const received: Received[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const raw = await req.text();
			if (options.hang) await new Promise(() => {});
			if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs?.()));
			const headers: Record<string, string> = {};
			req.headers.forEach((v, k) => {
				headers[k] = v;
			});
			let body: unknown;
			try {
				body = JSON.parse(raw);
			} catch {
				body = null;
			}
			received.push({ headers, body, raw, url: req.url });
			return Response.json({ ok: true });
		},
	});
	return { received, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** Waits until the plugin's chains are empty and nothing is in flight. */
export async function settle(line: Line, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const rec = recordOf(line);
		const idle =
			!rec ||
			(rec.inflight === 0 &&
				rec.gateActive === 0 &&
				rec.queuedItems === 0 &&
				[...rec.sessions.values()].every((s: any) => !s.running && s.q.length === 0));
		if (idle) {
			await new Promise((r) => setTimeout(r, 15));
			const again = recordOf(line);
			if (!again || (again.inflight === 0 && again.queuedItems === 0)) return;
		}
		if (Date.now() > deadline) throw new Error("plugin did not settle");
		await new Promise((r) => setTimeout(r, 10));
	}
}

export interface Capture {
	line: string;
	records: Array<Record<string, any>>;
}

export function readCapture(line: Line, name: string): Capture {
	return JSON.parse(readFileSync(join(FIXTURES, "captures", line, `${name}.json`), "utf8"));
}

export function readEnvelopes(line: Line, name: string): any[] {
	const file = JSON.parse(readFileSync(join(FIXTURES, "envelopes", line, `${name}.json`), "utf8"));
	return Object.values(file).find(Array.isArray) as any[];
}

/** The reduced and full contexts, as key lists captured in Phase 0. */
export function v1Ctx(directory: string): Record<string, unknown> {
	return {
		directory,
		worktree: "/",
		project: {},
		client: {},
		serverUrl: new URL("http://localhost:1/"),
	};
}

export interface V2Fake {
	ctx: Record<string, any>;
	push: (event: unknown) => void;
	hooks: Map<string, (e: any) => unknown>;
	cleanup: () => unknown;
	aborted: () => boolean;
}

export function v2Ctx(directory: string): Omit<V2Fake, "cleanup"> {
	const queue: unknown[] = [];
	let wake: (() => void) | undefined;
	let aborted = false;
	const hooks = new Map<string, (e: any) => unknown>();
	const ctx = {
		app: { version: "2.2.6" },
		location: { directory },
		event: {
			subscribe(opts?: { signal?: AbortSignal }) {
				opts?.signal?.addEventListener("abort", () => {
					aborted = true;
					wake?.();
				});
				return {
					async *[Symbol.asyncIterator]() {
						while (!aborted) {
							if (queue.length === 0) {
								await new Promise<void>((r) => {
									wake = r;
								});
							}
							while (queue.length > 0) yield queue.shift();
						}
					},
				};
			},
		},
		tool: {
			async hook(name: string, fn: (e: any) => unknown) {
				hooks.set(name, fn);
			},
		},
	};
	return {
		ctx,
		push: (event) => {
			queue.push(event);
			wake?.();
		},
		hooks,
		aborted: () => aborted,
	};
}

/** Replays a capture's records, in order, through one plugin instance of the right line. */
export async function replayCapture(line: Line, capture: Capture, plugin: any, directory: string) {
	if (line === "v1") {
		const hooks = await plugin.AgentPulse(v1Ctx(directory));
		for (const r of capture.records) {
			if (r.kind === "event") hooks.event({ event: r.event });
			else if (r.kind === "chat.message") hooks["chat.message"](r.i, r.o);
			else if (r.kind === "tool.execute.before") hooks["tool.execute.before"](r.i, r.o);
			else if (r.kind === "tool.execute.after") hooks["tool.execute.after"](r.i, r.o);
		}
		return { cleanup: undefined as unknown };
	}
	const fake = v2Ctx(directory);
	const cleanup = await plugin.default.setup(fake.ctx);
	for (const r of capture.records) {
		if (r.kind === "event") fake.push(r.event);
		else if (r.kind === "tool.before") fake.hooks.get("execute.before")?.(r.event);
		else if (r.kind === "tool.after") fake.hooks.get("execute.after")?.(r.event);
		await new Promise((res) => setTimeout(res, 0));
	}
	return { cleanup };
}

// ---- a line-agnostic driver ----------------------------------------------------------

export interface Driver {
	line: Line;
	created(sid: string, dir: string, parent?: string): void;
	prompt(sid: string, text: string): void;
	before(sid: string, callID: string, tool: string, args: Record<string, unknown>): unknown;
	/** Fires the after hook, and on 1.x the part-completed event that releases it. */
	after(
		sid: string,
		callID: string,
		tool: string,
		args: Record<string, unknown>,
		output?: string,
	): unknown;
	idle(sid: string, text?: string): void;
	event(ev: unknown): void;
	flush(): Promise<void>;
	cleanup(): void;
	hooks: any;
	fake?: ReturnType<typeof v2Ctx>;
}

let evtCounter = 0;
export const nextEvt = () => `evt_${String(++evtCounter).padStart(10, "0")}`;

export async function makeDriver(line: Line, plugin: any, dir: string): Promise<Driver> {
	if (line === "v1") {
		const hooks = await plugin.AgentPulse(v1Ctx(dir));
		const ev = (e: unknown) => hooks.event({ event: e });
		return {
			line,
			hooks,
			created: (sid, d, parent) =>
				ev({
					id: nextEvt(),
					type: "session.created",
					properties: {
						sessionID: sid,
						info: { id: sid, directory: d, parentID: parent, version: "1.19.5" },
					},
				}),
			prompt: (sid, text) =>
				hooks["chat.message"](
					{ sessionID: sid },
					{
						message: { model: { providerID: "stub", modelID: "m" } },
						parts: [{ type: "text", text }],
					},
				),
			before: (sid, callID, tool, args) =>
				hooks["tool.execute.before"]({ tool, sessionID: sid, callID }, { args }),
			after: (sid, callID, tool, args, output = "ok") => {
				const r = hooks["tool.execute.after"](
					{ tool, sessionID: sid, callID, args },
					{ title: "t", metadata: { exit: 0 }, output },
				);
				ev({
					id: nextEvt(),
					type: "message.part.updated",
					properties: {
						sessionID: sid,
						part: {
							type: "tool",
							tool,
							callID,
							id: `prt_${callID}`,
							state: { status: "completed", input: args },
						},
					},
				});
				return r;
			},
			idle: (sid, text) => {
				if (text !== undefined) {
					ev({
						id: nextEvt(),
						type: "message.updated",
						properties: {
							sessionID: sid,
							info: { id: `msg_${sid}`, role: "assistant", sessionID: sid },
						},
					});
					ev({
						id: nextEvt(),
						type: "message.part.updated",
						properties: {
							sessionID: sid,
							part: {
								type: "text",
								text,
								id: `prt_t${sid}`,
								messageID: `msg_${sid}`,
								sessionID: sid,
							},
						},
					});
				}
				ev({ id: nextEvt(), type: "session.idle", properties: { sessionID: sid } });
			},
			event: ev,
			flush: async () => {},
			cleanup: () => {},
		};
	}
	const fake = v2Ctx(dir);
	const cleanup = await plugin.default.setup(fake.ctx);
	const tick = () => new Promise((r) => setTimeout(r, 2));
	return {
		line,
		hooks: fake.hooks,
		fake,
		created: (sid, d, parent) =>
			fake.push({
				id: nextEvt(),
				type: "session.created",
				location: { directory: d },
				data: { sessionID: sid, parentID: parent, location: { directory: d }, version: "2.2.6" },
			}),
		prompt: (sid, text) =>
			fake.push({
				id: nextEvt(),
				type: "session.inbox.enqueued",
				location: { directory: dir },
				data: { sessionID: sid, item: { type: "user", payload: { text } } },
			}),
		before: (sid, callID, tool, input) =>
			fake.hooks.get("execute.before")?.({ tool, sessionID: sid, id: callID, input }),
		after: (sid, callID, tool, input, output = "ok") =>
			fake.hooks.get("execute.after")?.({
				tool,
				sessionID: sid,
				id: callID,
				input,
				status: "completed",
				result: { output: { output, exit: 0 }, content: [{ type: "text", text: output }] },
			}),
		idle: (sid, text) => {
			if (text !== undefined)
				fake.push({
					id: nextEvt(),
					type: "session.text.ended",
					location: { directory: dir },
					data: { sessionID: sid, assistantMessageID: `msg_${sid}`, ordinal: 0, text },
				});
			fake.push({ id: nextEvt(), type: "session.execution.succeeded", data: { sessionID: sid } });
		},
		event: (e) => fake.push(e),
		flush: async () => {
			await tick();
			await tick();
		},
		cleanup: () => (cleanup as () => void)?.(),
	};
}

// ---- a collector in another process (a synchronous curl at exit blocks this one) -----------------

const REMOTE_SERVER = `
const fs = require("node:fs");
const [log, hangFile] = process.argv.slice(2);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const raw = await req.text();
  if (fs.existsSync(hangFile)) await new Promise(() => {});
  const headers = {}; req.headers.forEach((v, k) => { headers[k] = v; });
  fs.appendFileSync(log, JSON.stringify({ headers, raw, url: req.url }) + "\\n");
  return Response.json({ ok: true });
}});
console.log(server.port);
`;

export async function startRemoteCollector() {
	const dir = scratchDir("remote");
	const log = join(dir, "log.jsonl");
	const hangFile = join(dir, "hang");
	const script = join(dir, "server.js");
	writeFileSync(script, REMOTE_SERVER);
	writeFileSync(log, "");
	const child = Bun.spawn(["bun", script, log, hangFile], { stdout: "pipe", stderr: "ignore" });
	const reader = child.stdout.getReader();
	const first = await reader.read();
	const port = Number(new TextDecoder().decode(first.value).trim());
	return {
		url: `http://127.0.0.1:${port}`,
		hang(on: boolean) {
			if (on) writeFileSync(hangFile, "");
			else rmSync(hangFile, { force: true });
		},
		read(): Received[] {
			return readFileSync(log, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					const x = JSON.parse(l) as { headers: Record<string, string>; raw: string; url: string };
					let body: any = null;
					try {
						body = JSON.parse(x.raw);
					} catch {}
					return { headers: x.headers, body, raw: x.raw, url: x.url };
				});
		},
		stop: () => child.kill(),
	};
}
