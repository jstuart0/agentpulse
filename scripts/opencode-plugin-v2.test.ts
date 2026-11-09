/** AGEN-141 plan step 17 for OpenCode 2.x: the shared cases, the reduced ctx, and the fan-out of a shared service. */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBashExcludeScript } from "../src/shared/hook-command.ts";
import { SID, defineCommonPluginTests, names, rig } from "./lib/opencode-plugin-common-tests.ts";
import {
	loadPluginModule,
	nextEvt,
	recordOf,
	resetRecord,
	scratchDir,
	settle,
	startCollector,
	v2Ctx,
} from "./lib/opencode-plugin-kit.ts";

defineCommonPluginTests("v2");

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("v2 plugin: only 2.x", () => {
	test("17h under the reduced ctx 1.x gives a 2.x-style file, setup is a no-op", async () => {
		resetRecord("v2");
		const c = startCollector();
		const plugin = await loadPluginModule("v2", c.url, {
			env: { HOME: scratchDir("h"), PATH: "/usr/bin:/bin" },
		});
		const reduced = {
			options: {},
			agent: {},
			aisdk: {},
			catalog: {},
			command: {},
			integration: {},
			plugin: {},
			reference: {},
			skill: {},
		};
		const cleanup = await plugin.default.setup(reduced);
		expect(typeof cleanup).toBe("function");
		expect(cleanup()).toBeUndefined();
		expect(await plugin.default.setup(undefined)).toBeInstanceOf(Function);
		// An event object with no subscribe, and a tool object with a hook: still a no-op that registers nothing.
		const noSubscribe = await plugin.default.setup({
			event: {},
			tool: { hook: () => {} },
			location: { directory: "/x" },
		});
		expect(noSubscribe()).toBeUndefined();
		expect(recordOf("v2")).toBeUndefined();
		c.stop();
	});

	test("an abort is session.step.failed(aborted) then session.execution.interrupted, both forwarded", async () => {
		const r = await rig("v2");
		r.drv.created(SID, r.dir);
		r.drv.event({
			id: nextEvt(),
			type: "session.step.failed",
			location: { directory: r.dir },
			data: { sessionID: SID, error: { type: "aborted", message: "Step interrupted" } },
		});
		r.drv.event({
			id: nextEvt(),
			type: "session.execution.interrupted",
			data: { sessionID: SID, reason: "user" },
		});
		await r.drv.flush();
		await settle("v2");
		expect(names(r)).toEqual([
			"session.created",
			"session.step.failed",
			"session.execution.interrupted",
		]);
	});

	test("a failed tool sends status error with the name and no output", async () => {
		const r = await rig("v2");
		r.drv.created(SID, r.dir);
		r.drv.before(SID, "call_1", "read", { path: "/x" });
		r.drv.hooks.get("execute.after")?.({
			tool: "read",
			sessionID: SID,
			id: "call_1",
			input: { path: "/x" },
			status: "error",
			error: { _tag: "Tool.Error", message: "File not found SECRET" },
		});
		await r.drv.flush();
		await settle("v2");
		const a = r.received.find((x) => x.body.hook_event_name === "tool.after")?.body;
		expect(a.data).toEqual({
			tool: "read",
			tool_use_id: "call_1",
			input: { path: "/x" },
			status: "error",
			error: { name: "Tool.Error" },
		});
	});

	test("permission: asked links the call by source.id and reject keeps it", async () => {
		const r = await rig("v2");
		r.drv.created(SID, r.dir);
		r.drv.before(SID, "call_7", "write", { path: "p" });
		r.drv.event({
			id: nextEvt(),
			type: "permission.asked",
			location: { directory: r.dir },
			data: {
				id: "per_1",
				sessionID: SID,
				action: "edit",
				resources: ["p"],
				source: { type: "tool", id: "call_7" },
			},
		});
		r.drv.event({
			id: nextEvt(),
			type: "permission.replied",
			location: { directory: r.dir },
			data: { sessionID: SID, requestID: "per_1", reply: "reject" },
		});
		await r.drv.flush();
		await settle("v2");
		const ids = r.received.map((x) => x.body.data?.tool_use_id).filter(Boolean);
		expect(ids).toEqual(["call_7", "call_7", "call_7"]);
	});

	for (const shared of [true, false]) {
		describe(`17d fan-out: three instances, ${shared ? "one shared globalThis" : "separate realms"}`, () => {
			async function instances(dirs: string[], home: string, url: string, seamExtra = {}) {
				resetRecord("v2");
				const out = [];
				for (const dir of dirs) {
					if (!shared) resetRecord("v2");
					const plugin = await loadPluginModule("v2", url, {
						env: { HOME: home, PATH: "/usr/bin:/bin" },
						...seamExtra,
					});
					const fake = v2Ctx(dir);
					const cleanup = await plugin.default.setup(fake.ctx);
					out.push({ dir, fake, cleanup, rec: recordOf("v2") });
				}
				return out;
			}
			const fanOut = (all: Awaited<ReturnType<typeof instances>>, ev: unknown) => {
				for (const i of all) i.fake.push(ev);
			};
			const drain = async (all: Awaited<ReturnType<typeof instances>>) => {
				await tick();
				await tick();
				for (let n = 0; n < 200; n++) {
					const busy = all.some(
						(i) =>
							i.rec.queuedItems > 0 ||
							i.rec.inflight > 0 ||
							[...i.rec.sessions.values()].some((s: any) => s.running),
					);
					if (!busy) break;
					await new Promise((r) => setTimeout(r, 10));
				}
				await tick();
			};

			test("each event of a claimed session is posted once, in order, and only its claimant runs the tool hooks", async () => {
				const c = startCollector({ delayMs: () => Math.random() * 10 });
				const [a, b, d] = [scratchDir("pa"), scratchDir("pb"), scratchDir("pc")];
				const all = await instances([a, b, d], scratchDir("home"), c.url);
				const sid = "ses_fan0000000000000001";
				fanOut(all, {
					id: nextEvt(),
					type: "session.created",
					location: { directory: b },
					data: { sessionID: sid, location: { directory: b }, version: "2.2.6" },
				});
				await tick();
				fanOut(all, {
					id: nextEvt(),
					type: "session.inbox.enqueued",
					location: { directory: b },
					data: { sessionID: sid, item: { type: "user", payload: { text: "hi" } } },
				});
				await tick();
				// The tool hook runs only on the session's own project's instance (G15).
				all[1]?.fake.hooks.get("execute.before")?.({
					tool: "bash",
					sessionID: sid,
					id: "call_1",
					input: { a: 1 },
				});
				all[0]?.fake.hooks.get("execute.before")?.({
					tool: "bash",
					sessionID: sid,
					id: "call_x",
					input: { a: 1 },
				});
				fanOut(all, {
					id: nextEvt(),
					type: "session.execution.succeeded",
					data: { sessionID: sid },
				});
				await drain(all);
				const seq = c.received.map((x) => `${x.body.hook_event_name}`);
				expect(seq).toEqual([
					"session.created",
					"session.inbox.enqueued",
					"tool.before",
					"session.execution.succeeded",
				]);
				c.stop();
				for (const i of all) i.cleanup();
			});

			test("M2 a session of unknown directory seen by several instances is dropped when rules exist, not sent under a sibling's directory", async () => {
				const c = startCollector();
				const home = scratchDir("home");
				const [a, b] = [scratchDir("pa"), scratchDir("pb")];
				mkdirSync(join(home, ".agentpulse"), { mode: 0o700, recursive: true });
				chmodSync(join(home, ".agentpulse"), 0o700);
				writeFileSync(join(home, ".agentpulse", "exclude"), `${a}\n`, { mode: 0o600 });
				writeFileSync(join(home, ".agentpulse", "exclude-check.sh"), buildBashExcludeScript(), {
					mode: 0o500,
				});
				const all = await instances([a, b], home, c.url);
				const sid = "ses_unknowndir000000001";
				// No session.created seen, no directory on the event: the session is A's, but B's instance cannot know.
				fanOut(all, {
					id: nextEvt(),
					type: "session.inbox.enqueued",
					data: { sessionID: sid, item: { type: "user", payload: { text: "secret from A" } } },
				});
				all[1]?.fake.hooks.get("execute.before")?.({
					tool: "bash",
					sessionID: sid,
					id: "call_u",
					input: { cmd: "secret" },
				});
				await new Promise((r) => setTimeout(r, shared ? 150 : 2400));
				await drain(all);
				expect(c.received.filter((x) => x.body.session_id === sid).length).toBe(0);
				c.stop();
				for (const i of all) i.cleanup();
			});

			test("a child of a session whose creation was never seen is judged by the parent's claimed directory, not dropped as unknown (canary: subagent on 2.x)", async () => {
				const c = startCollector();
				const home = scratchDir("home");
				const [a, other] = [scratchDir("pa"), scratchDir("pother")];
				mkdirSync(join(home, ".agentpulse"), { mode: 0o700, recursive: true });
				chmodSync(join(home, ".agentpulse"), 0o700);
				writeFileSync(join(home, ".agentpulse", "exclude"), `${other}\n`, { mode: 0o600 });
				writeFileSync(join(home, ".agentpulse", "exclude-check.sh"), buildBashExcludeScript(), {
					mode: 0o500,
				});
				const all = await instances([a], home, c.url);
				const parent = "ses_parentunseen0000001";
				const child = "ses_childofunseen0000001";
				const one = all[0];
				one?.fake.push({
					id: nextEvt(),
					type: "session.inbox.enqueued",
					location: { directory: a },
					data: { sessionID: parent, item: { type: "user", payload: { text: "go" } } },
				});
				one?.fake.push({
					id: nextEvt(),
					type: "session.created",
					location: { directory: a },
					data: {
						sessionID: child,
						parentID: parent,
						location: { directory: a },
						version: "2.2.6",
					},
				});
				await new Promise((r) => setTimeout(r, 30));
				one?.fake.hooks.get("execute.before")?.({
					tool: "bash",
					sessionID: child,
					id: "call_child",
					input: { cmd: "ls" },
				});
				await new Promise((r) => setTimeout(r, 400));
				await drain(all);
				const names = c.received.map((x) => `${x.body.hook_event_name}:${x.body.session_id}`);
				expect(names).toContain(`session.created:${child}`);
				expect(names).toContain(`tool.before:${child}`);
				c.stop();
				for (const i of all) i.cleanup();
			});

			test("an unclaimed session (created missed, no directory on the event) is posted once or dropped, never by every instance", async () => {
				const c = startCollector();
				const dirs = [scratchDir("pa"), scratchDir("pb"), scratchDir("pc")];
				const all = await instances(dirs, scratchDir("home"), c.url);
				const sid = "ses_unclaimed0000000001";
				fanOut(all, {
					id: nextEvt(),
					type: "session.execution.succeeded",
					data: { sessionID: sid },
				});
				await new Promise((r) => setTimeout(r, shared ? 100 : 2400));
				await drain(all);
				const n = c.received.filter((x) => x.body.session_id === sid).length;
				if (shared) expect(n).toBe(1);
				else {
					expect(n).toBe(0);
					expect(
						all.reduce((sum, i) => sum + i.rec.counters.droppedClaim, 0),
					).toBeGreaterThanOrEqual(3);
				}
				c.stop();
				for (const i of all) i.cleanup();
			});

			test("excluded A / included B: nothing is sent for A's session, B's is, even when A's tool hook runs on B's instance", async () => {
				const c = startCollector();
				const home = scratchDir("home");
				const [a, b] = [scratchDir("pa"), scratchDir("pb")];
				mkdirSync(join(home, ".agentpulse"), { mode: 0o700, recursive: true });
				chmodSync(join(home, ".agentpulse"), 0o700);
				writeFileSync(join(home, ".agentpulse", "exclude"), `${a}\n`, { mode: 0o600 });
				writeFileSync(join(home, ".agentpulse", "exclude-check.sh"), buildBashExcludeScript(), {
					mode: 0o500,
				});
				const all = await instances([a, b], home, c.url);
				const sa = "ses_exclA000000000000001";
				const sb = "ses_inclB000000000000001";
				fanOut(all, {
					id: nextEvt(),
					type: "session.created",
					location: { directory: a },
					data: { sessionID: sa, location: { directory: a }, version: "2.2.6" },
				});
				fanOut(all, {
					id: nextEvt(),
					type: "session.created",
					location: { directory: b },
					data: { sessionID: sb, location: { directory: b }, version: "2.2.6" },
				});
				await tick();
				all[0]?.fake.hooks.get("execute.before")?.({
					tool: "bash",
					sessionID: sa,
					id: "ca",
					input: {},
				});
				all[1]?.fake.hooks.get("execute.before")?.({
					tool: "bash",
					sessionID: sa,
					id: "cb",
					input: {},
				});
				all[1]?.fake.hooks.get("execute.before")?.({
					tool: "bash",
					sessionID: sb,
					id: "cc",
					input: {},
				});
				await drain(all);
				expect(c.received.filter((x) => x.body.session_id === sa).length).toBe(0);
				expect(
					c.received.filter((x) => x.body.session_id === sb).map((x) => x.body.hook_event_name),
				).toEqual(["session.created", "tool.before"]);
				c.stop();
				for (const i of all) i.cleanup();
			});
		});
	}
});

describe("17d patches: each removal of a fan-out defence makes a scenario fail", () => {
	async function scenario(
		kind: "claimed" | "unclaimed",
		shared: boolean,
		mutate?: (t: string) => string,
	) {
		resetRecord("v2");
		const c = startCollector({ delayMs: () => Math.random() * 8 });
		const dirs = [scratchDir("pa"), scratchDir("pb"), scratchDir("pc")];
		const home = scratchDir("home");
		const all: Array<{ fake: ReturnType<typeof v2Ctx>; rec: any; cleanup: any }> = [];
		for (const dir of dirs) {
			if (!shared) resetRecord("v2");
			const plugin = await loadPluginModule(
				"v2",
				c.url,
				{ env: { HOME: home, PATH: "/usr/bin:/bin" } },
				{ mutate },
			);
			const fake = v2Ctx(dir);
			all.push({ fake, rec: undefined, cleanup: await plugin.default.setup(fake.ctx) });
			all.at(-1)!.rec = recordOf("v2");
		}
		const push = (ev: unknown) => {
			for (const i of all) i.fake.push(ev);
		};
		const b = dirs[1] as string;
		const sid = "ses_patch000000000000001";
		if (kind === "claimed") {
			push({
				id: nextEvt(),
				type: "session.created",
				location: { directory: b },
				data: { sessionID: sid, location: { directory: b } },
			});
			await tick();
			for (let i = 0; i < 12; i++) {
				push({
					id: nextEvt(),
					type: "session.inbox.enqueued",
					location: { directory: b },
					data: { sessionID: sid, item: { type: "user", payload: { text: `p${i}` } } },
				});
				all[1]?.fake.hooks.get("execute.before")?.({
					tool: "bash",
					sessionID: sid,
					id: `c${i}`,
					input: {},
				});
			}
		} else {
			push({ id: nextEvt(), type: "session.execution.succeeded", data: { sessionID: sid } });
		}
		await new Promise((r) => setTimeout(r, 400));
		for (
			let n = 0;
			n < 300 &&
			all.some(
				(i) =>
					i.rec.queuedItems > 0 ||
					i.rec.inflight > 0 ||
					[...i.rec.sessions.values()].some((s: any) => s.running),
			);
			n++
		)
			await new Promise((r) => setTimeout(r, 10));
		const seq = c.received.map(
			(x) => `${x.body.hook_event_name}:${x.body.data?.text ?? x.body.data?.tool_use_id ?? ""}`,
		);
		c.stop();
		for (const i of all) i.cleanup();
		return seq;
	}
	const wantClaimed = [
		"session.created:",
		...Array.from({ length: 12 }, (_, i) => [
			`session.inbox.enqueued:p${i}`,
			`tool.before:c${i}`,
		]).flat(),
	];

	test("positive controls: unmutated, the claimed session is posted once and in order; the unclaimed one once", async () => {
		const got = await scenario("claimed", true);
		// bus events and tool hooks interleave freely; each of the 25 appears exactly once, and each kind in order
		expect([...got].sort()).toEqual([...wantClaimed].sort());
		expect(got.filter((s) => s.startsWith("tool.before")).map((s) => s)).toEqual(
			wantClaimed.filter((s) => s.startsWith("tool.before")),
		);
		expect(await scenario("unclaimed", true)).toEqual(["session.execution.succeeded:"]);
	});

	test("no-claim: with separate realms every instance posts the session", async () => {
		const got = await scenario("claimed", false, (t) =>
			t
				.replace(
					'if (claimant !== undefined) return claimant === myDir ? "yes" : "no";',
					'return "yes";',
				)
				.replace('if (dir !== myDir) return "no";', ""),
		);
		expect(got.filter((s) => s.startsWith("session.created")).length).toBeGreaterThan(1);
	});

	test("no-seen-set: with a shared realm an unclaimed event is posted by every instance", async () => {
		const got = await scenario("unclaimed", true, (t) =>
			t.replace("if (item.evt !== undefined && seenBefore(rec, item.evt)) {", "if (false) {"),
		);
		expect(got.length).toBeGreaterThan(1);
	});

	test("per-instance-queue: a queue that is not shared across calls loses the order", async () => {
		const got = await scenario("claimed", true, (t) =>
			t.replace("let st = rec.sessions.get(root);", "let st;"),
		);
		expect(got.filter((s) => s.startsWith("tool.before")).join(",")).not.toBe(
			wantClaimed.filter((s) => s.startsWith("tool.before")).join(","),
		);
	});
});
