/**
 * AGEN-141: the exit flush. A one-shot "opencode run" exits right after the turn ends and the plugin's chain may
 * not have sent the last items. At exit the plugin sends what is queued with a synchronous curl, within 300 ms,
 * for a directory it already judged "send" in this process. Real curl runs through a logging wrapper, against a
 * collector in another process (a synchronous curl would block one in this process).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { rig } from "./lib/opencode-plugin-common-tests.ts";
import {
	type Line,
	recordOf,
	scratchDir,
	settle,
	startRemoteCollector,
} from "./lib/opencode-plugin-kit.ts";

const SID = "ses_exit00000000000000001";
// Built in two parts so the repo-wide redactor self-scan does not read this file as holding a credential.
const AUTH_PREFIX = ["Authorization: ", "Bearer "].join("");
const remotes: Array<() => unknown> = [];
afterEach(() => {
	while (remotes.length) remotes.pop()?.();
});

function wrapper() {
	const dir = scratchDir("curlwrap");
	const log = join(dir, "log.txt");
	const script = join(dir, "curl");
	writeFileSync(
		script,
		`#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> "${log}"\nprintf -- '--end--\\n' >> "${log}"\nexec /usr/bin/curl "$@"\n`,
	);
	chmodSync(script, 0o755);
	return {
		script,
		args: () =>
			existsSync(log)
				? (readFileSync(log, "utf8") as string).split("--end--\n").filter(Boolean)
				: [],
	};
}

async function setup(line: Line, argv: string[], direct = false) {
	const remote = await startRemoteCollector();
	remotes.push(remote.stop);
	const w = wrapper();
	const r = await rig(line, { url: remote.url, direct, seam: { curl: w.script, argv } as never });
	const flush = () => (r.seam as unknown as { exitFlush: () => void }).exitFlush();
	// One item goes out the normal way so the directory has a "send" verdict in this process.
	r.drv.created(SID, r.dir);
	await r.drv.flush();
	await settle(line);
	return { r, remote, w, flush };
}

/** A terminal event with a fixed id, in the shape each line's host delivers it. */
const idleEvent = (line: Line, id: string) =>
	line === "v1"
		? { id, type: "session.idle", properties: { sessionID: SID } }
		: { id, type: "session.execution.succeeded", data: { sessionID: SID } };

const RUN = ["bun", "/$bunfs/root/opencode", "run", "go"];

for (const line of ["v1", "v2"] as const) {
	describe(`${line} plugin: the exit flush`, () => {
		test("a one-shot run sends what is queued at exit; argv holds no body, no key and no -L", async () => {
			const { r, remote, w, flush } = await setup(line, RUN);
			remote.hang(true);
			for (let i = 0; i < 3; i++)
				r.drv.before(SID, `call_${i}`, "bash", { secret: `BODYTEXT${i}` });
			await new Promise((res) => setTimeout(res, 30));
			remote.hang(false);
			const before = remote.read().length;
			flush();
			const got = remote.read().slice(before);
			expect(
				got.filter((x) => String(x.body?.hook_event_name).endsWith("before")).length,
			).toBeGreaterThanOrEqual(3);
			const all = w.args().join("\n");
			expect(all).not.toContain("BODYTEXT");
			expect(all).not.toContain("ap_");
			expect(all).not.toMatch(/(^|\n)-L(\n|$)/);
			expect(all).toContain("/api/v1/hooks?event=");
			expect(all).toContain("X-Agent-Type: opencode");
			expect(all).toContain("X-AgentPulse-Delivery-Id: ");
		});

		test("a hanging server costs at most 350 ms at exit", async () => {
			const { r, remote, flush } = await setup(line, RUN);
			remote.hang(true);
			for (let i = 0; i < 10; i++) r.drv.before(SID, `call_${i}`, "bash", { a: i });
			await new Promise((res) => setTimeout(res, 30));
			const t = performance.now();
			flush();
			expect(performance.now() - t).toBeLessThan(350);
		});

		test("an event whose POST is still in flight at exit is sent by the flush (claimed is not delivered)", async () => {
			const { r, remote, flush } = await setup(line, RUN);
			remote.hang(true);
			r.drv.idle(SID, "done");
			await new Promise((res) => setTimeout(res, 30));
			remote.hang(false);
			const before = remote.read().length;
			flush();
			const got = remote.read().slice(before);
			expect(got.length).toBeGreaterThanOrEqual(1);
		});

		test("the same event queued twice while its POST hangs goes out once at exit", async () => {
			const { r, remote, flush } = await setup(line, RUN);
			remote.hang(true);
			const idle = idleEvent(line, "evt_dup0000000001");
			r.drv.event(idle);
			r.drv.event(idle);
			await new Promise((res) => setTimeout(res, 30));
			remote.hang(false);
			const before = remote.read().length;
			flush();
			expect(remote.read().length - before).toBe(1);
		});

		test("a delivered event stays claimed: the same event again is dropped, one POST per event id", async () => {
			const { r, remote } = await setup(line, RUN);
			const idle = idleEvent(line, "evt_once0000000001");
			r.drv.event(idle);
			await r.drv.flush();
			await settle(line);
			const before = remote.read().length;
			r.drv.event(idle);
			await r.drv.flush();
			await settle(line);
			expect(remote.read().length).toBe(before);
			expect(recordOf(line).counters.droppedSeen).toBe(1);
		});

		test("a POST that failed releases its claim, so the same event can be sent again", async () => {
			const { r, remote } = await setup(line, RUN);
			remote.stop();
			const idle = idleEvent(line, "evt_fail0000000001");
			r.drv.event(idle);
			await r.drv.flush();
			await settle(line);
			r.drv.event(idle);
			await r.drv.flush();
			await settle(line);
			const c = recordOf(line).counters;
			expect(c.failedPosts).toBe(2);
			expect(c.droppedSeen).toBe(0);
		});

		test("an event the server already answered is not sent again at exit", async () => {
			const { r, remote, flush } = await setup(line, RUN);
			r.drv.idle(SID, "done");
			await r.drv.flush();
			await settle(line);
			const before = remote.read().length;
			flush();
			expect(remote.read().length).toBe(before);
		});

		test("a long-lived serve process flushes nothing at exit", async () => {
			const { r, remote, flush } = await setup(line, ["bun", "x", "serve", "--port", "4096"]);
			remote.hang(true);
			r.drv.before(SID, "call_0", "bash", { a: 1 });
			await new Promise((res) => setTimeout(res, 30));
			remote.hang(false);
			const before = remote.read().length;
			flush();
			expect(remote.read().length).toBe(before);
		});

		test("2.x's private server, serve --stdio, is one-shot", async () => {
			const { r, remote, flush } = await setup(line, [
				"bun",
				"x",
				"serve",
				"--stdio",
				"--port",
				"0",
			]);
			remote.hang(true);
			r.drv.before(SID, "call_0", "bash", { a: 1 });
			await new Promise((res) => setTimeout(res, 30));
			remote.hang(false);
			const before = remote.read().length;
			flush();
			expect(remote.read().length - before).toBeGreaterThanOrEqual(1);
		});

		test("a directory with no verdict yet sends nothing at exit (no gate runs at exit)", async () => {
			const { remote, flush } = await setup(line, RUN);
			recordOf(line).sessions.set("ses_nothing0000000000001", {
				q: [
					{
						body: "{}",
						size: 2,
						dirs: ["/never/judged"],
						key: "k",
						sid: "ses_nothing0000000000001",
						name: "x",
					},
				],
				bytes: 2,
				running: false,
				dead: false,
				calls: new Map(),
				roles: new Map(),
				texts: new Map(),
				perms: new Map(),
			});
			const before = remote.read().length;
			flush();
			expect(remote.read().length).toBe(before);
		});

		describe("M1: the exit flush re-checks the exclude state and the age of a verdict", () => {
			async function queued(argv = RUN) {
				const s = await setup(line, argv);
				s.remote.hang(true);
				s.r.drv.before(SID, "call_late", "bash", { a: 1 });
				await new Promise((res) => setTimeout(res, 30));
				s.remote.hang(false);
				const sentAtExit = () => {
					const before = s.remote.read().length;
					s.flush();
					return s.remote
						.read()
						.slice(before)
						.filter((x) => String(x.body?.hook_event_name).endsWith("before")).length;
				};
				return { ...s, sentAtExit };
			}
			const r_child = (q: {
				r: {
					drv: {
						created: (s: string, d: string, p?: string) => void;
						before: (...a: any[]) => unknown;
						flush: () => Promise<void>;
					};
					dir: string;
				};
			}) => {
				q.r.drv.created("ses_childnoroot000000001", q.r.dir, "ses_rootunknown00000001");
				q.r.drv.before("ses_childnoroot000000001", "call_c", "bash", { a: 1 });
			};
			const agentpulseDir = (home: string) => {
				const d = join(home, ".agentpulse");
				mkdirSync(d, { recursive: true });
				return d;
			};

			test("positive control: with no rules, the queued item is sent at exit", async () => {
				const q = await queued();
				expect(q.sentAtExit()).toBeGreaterThanOrEqual(1);
			});

			test("a rules file created after the verdict stops the flush", async () => {
				const q = await queued();
				writeFileSync(join(agentpulseDir(q.r.home), "exclude"), "/somewhere\n");
				expect(q.sentAtExit()).toBe(0);
			});

			test("an exclude.invalid marker, even a dangling link, stops the flush", async () => {
				const q = await queued();
				symlinkSync("/nonexistent-target", join(agentpulseDir(q.r.home), "exclude.invalid"));
				expect(q.sentAtExit()).toBe(0);
			});

			test("AGENTPULSE_SKIP set after the verdict stops the flush", async () => {
				const q = await queued();
				(q.r.seam.env as Record<string, string>).AGENTPULSE_SKIP = "1";
				expect(q.sentAtExit()).toBe(0);
			});

			test("a verdict older than the gate's time-to-live is not enough", async () => {
				const q = await queued();
				const start = Date.now();
				q.r.seam.now = () => start + 61_000;
				expect(q.sentAtExit()).toBe(0);
			});

			test("an item with no known directory never rides on another item's verdict", async () => {
				const q = await queued();
				const rec = recordOf(line);
				// A child whose root session is unknown is judged by [its own dir, undefined] and is sent (no rules yet).
				r_child(q);
				await settle(line);
				expect([...rec.verdicts.keys()]).not.toContain("undefined");
				expect(rec.counters.posts).toBeGreaterThan(1);
				const sid = "ses_nodir0000000000000001";
				rec.sessions.set(sid, {
					q: [
						{
							body: JSON.stringify({ session_id: sid, hook_event_name: "tool.before" }),
							size: 30,
							dirs: [undefined],
							key: "k",
							sid,
							name: "tool.before",
						},
					],
					bytes: 30,
					running: false,
					dead: false,
					calls: new Map(),
					roles: new Map(),
					texts: new Map(),
					perms: new Map(),
				});
				const before = q.remote.read().length;
				q.flush();
				expect(
					q.remote
						.read()
						.slice(before)
						.filter((x) => x.body?.session_id === sid).length,
				).toBe(0);
			});
		});

		test("direct mode: no key file sends without Authorization, a trusted one passes the file to curl, an untrusted one sends nothing", async () => {
			for (const mode of ["none", "good", "bad", "garbled"] as const) {
				const { r, remote, w, flush } = await setup(line, RUN, true);
				if (mode !== "none") {
					mkdirSync(join(r.home, ".agentpulse"), { recursive: true });
					const file = join(r.home, ".agentpulse", "hook-auth-header");
					writeFileSync(
						file,
						mode === "garbled" ? "not a credential line\n" : `${AUTH_PREFIX}ap_exitkey\n`,
					);
					chmodSync(file, mode === "bad" ? 0o666 : 0o600);
				}
				// The item is still queued: the flush runs before the chain's first microtask.
				const before = remote.read().length;
				r.drv.before(SID, "call_x", "bash", { a: 1 });
				flush();
				const flushed = remote
					.read()
					.slice(before)
					.filter((x) => String(x.body?.hook_event_name).endsWith("before"));
				if (mode === "bad" || mode === "garbled") expect(flushed.length).toBe(0);
				else {
					expect(flushed.length).toBeGreaterThanOrEqual(1);
					expect(flushed[0]?.headers.authorization).toBe(
						mode === "good" ? "Bearer ap_exitkey" : undefined,
					);
				}
				expect(w.args().join("\n")).not.toContain("ap_exitkey");
			}
		});
	});
}
