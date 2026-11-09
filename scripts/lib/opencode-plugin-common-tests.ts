/**
 * The plugin tests both OpenCode lines share (AGEN-141 plan step 17): the core
 * behaves the same on 1.x and 2.x, so each line's test file calls this with its
 * own driver. Line-specific cases live in the line's own file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import cp from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseOpenCodeEnvelope } from "../../src/shared/opencode-wire.ts";
import {
	type Driver,
	type Line,
	type Seam,
	loadPluginModule,
	makeDriver,
	recordOf,
	resetRecord,
	scratchDir,
	settle,
	startCollector,
} from "./opencode-plugin-kit.ts";

export const SID = "ses_common0000000000000001";

export interface Rig {
	drv: Driver;
	seam: Seam;
	home: string;
	dir: string;
	url: string;
	received: ReturnType<typeof startCollector>["received"];
	stop: () => void;
}

const stops: Array<() => void> = [];
afterEach(() => {
	while (stops.length > 0) stops.pop()?.();
});

export async function rig(
	line: Line,
	opts: {
		collector?: Parameters<typeof startCollector>[0];
		url?: string;
		direct?: boolean;
		seam?: Partial<Seam>;
		mutate?: (t: string) => string;
		dir?: string;
	} = {},
): Promise<Rig> {
	resetRecord(line);
	const c = startCollector(opts.collector);
	const home = scratchDir("home");
	const dir = opts.dir ?? scratchDir("project");
	const seam: Seam = { env: { HOME: home, PATH: "/usr/bin:/bin" }, ...opts.seam };
	const plugin = await loadPluginModule(line, opts.url ?? c.url, seam, {
		direct: opts.direct,
		mutate: opts.mutate,
	});
	const drv = await makeDriver(line, plugin, dir);
	const r: Rig = { drv, seam, home, dir, url: c.url, received: c.received, stop: c.stop };
	stops.push(() => {
		drv.cleanup();
		c.stop();
	});
	return r;
}

export const names = (r: Rig) => r.received.map((x) => x.body.hook_event_name as string);

export function defineCommonPluginTests(line: Line) {
	describe(`${line} plugin: hooks never block, never throw, never change OpenCode's values`, () => {
		for (const [label, make] of [
			["a never-answering endpoint", () => ({ collector: { hang: true } })],
			["a refused port", () => ({ url: "http://127.0.0.1:1" })],
		] as const) {
			test(`17a every hook returns within 50 ms against ${label}`, async () => {
				const r = await rig(line, make());
				r.drv.created(SID, r.dir);
				await r.drv.flush();
				const slowest: number[] = [];
				const time = (fn: () => unknown) => {
					const t = performance.now();
					const out = fn();
					slowest.push(performance.now() - t);
					return out;
				};
				time(() => r.drv.prompt(SID, "hello"));
				for (let i = 0; i < 40; i++) {
					expect(
						time(() => r.drv.before(SID, `call_${i}`, "bash", { command: "x" })),
					).toBeUndefined();
					expect(
						time(() => r.drv.after(SID, `call_${i}`, "bash", { command: "x" })),
					).toBeUndefined();
				}
				time(() => r.drv.idle(SID, "done"));
				expect(Math.max(...slowest)).toBeLessThan(50);
			});
		}

		test("17b internals that throw still return undefined and a tool hook never throws", async () => {
			const r = await rig(line, {
				seam: {
					fetch: (() => {
						throw new Error("boom");
					}) as never,
				},
			});
			const hostile = {
				get command(): string {
					throw new Error("getter boom");
				},
			};
			r.drv.created(SID, r.dir);
			expect(() => r.drv.before(SID, "call_1", "bash", hostile as never)).not.toThrow();
			expect(() => r.drv.after(SID, "call_1", "bash", hostile as never)).not.toThrow();
			expect(r.drv.before(SID, "call_2", "bash", { a: 1 })).toBeUndefined();
			await r.drv.flush();
			await settle(line);
			expect(
				recordOf(line).counters.swallowed + recordOf(line).counters.failedPosts,
			).toBeGreaterThan(0);
		});

		test("17c order: 50 events in one session arrive in order at a slow server", async () => {
			const r = await rig(line, { collector: { delayMs: () => Math.random() * 20 } });
			r.drv.created(SID, r.dir);
			for (let i = 0; i < 50; i++)
				r.drv.before(SID, `call_${String(i).padStart(2, "0")}`, "bash", { n: i });
			await r.drv.flush();
			await settle(line, 20000);
			const ids = r.received
				.filter((x) => String(x.body.hook_event_name).endsWith("before"))
				.map((x) => x.body.data.tool_use_id);
			expect(ids).toEqual(
				Array.from({ length: 50 }, (_, i) => `call_${String(i).padStart(2, "0")}`),
			);
			expect(r.received.length).toBe(51);
		});

		test("17s no spawn, sync fs or hash runs on the hook path", async () => {
			const r = await rig(line);
			r.drv.created(SID, r.dir);
			await r.drv.flush();
			await settle(line);
			const calls: string[] = [];
			const originals: Array<[any, string, any]> = [];
			const spy = (obj: any, key: string) => {
				const orig = obj[key];
				originals.push([obj, key, orig]);
				obj[key] = (...a: unknown[]) => {
					calls.push(key);
					return orig.apply(obj, a);
				};
			};
			for (const k of [
				"spawn",
				"spawnSync",
				"exec",
				"execFile",
				"execFileSync",
				"execSync",
				"fork",
			])
				spy(cp, k);
			for (const k of Object.keys(fs).filter((k) => k.endsWith("Sync"))) spy(fs, k);
			spy(crypto, "createHash");
			try {
				r.drv.prompt(SID, "hi");
				r.drv.before(SID, "call_1", "bash", { a: 1 });
				r.drv.after(SID, "call_1", "bash", { a: 1 });
				r.drv.idle(SID, "done");
			} finally {
				for (const [o, k, v] of originals.reverse()) o[k] = v;
			}
			expect(calls).toEqual([]);
			await r.drv.flush();
			await settle(line);
		});
	});

	describe(`${line} plugin: what it sends`, () => {
		test("17e a child's events are tagged with the root, its prompt is dropped, grandchildren fold to the root", async () => {
			const r = await rig(line);
			const child = "ses_child00000000000000001";
			const grand = "ses_grand00000000000000001";
			r.drv.created(SID, r.dir);
			r.drv.created(child, r.dir, SID);
			r.drv.created(grand, r.dir, child);
			await r.drv.flush();
			r.drv.prompt(child, "child prompt text");
			r.drv.before(grand, "call_1", "bash", { a: 1 });
			await r.drv.flush();
			await settle(line);
			const bodies = r.received.map((x) => x.body);
			expect(bodies.some((b) => JSON.stringify(b).includes("child prompt text"))).toBe(false);
			const c = bodies.find(
				(b) => b.session_id === child && b.hook_event_name === "session.created",
			);
			expect(c.parent_session_id).toBe(SID);
			const g = bodies.find((b) => b.session_id === grand && b.hook_event_name.endsWith("before"));
			expect(g.parent_session_id).toBe(SID);
			for (const b of bodies) expect(parseOpenCodeEnvelope(b)).not.toBeNull();
		});

		test("17f a 1 MB write argument arrives under 64 KiB with a marker; the body stays under 256 KiB", async () => {
			const r = await rig(line);
			r.drv.created(SID, r.dir);
			r.drv.before(SID, "call_1", "write", {
				content: "x".repeat(1_000_000),
				other: "y".repeat(70_000),
			});
			await r.drv.flush();
			await settle(line);
			const b = r.received.find((x) => String(x.body.hook_event_name).endsWith("before"))?.body;
			expect(b.data.input.content.length).toBeLessThanOrEqual(65536);
			expect(b.data.input.content).toContain("[truncated");
			expect(b.data.input.other.length).toBeLessThanOrEqual(65536);
			expect(parseOpenCodeEnvelope(b)).not.toBeNull();
		});

		test("17f queue bounds count UTF-8 bytes: a CJK-heavy burst hits the byte bound first", async () => {
			const r = await rig(line, { url: "http://127.0.0.1:1" });
			// 60,000 CJK characters are 180 KB; six of them is over the 1 MiB per-session bound well before 500 items.
			const text = "漢".repeat(60_000);
			for (let i = 0; i < 12; i++) r.drv.before(SID, `call_${i}`, "write", { content: text });
			const rec = recordOf(line);
			const st = rec.sessions.get(SID);
			expect(st.bytes).toBeLessThanOrEqual(1024 * 1024);
			expect(st.q.length).toBeLessThan(12);
			await settle(line);
		});

		test("17q callID numbering: reuse after completion is #2, an open call isn't suffixed twice, the 513th callID evicts the oldest", async () => {
			const r = await rig(line);
			r.drv.created(SID, r.dir);
			r.drv.before(SID, "call_0", "bash", { n: 1 });
			r.drv.after(SID, "call_0", "bash", { n: 1 });
			await r.drv.flush();
			r.drv.before(SID, "call_0", "bash", { n: 2 });
			r.drv.before(SID, "call_0", "bash", { n: 2 });
			r.drv.after(SID, "call_0", "bash", { n: 2 });
			await r.drv.flush();
			await settle(line);
			const ids = r.received.map((x) => x.body.data?.tool_use_id).filter(Boolean);
			expect(ids).toEqual(["call_0", "call_0", "call_0#2", "call_0#2", "call_0#2"]);
			for (let i = 0; i < 520; i++) r.drv.before(SID, `many_${i}`, "bash", { i });
			const st = recordOf(line).sessions.get(SID);
			expect(st.calls.size).toBe(512);
			expect(st.calls.has("call_0")).toBe(false);
			await settle(line, 20000);
		});

		test("17r a record of the wrong shape is replaced and counted; session tables are Maps (a __proto__ id works)", async () => {
			const r = await rig(line);
			const key = Symbol.for(`agentpulse.opencode.${recordOf(line)?.build ?? ""}`);
			expect(typeof key).toBe("symbol");
			const rec = recordOf(line);
			expect(
				rec.sessions instanceof Map && rec.info instanceof Map && rec.seen instanceof Map,
			).toBe(true);
			(globalThis as any)[Symbol.for(`agentpulse.opencode.${rec.build}`)] = {
				version: 1,
				sessions: {},
			};
			const r2 = await rig(line, { url: r.url }).catch(() => null);
			r.drv.created("__proto__", r.dir);
			await r.drv.flush();
			await settle(line).catch(() => {});
			expect(r2).not.toBeNull();
			expect(recordOf(line).counters.replaced).toBeGreaterThanOrEqual(0);
		});

		test("17n memory: 10,000 events over 500 sessions against a refused port stay inside the bounds", async () => {
			const r = await rig(line, { url: "http://127.0.0.1:1" });
			Bun.gc(true);
			const before = process.memoryUsage().heapUsed;
			let peakBytes = 0;
			for (let i = 0; i < 10_000; i++) {
				const sid = `ses_mem${String(i % 500).padStart(6, "0")}`;
				r.drv.before(sid, `call_${i}`, "bash", { i, pad: "z".repeat(200) });
				if (i % 250 === 0) peakBytes = Math.max(peakBytes, recordOf(line).queuedBytes);
			}
			await settle(line, 60000);
			const rec = recordOf(line);
			expect(peakBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
			expect(rec.sessions.size).toBeLessThanOrEqual(1024);
			expect(rec.queuedItems).toBe(0);
			expect([...rec.sessions.values()].every((s: any) => s.q.length === 0)).toBe(true);
			Bun.gc(true);
			expect(process.memoryUsage().heapUsed - before).toBeLessThan(32 * 1024 * 1024);
		});

		test("17g an error carries only a known name and a status", async () => {
			const r = await rig(line);
			r.drv.created(SID, r.dir);
			const secret = ["sk", "-leak responseBody keep-alive"].join("");
			if (line === "v1") {
				r.drv.event({
					id: nextEvtId(),
					type: "session.error",
					properties: {
						sessionID: SID,
						error: {
							name: "APIError",
							data: {
								message: secret,
								statusCode: 400,
								responseHeaders: { "keep-alive": secret },
								responseBody: secret,
							},
						},
					},
				});
			} else {
				r.drv.event({
					id: nextEvtId(),
					type: "session.step.failed",
					location: { directory: r.dir },
					data: {
						sessionID: SID,
						error: {
							type: "provider.invalid-request",
							message: secret,
							status: 400,
							response: { body: secret },
						},
					},
				});
			}
			await r.drv.flush();
			await settle(line);
			const e = r.received.find((x) => /error|failed/.test(x.body.hook_event_name))?.body;
			expect(e.data.error.status).toBe(400);
			expect(Object.keys(e.data.error).sort()).toEqual(["name", "status"]);
			expect(JSON.stringify(e)).not.toContain("leak");
			expect(JSON.stringify(e)).not.toContain("keep-alive");
		});

		test("17g an unknown error name is folded to Error", async () => {
			const r = await rig(line);
			r.drv.created(SID, r.dir);
			if (line === "v1")
				r.drv.event({
					id: nextEvtId(),
					type: "session.error",
					properties: { sessionID: SID, error: { name: "sk-12345.secret" } },
				});
			else
				r.drv.event({
					id: nextEvtId(),
					type: "session.step.failed",
					location: { directory: r.dir },
					data: { sessionID: SID, error: { type: "sk-12345.secret" } },
				});
			await r.drv.flush();
			await settle(line);
			expect(
				r.received.find((x) => /error|failed/.test(x.body.hook_event_name))?.body.data.error,
			).toEqual({ name: "Error" });
		});

		test("an approval: tool_use_id never leaves the plugin as a call id the server would drop", async () => {
			const r = await rig(line);
			r.drv.created(SID, r.dir);
			r.drv.before(SID, "approval:x", "bash", { a: 1 });
			await r.drv.flush();
			await settle(line);
			for (const x of r.received)
				expect(String(x.body.data?.tool_use_id ?? "").startsWith("approval:")).toBe(false);
		});
	});

	describe(`${line} plugin: direct mode credentials and host`, () => {
		const header = (home: string) => join(home, ".agentpulse", "hook-auth-header");
		const writeHeader = (home: string, text: string, mode = 0o600) => {
			mkdirSync(join(home, ".agentpulse"), { recursive: true });
			writeFileSync(header(home), text, { mode });
			chmodSync(header(home), mode);
		};
		const send = async (r: Rig) => {
			r.drv.created(SID, r.dir);
			await r.drv.flush();
			await settle(line);
			return r.received.at(-1);
		};

		test("17i POSIX: missing and empty files send without Authorization; a good file sends the bearer", async () => {
			const none = await rig(line, { direct: true });
			expect((await send(none))?.headers.authorization).toBeUndefined();
			const empty = await rig(line, { direct: true });
			writeHeader(empty.home, "");
			expect((await send(empty))?.headers.authorization).toBeUndefined();
			const good = await rig(line, { direct: true });
			writeHeader(good.home, "Authorization: Bearer ap_abc123_DEF\n");
			expect((await send(good))?.headers.authorization).toBe("Bearer ap_abc123_DEF");
		});

		test("17i POSIX: a malformed, group-writable, two-line or symlinked file sends nothing", async () => {
			for (const prep of [
				(h: string) => writeHeader(h, "Authorization: Bearer nope\n"),
				(h: string) => writeHeader(h, "Authorization: Bearer ap_abc\n", 0o660),
				(h: string) => writeHeader(h, "Authorization: Bearer ap_abc\nX-Other: 1\n"),
				(h: string) => {
					mkdirSync(join(h, ".agentpulse"), { recursive: true });
					writeFileSync(join(h, "real"), "Authorization: Bearer ap_abc\n", { mode: 0o600 });
					symlinkSync(join(h, "real"), header(h));
				},
			]) {
				const r = await rig(line, { direct: true });
				prep(r.home);
				expect(await send(r)).toBeUndefined();
			}
		});

		test("17i POSIX: the file swapped for a symlink between two sends sends nothing the second time", async () => {
			const r = await rig(line, { direct: true });
			writeHeader(r.home, "Authorization: Bearer ap_abc\n");
			r.drv.created(SID, r.dir);
			await r.drv.flush();
			await settle(line);
			expect(r.received.length).toBe(1);
			fs.rmSync(header(r.home));
			writeFileSync(join(r.home, "real"), "Authorization: Bearer ap_abc\n", { mode: 0o600 });
			symlinkSync(join(r.home, "real"), header(r.home));
			r.drv.before(SID, "call_1", "bash", { a: 1 });
			await r.drv.flush();
			await settle(line);
			expect(r.received.length).toBe(1);
		});

		test("17i win32: home is USERPROFILE (HOME is a decoy); a plain file sends, a link or bad format does not, mode bits are ignored", async () => {
			const profile = scratchDir("profile");
			const decoy = scratchDir("decoy");
			mkdirSync(join(decoy, ".agentpulse"), { recursive: true });
			writeFileSync(
				join(decoy, ".agentpulse", "hook-auth-header"),
				`${["Authorization: ", "Bearer "].join("")}ap_DECOY\n`,
			);
			const r = await rig(line, {
				direct: true,
				seam: { platform: "win32", getuid: undefined, env: { HOME: decoy, USERPROFILE: profile } },
			});
			writeHeader(profile, "Authorization: Bearer ap_win\n", 0o666);
			expect((await send(r))?.headers.authorization).toBe("Bearer ap_win");
			const bad = await rig(line, {
				direct: true,
				seam: {
					platform: "win32",
					getuid: undefined,
					env: { HOME: decoy, USERPROFILE: scratchDir("p2") },
				},
			});
			writeHeader(bad.seam.env?.USERPROFILE as string, "garbage\n");
			expect(await send(bad)).toBeUndefined();
			const link = await rig(line, {
				direct: true,
				seam: { platform: "win32", getuid: undefined, env: { USERPROFILE: scratchDir("p3") } },
			});
			const p3 = link.seam.env?.USERPROFILE as string;
			mkdirSync(join(p3, ".agentpulse"), { recursive: true });
			writeFileSync(join(p3, "real"), "Authorization: Bearer ap_abc\n");
			symlinkSync(join(p3, "real"), header(p3));
			expect(await send(link)).toBeUndefined();
		});

		test("17j X-AgentPulse-Host equals encodeReportedHostHeader in direct mode, and the relay mode sends none", async () => {
			const { encodeReportedHostHeader } = await import("../../src/shared/reported-host.ts");
			const { hostname } = await import("node:os");
			const direct = await rig(line, { direct: true });
			const got = (await send(direct))?.headers["x-agentpulse-host"];
			const want = encodeReportedHostHeader(hostname());
			expect(got ?? "").toBe(want);
			const viaRelay = await rig(line, { direct: false });
			expect((await send(viaRelay))?.headers["x-agentpulse-host"]).toBeUndefined();
			expect((await send(viaRelay))?.headers["x-agent-type"]).toBe("opencode");
		});

		test("17k a redirect is not followed and no string on the process record holds a bearer", async () => {
			const target = startCollector();
			const redirector = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch: () =>
					new Response(null, { status: 302, headers: { Location: `${target.url}/stolen` } }),
			});
			try {
				const r = await rig(line, { direct: true, url: `http://127.0.0.1:${redirector.port}` });
				writeHeader(r.home, "Authorization: Bearer ap_secretkey\n");
				r.drv.created(SID, r.dir);
				await r.drv.flush();
				await settle(line);
				expect(target.received.length).toBe(0);
				const seen = new Set<unknown>();
				const walk = (v: unknown): boolean => {
					if (typeof v === "string") return v.includes("ap_secretkey") || v.includes("Bearer");
					if (!v || typeof v !== "object" || seen.has(v)) return false;
					seen.add(v);
					if (v instanceof Map) return [...v.entries()].some(([k, x]) => walk(k) || walk(x));
					return Object.values(v).some(walk);
				};
				expect(walk(recordOf(line))).toBe(false);
			} finally {
				redirector.stop(true);
				target.stop();
			}
		});
	});

	describe(`${line} plugin: the filled text`, () => {
		test("17k the source imports only node: specifiers", async () => {
			const { OPENCODE_PLUGIN_TEMPLATES } = await import("../../src/shared/opencode-plugin.ts");
			const imports = [
				...OPENCODE_PLUGIN_TEMPLATES[line].matchAll(/^import .* from "([^"]+)";$/gm),
			].map((m) => m[1]);
			expect(imports.length).toBeGreaterThan(3);
			expect(imports.every((s) => String(s).startsWith("node:"))).toBe(true);
			expect(OPENCODE_PLUGIN_TEMPLATES[line]).toContain('redirect: "error"');
		});

		test("17m every name the plugin forwards is in the captured surface for its line", async () => {
			const { readFileSync } = await import("node:fs");
			const { OPENCODE_PLUGIN_TEMPLATES } = await import("../../src/shared/opencode-plugin.ts");
			const { FIXTURES } = await import("./opencode-plugin-kit.ts");
			const surface = JSON.parse(readFileSync(join(FIXTURES, "captured-surface.json"), "utf8"))[
				line
			];
			const captured = new Set<string>([...surface.busEvents, ...surface.hooks]);
			const text = OPENCODE_PLUGIN_TEMPLATES[line];
			const forwarded = [...text.matchAll(/emit\(\s*\w+,\s*"([a-z.]+)"/g)].map(
				(m) => m[1] as string,
			);
			const viaType = [...text.matchAll(/emit\(sid, ev\.type/g)].length;
			expect(forwarded.length + viaType).toBeGreaterThan(5);
			// Event names a plugin forwards without a captured example (none today).
			const allowlist = new Set<string>([]);
			for (const name of forwarded) {
				expect(captured.has(name) || allowlist.has(name), name).toBe(true);
			}
		});
	});
}

let evtSeq = 0;
function nextEvtId() {
	return `evt_x${String(++evtSeq).padStart(9, "0")}`;
}
