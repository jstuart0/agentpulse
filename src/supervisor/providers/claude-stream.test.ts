/**
 * AGEN-117 P3 item 4: the stream runtime, against a fake `claude` built from the recorded 2.1.318 lines.
 * No real Claude is ever started here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CLAUDE_API_ERROR_MESSAGE,
	CLAUDE_FORK_BUSY_ERROR,
	CLAUDE_FORK_CHANGED_SYNC_ERROR,
	CLAUDE_FORK_CHECK_FAILED_ERROR,
	CLAUDE_FORK_FIRST_PROMPT_FAILED_ERROR,
	CLAUDE_FORK_PEER_SYNC_ERROR,
	CLAUDE_FORK_SLASH_MESSAGE,
	CLAUDE_FORK_TERMINAL_FOUND_ERROR,
	CLAUDE_LOGIN_LOST_ERROR,
} from "../../shared/managed-messages.js";
import type { ProcessTable } from "../process-stop.js";
import {
	AWAIT,
	FAST_TIMINGS,
	FORK_ID,
	HELPER_ACCOUNT,
	type Harness,
	INIT,
	KEY_ACCOUNT,
	NO_LOGIN_ACCOUNT,
	SOURCE_ID,
	assistantToolUse,
	canUseTool,
	createHarness,
	recordingPort,
	resultOk,
	toolResult,
	until,
	writeTranscript,
} from "../test-utils/claude-stream-harness.js";
import { outLines, readClaudeFixture, readClaudeJson } from "./__fixtures__/claude-frames.js";
import type { FakeConfig } from "./__fixtures__/fake-claude-stream.js";
import { listClaudeAgentEntries, parseAgentEntries } from "./claude-agents.js";
import {
	CLAUDE_LOCAL_DECLINE_TEXT,
	ClaudePromptRefusal,
	ClaudePromptWithheld,
	ClaudeStartRefusal,
	MAX_CLAUDE_STREAM_RUNTIMES,
	PEER_TURN_TEXT_CAP,
	_resetClaudeStreamForTest,
	claudeStreamRuntimeCount,
	disposeAllClaudeStreamRuntimes,
	hasClaudeStreamRuntime,
	promptClaudeStreamSession,
	readPeerTurnText,
	startClaudeStream,
	stopClaudeStreamSession,
} from "./claude-stream.js";
import { allowResponse, denyResponse } from "./claude-wire.js";

const harnesses: Harness[] = [];
function harness(config?: Parameters<typeof createHarness>[0]) {
	const h = createHarness(config);
	harnesses.push(h);
	return h;
}

afterEach(async () => {
	await disposeAllClaudeStreamRuntimes({
		interruptMs: 0,
		stdinCloseMs: 300,
		termMs: 300,
		killMs: 300,
	});
	_resetClaudeStreamForTest();
	for (const h of harnesses.splice(0)) {
		// A test that provokes a refusal on purpose clears it itself; every other suite asserts none happened.
		expect(h.guard.refused).toEqual([]);
		h.assertCleanWire();
		h.cleanup();
	}
});

const alive = (pid: number | null) => {
	// A null pid would make every "is it dead" check pass for a child that never started: refuse to answer.
	if (pid === null)
		throw new Error("the fake never recorded a pid, so nothing can be said about it");
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function prompt(
	h: Harness,
	rt: Awaited<ReturnType<Harness["start"]>>,
	text = "hello",
	id = "action-1",
) {
	rt.beginSettle();
	rt.settled();
	return await rt.sendPrompt(text, id);
}

describe("starting a fork", () => {
	test("a fork with the key login in ask mode starts: registered, no user line, no events", async () => {
		const h = harness();
		const rt = await h.start();
		expect(rt.state).toBe("starting");
		expect(hasClaudeStreamRuntime(FORK_ID)).toBe(true);
		expect(h.fake.userLines()).toBe(0);
		expect(h.fake.controlSubtypes()).toEqual(["initialize"]);
		expect(h.events).toEqual([]);
		expect(h.states).toEqual([]);
		const argv = h.fake.starts()[0]?.argv ?? [];
		expect(argv).toContain("--fork-session");
	});

	test("the child's environment loses the session markers and keeps the login variable", async () => {
		const h = harness();
		const rt = await h.start({
			env: {
				PATH: process.env.PATH,
				CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x.sock",
				CLAUDE_CODE_OAUTH_TOKEN: "label-only",
				AGENTPULSE_KEY: "nope",
				AGENTPULSE_SKIP: "0",
				...h.fake.env,
			},
		});
		const keys = (h.fake.starts()[0] as unknown as { envKeys: string[] }).envKeys;
		expect(keys).toContain("CLAUDE_CODE_OAUTH_TOKEN");
		expect(keys).not.toContain("CLAUDE_CODE_MESSAGING_SOCKET");
		expect(keys).not.toContain("AGENTPULSE_KEY");
		// Ours, after the strip: the person's own value (here "0") never decides whether the child's hooks report.
		expect(h.fake.starts()[0]).toMatchObject({ skip: "1" });
		await rt.dispose();
	});

	test("the account must agree with the mode, in both directions, before any user line", async () => {
		// restricted picked by the probes, but the fork's login is a helper
		const a = harness({ account: HELPER_ACCOUNT });
		await expect(a.start({ mode: "restricted" })).rejects.toMatchObject({
			kind: "claude_not_logged_in",
		});
		expect(a.fake.userLines()).toBe(0);
		expect(alive(a.fake.pid())).toBe(false);
		// ask picked, but the fork now shows no login
		const b = harness({ account: NO_LOGIN_ACCOUNT });
		await expect(b.start({ mode: "ask" })).rejects.toMatchObject({ kind: "claude_not_logged_in" });
		expect(b.fake.userLines()).toBe(0);
		expect(alive(b.fake.pid())).toBe(false);
		expect(claudeStreamRuntimeCount()).toBe(0);
	});

	test("under ask, an absent account passes", async () => {
		const h = harness({ account: undefined });
		const rt = await h.start({ mode: "ask" });
		expect(rt.state).toBe("starting");
	});

	test("own-id check: an entry showing the source kills the fork before any line is sent", async () => {
		const h = harness();
		await expect(
			h.start({
				listAgents: async () => ({
					ok: true,
					entries: [{ pid: h.fake.pid(), sessionId: SOURCE_ID }],
				}),
			}),
		).rejects.toMatchObject({ kind: "rejected" });
		expect(h.fake.userLines()).toBe(0);
		expect(alive(h.fake.pid())).toBe(false);
		expect(hasClaudeStreamRuntime(FORK_ID)).toBe(false);
	});

	test("own-id check: no entry for the child within the wait kills it", async () => {
		const h = harness();
		await expect(
			h.start({ ownIdWaitMs: 300, listAgents: async () => ({ ok: true, entries: [] }) }),
		).rejects.toMatchObject({ kind: "rejected" });
		expect(h.fake.userLines()).toBe(0);
		expect(alive(h.fake.pid())).toBe(false);
	});

	test("own-id check: agents --json failing fails closed as liveness_unknown", async () => {
		const h = harness();
		await expect(
			h.start({ ownIdWaitMs: 300, listAgents: async () => ({ ok: false, why: "it exited 3" }) }),
		).rejects.toMatchObject({ kind: "liveness_unknown" });
		expect(alive(h.fake.pid())).toBe(false);
	});

	test("a source transcript that changed during the preflight kills the fork: source_changed", async () => {
		const h = harness();
		const source = join(h.root, "source.jsonl");
		writeFileSync(source, "one\n");
		await expect(
			h.start({
				sourceFile: source,
				listAgents: async () => {
					writeFileSync(source, "one\ntwo\n");
					return { ok: true, entries: [{ pid: h.fake.pid(), sessionId: FORK_ID }] };
				},
			}),
		).rejects.toMatchObject({ kind: "source_changed" });
		expect(h.fake.userLines()).toBe(0);
		expect(alive(h.fake.pid())).toBe(false);
	});

	test("a source that changes after the preflight, before the first prompt, is logged and the turn proceeds", async () => {
		const h = harness();
		const source = join(h.root, "source.jsonl");
		writeFileSync(source, "one\n");
		const rt = await h.start({ sourceFile: source });
		writeFileSync(source, "one\ntwo\n");
		const sent = await prompt(h, rt);
		expect((await sent.done).ok).toBe(true);
		expect(h.logs.some((l) => l.includes("source transcript changed"))).toBe(true);
	});

	test("a ninth concurrent fork is refused host_busy, and a failed start returns its slot", async () => {
		expect(MAX_CLAUDE_STREAM_RUNTIMES).toBe(8);
		const h = harness();
		const starts: Promise<unknown>[] = [];
		const ids = Array.from(
			{ length: 9 },
			(_, i) => `33333333-3333-4333-8333-${String(i).padStart(12, "0")}`,
		);
		for (const id of ids) {
			starts.push(
				startClaudeStream(
					h.options({
						sessionId: id,
						args: ["--version"],
						maxRuntimes: 8,
						listAgents: async () => ({ ok: true, entries: [] }),
						ownIdWaitMs: 100,
					}),
				).catch((e) => e),
			);
		}
		const results = await Promise.all(starts);
		// Admission is atomic: whichever of the nine came last was refused for the cap, the rest failed their own start.
		expect(
			results.filter((r) => r instanceof ClaudeStartRefusal && r.kind === "host_busy"),
		).toHaveLength(1);
		expect(claudeStreamRuntimeCount()).toBe(0);
		// The slots are free again.
		const rt = await h.start();
		expect(rt.state).toBe("starting");
	});

	test("stop() twice, at once and after the process is gone, is one ladder and one answer (P7-X4, X8)", async () => {
		const h = harness();
		const rt = await h.start();
		rt.beginSettle();
		const first = rt.proc.stop({
			timings: { interruptMs: 0, stdinCloseMs: 400, termMs: 400, killMs: 400 },
		});
		const second = rt.proc.stop();
		expect(second).toBe(first);
		expect((await first).gone).toBe(true);
		expect(rt.proc.stop()).toBe(first);
		expect(rt.proc.hasExited()).toBe(true);
	});

	test("the same session id can't be started twice", async () => {
		const h = harness();
		await h.start();
		await expect(startClaudeStream(h.options())).rejects.toMatchObject({ kind: "rejected" });
	});
});

describe("first-prompt assertions", () => {
	const cases: Array<
		[string, Record<string, unknown>, string[] | undefined, "ask" | "restricted"]
	> = [
		[
			"a permission mode other than default",
			{ permissionMode: "bypassPermissions" },
			undefined,
			"ask",
		],
		[
			"another session id",
			{ session_id: "99999999-9999-4999-8999-999999999999" },
			undefined,
			"ask",
		],
		["another version", { claude_code_version: "2.1.999" }, undefined, "ask"],
		[
			"a tool set that isn't the six",
			{ tools: ["Bash", "Read", "Write", "Edit", "NotebookEdit", "WebFetch", "Agent"] },
			undefined,
			"ask",
		],
		["an MCP server", { mcp_servers: [{ name: "x", status: "connected" }] }, undefined, "ask"],
		["slash commands", { slash_commands: ["model"] }, undefined, "ask"],
		["a missing capability", { capabilities: ["msg_lifecycle_v1"] }, undefined, "ask"],
		[
			"restricted with a messaging socket",
			{ messaging_socket_path: "/tmp/x.sock" },
			undefined,
			"restricted",
		],
		["restricted with memory paths", { memory_paths: { auto: "/x/" } }, undefined, "restricted"],
	];
	for (const [name, init, , mode] of cases) {
		test(`${name} kills the child, fails the prompt and reports the session failed`, async () => {
			const h = harness({ init, account: KEY_ACCOUNT });
			const rt = await h.start({ mode });
			const sent = await prompt(h, rt);
			const outcome = await sent.done;
			expect(outcome).toMatchObject({
				ok: false,
				code: "first_prompt_failed",
				error: CLAUDE_FORK_FIRST_PROMPT_FAILED_ERROR,
			});
			await rt.closed;
			expect(alive(h.fake.pid())).toBe(false);
			expect(h.states.at(-1)).toMatchObject({ managedState: "failed", status: "failed" });
			expect(h.states.some((s) => s.managedState === "degraded")).toBe(false);
		});
	}

	test("the recorded restricted init (no socket, no memory paths) passes under restricted, and the plain one passes under ask", async () => {
		const restricted = outLines("key-fork-restricted-write-deny").find(
			(m) => m.subtype === "init",
		) as Record<string, unknown>;
		const h = harness({
			init: { ...restricted, session_id: FORK_ID },
			initOmit: ["session_id_override"],
		});
		const rt = await h.start({ mode: "restricted" });
		const outcome = await (await prompt(h, rt)).done;
		expect(outcome.ok).toBe(true);
	});

	test("a first prompt that passes lets later turns go on, each with its same-id init", async () => {
		const h = harness();
		const rt = await h.start();
		expect((await (await prompt(h, rt, "one", "a1")).done).ok).toBe(true);
		expect((await (await rt.sendPrompt("two", "a2")).done).ok).toBe(true);
		expect(h.fake.userLines()).toBe(2);
		expect(rt.state).toBe("live");
	});
});

describe("turns", () => {
	test("a prompt is recorded before it is sent, with the marker; the turn ends with a marked completion and an idle report", async () => {
		const h = harness();
		const rt = await h.start();
		const sent = await prompt(h, rt, "do the thing");
		expect(sent.metadata).toMatchObject({ mode: "claude_stream", forkMode: "ask" });
		const outcome = await sent.done;
		expect(outcome).toEqual({ ok: true });
		const types = h.events.map((e) => e.eventType);
		expect(types[0]).toBe("HeadlessPromptSubmitted");
		expect(types).toContain("HeadlessAssistantMessage");
		expect(types.at(-1)).toBe("HeadlessPromptCompleted");
		for (const e of h.events.filter((e) => e.eventType.startsWith("HeadlessPrompt"))) {
			expect(e.rawPayload).toMatchObject({ claudeStreamRuntime: true });
		}
		expect(h.states.at(-1)).toMatchObject({ managedState: "managed", status: "idle" });
		expect(h.states.some((s) => s.status === "completed")).toBe(false);
	});

	test("the user line carries a uuid the host stamped and the lifecycle lines come back with it", async () => {
		const h = harness();
		const rt = await h.start();
		const sent = await prompt(h, rt);
		await sent.done;
		const user = h.fake.log().find((e) => e.ev === "user");
		expect(user?.uuid).toBe((sent.metadata as { turnUuid: string }).turnUuid);
	});

	test("a second prompt while a turn runs is refused busy with the fixed words, and sends nothing", async () => {
		const h = harness({ defaultTurn: [{ delay: 400 }, INIT, resultOk] });
		const rt = await h.start();
		const first = await prompt(h, rt, "one");
		await expect(rt.sendPrompt("two", "a2")).rejects.toMatchObject({
			kind: "busy",
			message: CLAUDE_FORK_BUSY_ERROR,
		});
		await first.done;
		expect(h.fake.userLines()).toBe(1);
	});

	test("two prompts in the same tick: one is sent, one refused", async () => {
		const h = harness({ defaultTurn: [{ delay: 300 }, INIT, resultOk] });
		const rt = await h.start();
		rt.beginSettle();
		rt.settled();
		const results = await Promise.allSettled([rt.sendPrompt("a", "a1"), rt.sendPrompt("b", "a2")]);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
		expect(rejected.reason).toBeInstanceOf(ClaudePromptRefusal);
		await (
			results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
				done: Promise<unknown>;
			}>
		).value.done;
		expect(h.fake.userLines()).toBe(1);
	});

	test("a prompt starting with / is refused with the fixed words; ! and # lines pass", async () => {
		const h = harness();
		const rt = await h.start();
		rt.beginSettle();
		rt.settled();
		await expect(rt.sendPrompt("/model opus", "a1")).rejects.toMatchObject({
			kind: "slash",
			message: CLAUDE_FORK_SLASH_MESSAGE,
		});
		await expect(rt.sendPrompt("   /clear", "a2")).rejects.toMatchObject({ kind: "slash" });
		expect(h.fake.userLines()).toBe(0);
		expect((await (await rt.sendPrompt("!x", "a3")).done).ok).toBe(true);
		expect((await (await rt.sendPrompt("#123 is the bug", "a4")).done).ok).toBe(true);
	});

	test("a prompt before the takeover settles (state starting) is refused as no runtime", async () => {
		const h = harness();
		const rt = await h.start();
		await expect(rt.sendPrompt("hi", "a1")).rejects.toMatchObject({ kind: "no_runtime" });
		expect(h.fake.userLines()).toBe(0);
	});

	test("an api_error result fails the prompt with the fixed words; the login-lost reply gets the login words", async () => {
		const apiError = harness({
			defaultTurn: [
				INIT,
				{
					say: {
						type: "result",
						subtype: "success",
						is_error: true,
						terminal_reason: "api_error",
						session_id: "$SESSION",
						user_message_uuids: ["$UUID"],
					},
				},
			],
		});
		const a = await apiError.start();
		expect(await (await prompt(apiError, a)).done).toMatchObject({
			ok: false,
			code: "api_error",
			error: CLAUDE_API_ERROR_MESSAGE,
		});
		expect(apiError.events.at(-1)).toMatchObject({ eventType: "HeadlessPromptFailed" });
		await a.dispose();

		const lost = harness({
			defaultTurn: [
				INIT,
				{
					say: {
						type: "assistant",
						session_id: "$SESSION",
						message: {
							role: "assistant",
							model: "<synthetic>",
							content: [{ type: "text", text: "Not logged in · Please run /login" }],
						},
					},
				},
				{
					say: {
						type: "result",
						subtype: "success",
						is_error: true,
						terminal_reason: "api_error",
						session_id: "$SESSION",
						user_message_uuids: ["$UUID"],
					},
				},
			],
		});
		const b = await lost.start();
		expect(await (await prompt(lost, b)).done).toMatchObject({
			ok: false,
			code: "login_lost",
			error: CLAUDE_LOGIN_LOST_ERROR,
		});
		// The synthetic text is not shown as the assistant's reply.
		expect(lost.events.some((e) => e.eventType === "HeadlessAssistantMessage")).toBe(false);
	});

	test("an exit mid-turn emits a marked HeadlessPromptFailed and a degraded idle report", async () => {
		const h = harness({ defaultTurn: [INIT, { exit: 3 }] });
		const rt = await h.start();
		const outcome = await (await prompt(h, rt)).done;
		expect(outcome).toMatchObject({ ok: false, code: "exited" });
		await rt.closed;
		const failed = h.events.find((e) => e.eventType === "HeadlessPromptFailed");
		expect(failed?.rawPayload).toMatchObject({ claudeStreamRuntime: true });
		expect(h.states.at(-1)).toMatchObject({
			managedState: "degraded",
			status: "idle",
			providerSyncState: "failed",
		});
		expect(hasClaudeStreamRuntime(FORK_ID)).toBe(false);
	});

	test("an exit before the takeover reported anything writes nothing", async () => {
		const h = harness({ defaultTurn: [{ exit: 0 }] });
		const rt = await h.start();
		// still `starting`: a prompt can't be sent, so the process is ended by the test
		await rt.dispose();
		expect(h.events).toEqual([]);
		expect(h.states).toEqual([]);
	});

	test("a stop that begins while the prompt is being recorded wins: nothing is sent, and the stop reports its own end", async () => {
		const h = harness();
		const rt = await h.start();
		rt.beginSettle();
		rt.settled();
		const original = h.callbacks.reportEvents;
		let stopping: Promise<unknown> | undefined;
		h.callbacks.reportEvents = async (batch) => {
			const outcome = await original(batch);
			if (batch[0]?.eventType === "HeadlessPromptSubmitted") stopping = rt.stop(FAST_TIMINGS);
			return outcome;
		};
		await expect(rt.sendPrompt("hello", "a1")).rejects.toMatchObject({ kind: "stopping" });
		await stopping;
		expect(h.fake.userLines()).toBe(0);
		// no idle report of ours: the stop's own report says what became of the session
		expect(h.states).toEqual([]);
	});

	test("a gate that throws after the server heard the prompt: nothing is sent and the session is reported idle", async () => {
		const h = harness();
		const rt = await h.start();
		rt.beginSettle();
		rt.settled();
		h.callbacks.reportEvents = async () => {
			throw new Error("network error after the server answered");
		};
		await expect(rt.sendPrompt("hello", "a1")).rejects.toMatchObject({ kind: "not_recorded" });
		expect(h.fake.userLines()).toBe(0);
		expect(h.states.at(-1)).toMatchObject({ managedState: "managed", status: "idle" });
		expect(rt.turnRunning).toBe(false);
		// the process is still good: the next prompt goes through
		h.callbacks.reportEvents = async (batch) => {
			h.events.push(...batch);
			return "sent";
		};
		expect((await (await rt.sendPrompt("again", "a2")).done).ok).toBe(true);
	});

	test("a gate that withholds the prompt: nothing is sent", async () => {
		const h = harness();
		const rt = await h.start();
		rt.beginSettle();
		rt.settled();
		h.callbacks.reportEvents = async () => "excluded";
		await expect(rt.sendPrompt("hello", "a1")).rejects.toBeInstanceOf(ClaudePromptWithheld);
		expect(h.fake.userLines()).toBe(0);
	});
});

describe("the per-prompt check for another writer", () => {
	async function started(h: Harness) {
		const rt = await h.start();
		rt.beginSettle();
		rt.settled();
		return rt;
	}

	test("own pid only: sent", async () => {
		const h = harness();
		const rt = await started(h);
		expect((await (await rt.sendPrompt("hi", "a1")).done).ok).toBe(true);
	});

	test("own pid plus another pid for the session: not sent, fixed words, nothing recorded", async () => {
		const h = harness();
		let phase = 0;
		const rt = await h.start({
			listAgents: async () => ({
				ok: true,
				entries:
					phase === 0
						? [{ pid: h.fake.pid(), sessionId: FORK_ID }]
						: [
								{ pid: h.fake.pid(), sessionId: FORK_ID },
								{ pid: 424242, sessionId: FORK_ID },
							],
			}),
		});
		rt.beginSettle();
		rt.settled();
		phase = 1;
		await expect(rt.sendPrompt("hi", "a1")).rejects.toMatchObject({
			kind: "terminal_found",
			message: CLAUDE_FORK_TERMINAL_FOUND_ERROR,
		});
		expect(h.fake.userLines()).toBe(0);
		expect(h.events).toEqual([]);
		expect(rt.turnRunning).toBe(false);
		// the next prompt, once it is gone, goes through
		phase = 0;
		expect((await (await rt.sendPrompt("hi", "a2")).done).ok).toBe(true);
	});

	test("another session only: sent", async () => {
		const h = harness();
		let phase = 0;
		const rt = await h.start({
			listAgents: async () => ({
				ok: true,
				entries:
					phase === 0
						? [{ pid: h.fake.pid(), sessionId: FORK_ID }]
						: [
								{ pid: h.fake.pid(), sessionId: FORK_ID },
								{ pid: 1234, sessionId: SOURCE_ID },
							],
			}),
		});
		rt.beginSettle();
		rt.settled();
		phase = 1;
		expect((await (await rt.sendPrompt("hi", "a1")).done).ok).toBe(true);
	});

	test("agents failing refuses with its own words and sends nothing", async () => {
		const h = harness();
		let phase = 0;
		const rt = await h.start({
			listAgents: async () =>
				phase === 0
					? { ok: true, entries: [{ pid: h.fake.pid(), sessionId: FORK_ID }] }
					: { ok: false, why: "it timed out" },
		});
		rt.beginSettle();
		rt.settled();
		phase = 1;
		await expect(rt.sendPrompt("hi", "a1")).rejects.toMatchObject({
			kind: "check_failed",
			message: CLAUDE_FORK_CHECK_FAILED_ERROR,
		});
		expect(h.fake.userLines()).toBe(0);
	});

	test("the real listing: non-zero, garbage, a hang (on a short clock) and a missing sessionId all fail the check", async () => {
		const h = harness();
		for (const [mode, expectedOk] of [
			["exit3", false],
			["garbage", false],
			["hang", false],
		] as const) {
			h.fake.configure({ account: KEY_ACCOUNT, agents: { mode } });
			const result = await listClaudeAgentEntries({
				executable: h.fake.path,
				cwd: h.root,
				env: { PATH: process.env.PATH ?? "", ...h.fake.env },
				timeoutMs: 400,
			});
			expect(result.ok, mode).toBe(expectedOk);
		}
		expect(parseAgentEntries('[{"pid":1}]')).toBeNull();
		expect(parseAgentEntries("banner\n[]")).toBeNull();
		expect(parseAgentEntries('{"agents":[{"sessionId":"s","pid":5}]}')).toEqual([
			{ sessionId: "s", pid: 5 },
		]);
		expect(parseAgentEntries("[]")).toEqual([]);
	});

	test("the recorded agents --json answers parse as the entries they list: none, one, two, with a pid each", () => {
		const live = readClaudeJson("agents-live.json");
		expect(parseAgentEntries(JSON.stringify(live.noneLive.parsed))).toEqual([]);
		const one = parseAgentEntries(JSON.stringify(live.oneLive.parsed)) ?? [];
		expect(one).toHaveLength(1);
		const two = parseAgentEntries(JSON.stringify(live.twoLive.parsed)) ?? [];
		expect(two.map((entry) => entry.sessionId).sort()).toEqual(
			[live.liveSessionIds.live1, live.liveSessionIds.live2].sort(),
		);
		expect(two.every((entry) => typeof entry.pid === "number")).toBe(true);
		// an entry for the fork shows the fork's id and the pid of its process (the own-id check reads exactly this)
		expect(two.find((entry) => entry.sessionId === live.liveSessionIds.N)?.pid).toBe(
			live.pids.live2,
		);
	});

	test("it runs before the first prompt and before every later one", async () => {
		const h = harness();
		let calls = 0;
		const rt = await h.start({
			listAgents: async () => {
				calls++;
				return { ok: true, entries: [{ pid: h.fake.pid(), sessionId: FORK_ID }] };
			},
		});
		const afterStart = calls;
		rt.beginSettle();
		rt.settled();
		await (await rt.sendPrompt("one", "a1")).done;
		await (await rt.sendPrompt("two", "a2")).done;
		expect(calls - afterStart).toBe(2);
	});
});

describe("later lines", () => {
	test("a line naming another session id is fatal: degraded, requests closed, no allow after", async () => {
		const port = recordingPort();
		const h = harness({
			defaultTurn: [
				INIT,
				canUseTool("r1", "Write", "tu1", { file_path: "/x", content: "y" }),
				{ delay: 100 },
				{
					say: {
						type: "assistant",
						session_id: "99999999-9999-4999-8999-999999999999",
						message: { role: "assistant", content: [{ type: "text", text: "x" }] },
					},
				},
				AWAIT,
			],
		});
		const rt = await h.start({ approvals: port });
		const sent = await prompt(h, rt);
		await until(() => port.ctx !== null, "the request");
		const outcome = await sent.done;
		expect(outcome).toMatchObject({
			ok: false,
			code: "fatal",
			error: CLAUDE_FORK_CHANGED_SYNC_ERROR,
		});
		await rt.closed;
		expect(port.calls).toContain("dispose");
		// the port can no longer answer
		expect(port.ctx?.answer("r1", allowResponse({}))).toBe(false);
		expect(h.fake.log().filter((e) => e.ev === "control_response")).toEqual([]);
		expect(h.states.at(-1)).toMatchObject({
			managedState: "degraded",
			providerSyncError: CLAUDE_FORK_CHANGED_SYNC_ERROR,
		});
		expect(alive(h.fake.pid())).toBe(false);
	});

	test("the recorded /clear swap (a second init with another id) is fatal", async () => {
		const swapped = outLines("id-swap-clear")
			.filter((m) => m.subtype === "init")
			.map((m) => m.session_id);
		expect(new Set(swapped).size).toBeGreaterThan(1);
		const h = harness({
			defaultTurn: [
				INIT,
				{ say: { type: "system", subtype: "init", session_id: swapped.at(-1) } },
				AWAIT,
			],
		});
		const rt = await h.start();
		const outcome = await (await prompt(h, rt)).done;
		expect(outcome).toMatchObject({ ok: false, code: "fatal" });
		await rt.closed;
		// and a conversation_reset (the /clear line itself) is the same
		const h2 = harness({
			defaultTurn: [
				INIT,
				{ say: { type: "conversation_reset", new_conversation_id: "x", session_id: "$SESSION" } },
				AWAIT,
			],
		});
		const rt2 = await h2.start();
		expect(await (await prompt(h2, rt2)).done).toMatchObject({ ok: false, code: "fatal" });
	});

	test("a different permission mode on a later init is fatal", async () => {
		const h = harness({
			turns: [
				[INIT, resultOk],
				[{ say: { type: "system", subtype: "init", permissionMode: "acceptEdits" } }, AWAIT],
			],
		});
		const rt = await h.start();
		await (await prompt(h, rt, "one", "a1")).done;
		const second = await (await rt.sendPrompt("two", "a2")).done;
		expect(second).toMatchObject({ ok: false, code: "fatal" });
	});

	test("control_response lines with no id and every turn's same-id init are not fatal", async () => {
		const h = harness({
			turns: [
				[
					INIT,
					{
						say: {
							type: "control_response",
							response: { subtype: "success", request_id: "stray", response: {} },
						},
					},
					resultOk,
				],
				[INIT, resultOk],
			],
		});
		const rt = await h.start();
		expect((await (await prompt(h, rt, "one", "a1")).done).ok).toBe(true);
		expect((await (await rt.sendPrompt("two", "a2")).done).ok).toBe(true);
		expect(rt.state).toBe("live");
	});

	/** Starts a settled fork, then has the fake print `frames` with no user line (a same-user process injecting a turn). */
	async function injected(
		frames: Array<Record<string, unknown>>,
		extra: Parameters<Harness["start"]>[0] = {},
	) {
		const trigger = join(mkdtempSync(join(tmpdir(), "inject-")), "go");
		const h = harness({ unprompted: frames, unpromptedTrigger: trigger });
		const rt = await h.start(extra);
		rt.beginSettle();
		rt.settled();
		writeFileSync(trigger, "");
		await rt.closed;
		rmSync(join(trigger, ".."), { recursive: true, force: true });
		return { h, rt };
	}

	test("an injected turn from the recorded lines (a lifecycle for a uuid the host never stamped) is fatal when idle", async () => {
		const peer = outLines("peer-injected-turn").find((m) => m.type === "command_lifecycle");
		expect(peer).toBeDefined();
		const { h } = await injected([{ ...(peer as Record<string, unknown>), session_id: FORK_ID }]);
		expect(alive(h.fake.pid())).toBe(false);
		expect(h.states.at(-1)).toMatchObject({
			managedState: "degraded",
			providerSyncError: CLAUDE_FORK_PEER_SYNC_ERROR,
		});
		expect(h.events).toEqual([]);
	});

	test("an init with no turn open is fatal", async () => {
		const { h } = await injected([
			{ type: "system", subtype: "init", session_id: FORK_ID, permissionMode: "default" },
		]);
		expect(alive(h.fake.pid())).toBe(false);
		expect(h.states.at(-1)).toMatchObject({ managedState: "degraded" });
	});

	test("an assistant or user line with no turn open is fatal", async () => {
		for (const type of ["assistant", "user"]) {
			const { h } = await injected([
				{
					type,
					session_id: FORK_ID,
					message: { role: type, content: [{ type: "text", text: "hi" }] },
				},
			]);
			expect(alive(h.fake.pid()), type).toBe(false);
			expect(h.states.at(-1), type).toMatchObject({ managedState: "degraded" });
		}
	});

	test("a request with no turn open is fatal and no tool response is written", async () => {
		const port = recordingPort();
		const { h } = await injected(
			[
				{
					type: "control_request",
					request_id: "ghost",
					request: {
						subtype: "can_use_tool",
						tool_name: "Bash",
						input: { command: "id" },
						tool_use_id: "x",
					},
				},
			],
			{ approvals: port },
		);
		expect(h.fake.log().filter((e) => e.ev === "control_response")).toEqual([]);
		expect(port.calls).not.toContain("request");
		expect(port.calls).toContain("dispose");
		expect(h.states.at(-1)).toMatchObject({ managedState: "degraded" });
	});

	test("a request inside a turn with an agent_id is declined locally, one warning, the runtime lives", async () => {
		const h = harness({
			defaultTurn: [
				INIT,
				canUseTool("r1", "Bash", "tu1", { command: "ls" }, { agent_id: "sub-1" }),
				AWAIT,
				resultOk,
			],
		});
		const port = recordingPort();
		const rt = await h.start({ approvals: port });
		const outcome = await (await prompt(h, rt)).done;
		expect(outcome.ok).toBe(true);
		const response = h.fake.log().find((e) => e.ev === "control_response");
		expect(response?.response.response).toEqual(denyResponse(CLAUDE_LOCAL_DECLINE_TEXT));
		expect(response?.requestId).toBe("r1");
		expect(port.calls).not.toContain("request");
		expect(h.events.filter((e) => e.eventType === "ManagedWarning")).toHaveLength(1);
		expect(rt.state).toBe("live");
	});

	test("a request for a tool outside the six is declined locally", async () => {
		const h = harness({
			defaultTurn: [INIT, canUseTool("r1", "mcp__x__ping", "tu1", {}), AWAIT, resultOk],
		});
		const rt = await h.start();
		expect((await (await prompt(h, rt)).done).ok).toBe(true);
		const answer = h.fake.log().find((e) => e.ev === "control_response");
		expect(answer?.response.response.behavior).toBe("deny");
		expect(answer?.requestId).toBe("r1");
	});

	test("with no approval path, a request in the six is declined locally too (nothing is ever auto-allowed)", async () => {
		const h = harness({
			defaultTurn: [
				INIT,
				canUseTool("r1", "Write", "tu1", { file_path: "/x", content: "y" }),
				AWAIT,
				resultOk,
			],
		});
		const rt = await h.start();
		await (await prompt(h, rt)).done;
		const responses = h.fake.log().filter((e) => e.ev === "control_response");
		expect(responses).toHaveLength(1);
		expect(responses[0]?.response.response.behavior).toBe("deny");
		expect(responses[0]?.requestId).toBe("r1");
	});

	test("a second result after the turn ended is fatal (an injected line queued behind the turn)", async () => {
		const h = harness({
			defaultTurn: [
				INIT,
				resultOk,
				{ delay: 50 },
				{ say: { type: "result", subtype: "success", is_error: false, session_id: "$SESSION" } },
				AWAIT,
			],
		});
		const rt = await h.start();
		await (await prompt(h, rt)).done;
		await rt.closed;
		expect(h.states.at(-1)).toMatchObject({
			managedState: "degraded",
			providerSyncError: CLAUDE_FORK_PEER_SYNC_ERROR,
		});
	});

	test("an injected lifecycle during a turn, for a uuid that isn't ours, is fatal", async () => {
		const h = harness({
			defaultTurn: [
				INIT,
				{
					say: {
						type: "command_lifecycle",
						command_uuid: "someone-else",
						state: "started",
						session_id: "$SESSION",
					},
				},
				AWAIT,
			],
		});
		const rt = await h.start();
		expect(await (await prompt(h, rt)).done).toMatchObject({
			ok: false,
			code: "fatal",
			error: CLAUDE_FORK_PEER_SYNC_ERROR,
		});
	});

	test("every recorded normal stream replayed turn by turn never fires a fatal rule", async () => {
		const fixtures = ["key-fork-restricted-write-deny", "uuid-fork", "bash-fail", "key-ask-bash"];
		let replayedTurns = 0;
		for (const name of fixtures) {
			// One scripted turn per user line the recording was sent.
			const turns: NonNullable<FakeConfig["turns"]> = [];
			for (const line of readClaudeFixture(name)) {
				if (line.dir === "in" && line.frame.type === "user") turns.push([]);
				else if (line.dir === "out" && turns.length > 0) {
					const t = line.frame.type as string;
					if (
						[
							"control_response",
							"control_request",
							"control_cancel_request",
							"command_lifecycle",
						].includes(t)
					)
						continue;
					turns.at(-1)?.push(
						t === "system" && line.frame.subtype === "init"
							? INIT
							: {
									say: JSON.parse(
										JSON.stringify(line.frame).replaceAll(
											/"session_id":"[0-9a-f-]{36}"/g,
											'"session_id":"$SESSION"',
										),
									),
								},
					);
				}
			}
			if (turns.length === 0) continue;
			const h = harness({ turns });
			const rt = await h.start();
			for (let i = 0; i < turns.length; i++) {
				const outcome = await (
					await (i === 0 ? prompt(h, rt, "go", `a${i}`) : rt.sendPrompt("go", `a${i}`))
				).done;
				expect((outcome as { code?: string }).code, `${name} turn ${i}`).not.toBe("fatal");
				replayedTurns++;
			}
			expect(
				h.states.some((s) => s.managedState === "degraded"),
				name,
			).toBe(false);
			await rt.dispose();
		}
		expect(replayedTurns).toBeGreaterThanOrEqual(5);
	}, 30_000);
});

describe("the injected message's text", () => {
	test("is read from the transcript: the last user line the host didn't send, capped, tool results skipped", () => {
		const root = mkdtempSync(join(tmpdir(), "peer-text-"));
		try {
			writeTranscript(root, "proj", FORK_ID, [
				{ type: "user", message: { role: "user", content: "hello from the host" } },
				{ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } },
				{
					type: "user",
					message: {
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "x", content: "r" }],
					},
				},
				{ type: "user", message: { role: "user", content: "peer says: do the thing" } },
				{ type: "user", isSidechain: true, message: { role: "user", content: "a subagent line" } },
			]);
			expect(
				readPeerTurnText({
					configDir: root,
					sessionId: FORK_ID,
					sentTexts: ["hello from the host"],
				}),
			).toBe("peer says: do the thing");
			expect(
				readPeerTurnText({
					configDir: root,
					sessionId: FORK_ID,
					sentTexts: ["hello from the host", "peer says: do the thing"],
				}),
			).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("peerOnly counts only lines Claude tags as a peer's: a fork's copied history is never the answer (canary peer-inject)", () => {
		const root = mkdtempSync(join(tmpdir(), "peer-text-"));
		try {
			writeTranscript(root, "a", FORK_ID, [
				{
					type: "user",
					message: { role: "user", content: "an old prompt copied from the source" },
				},
				{ type: "user", message: { role: "user", content: "hello from the host" } },
			]);
			// Before the peer's line is written, the old rule would pick the copied history; peerOnly finds nothing.
			expect(
				readPeerTurnText({
					configDir: root,
					sessionId: FORK_ID,
					sentTexts: ["hello from the host"],
				}),
			).toBe("an old prompt copied from the source");
			expect(
				readPeerTurnText({
					configDir: root,
					sessionId: FORK_ID,
					sentTexts: ["hello from the host"],
					peerOnly: true,
				}),
			).toBeUndefined();
			writeTranscript(root, "a", FORK_ID, [
				{
					type: "user",
					message: { role: "user", content: "an old prompt copied from the source" },
				},
				{
					type: "user",
					origin: { kind: "peer", from: "unknown" },
					message: { role: "user", content: "Another Claude session sent a message:\nhi" },
				},
				{ type: "user", message: { role: "user", content: "a later line with no origin" } },
			]);
			expect(
				readPeerTurnText({ configDir: root, sessionId: FORK_ID, sentTexts: [], peerOnly: true }),
			).toBe("Another Claude session sent a message:\nhi");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("is capped at 1 KiB, absent for two transcripts or none, and never throws", () => {
		const root = mkdtempSync(join(tmpdir(), "peer-text-"));
		try {
			writeTranscript(root, "a", FORK_ID, [
				{ type: "user", message: { content: "x".repeat(5000) } },
			]);
			expect(readPeerTurnText({ configDir: root, sessionId: FORK_ID, sentTexts: [] })?.length).toBe(
				PEER_TURN_TEXT_CAP,
			);
			writeTranscript(root, "b", FORK_ID, [{ type: "user", message: { content: "y" } }]);
			expect(
				readPeerTurnText({ configDir: root, sessionId: FORK_ID, sentTexts: [] }),
			).toBeUndefined();
			expect(() =>
				readPeerTurnText({ configDir: join(root, "nope"), sessionId: FORK_ID, sentTexts: [] }),
			).toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	const peerReport = async (lines: Record<string, unknown>[]) => {
		const peer = outLines("peer-injected-turn").find(
			(m) => m.type === "command_lifecycle",
		) as Record<string, unknown>;
		const trigger = join(mkdtempSync(join(tmpdir(), "inject-")), "go");
		const h = harness({
			unprompted: [{ ...peer, session_id: FORK_ID }],
			unpromptedTrigger: trigger,
		});
		writeTranscript(join(h.root, "cfg"), "proj", FORK_ID, lines);
		const rt = await h.start();
		rt.beginSettle();
		writeFileSync(trigger, "");
		await rt.closed;
		rmSync(join(trigger, ".."), { recursive: true, force: true });
		return h.states.find((s) => s.managedState === "degraded") as unknown as {
			peerTurnText?: string;
		};
	};

	test("a peer turn is reported in the degraded report as peerTurnText (the line Claude tags as a peer's)", async () => {
		const degraded = await peerReport([
			{ type: "user", message: { content: "an older prompt of the person's" } },
			{
				type: "user",
				origin: { kind: "peer", from: "unknown" },
				message: { content: "injected text from another process" },
			},
		]);
		expect(degraded?.peerTurnText).toBe("injected text from another process");
	});

	test("with no peer-tagged line the report says nothing was captured (an empty text), never an older line (P7-X2)", async () => {
		const degraded = await peerReport([
			{ type: "user", message: { content: "an older prompt of the person's" } },
			{ type: "user", message: { content: "injected text from another process" } },
		]);
		expect(degraded?.peerTurnText).toBe("");
	});
});

describe("tool rows and the approval seam", () => {
	const SENTINEL = "SENTINEL-4f9c2e-do-not-leak";

	test("each row of the table, from scripted recorded shapes; no input text in any event or report", async () => {
		const meta = (decision: string, source: string, kind?: string) => ({
			...(kind ? { non_execution_kind: kind } : {}),
			permission_decision: { decision, source },
		});
		const h = harness({
			defaultTurn: [
				INIT,
				// approved: request answered allow, result ok
				assistantToolUse("t1", "Bash", { command: `echo ${SENTINEL}` }),
				canUseTool("r1", "Bash", "t1", { command: `echo ${SENTINEL}` }),
				AWAIT,
				toolResult("t1", { meta: meta("accept", "user_temporary") }),
				// unasked: no request, result ok
				assistantToolUse("t2", "Read", { file_path: `/tmp/${SENTINEL}` }),
				toolResult("t2"),
				// failed: no non_execution_kind
				assistantToolUse("t3", "Bash", { command: "false" }),
				toolResult("t3", { isError: true, meta: meta("accept", "user_temporary") }),
				// declined by a person
				assistantToolUse("t4", "Write", { file_path: `/tmp/${SENTINEL}`, content: SENTINEL }),
				canUseTool("r4", "Write", "t4", { file_path: `/tmp/${SENTINEL}`, content: SENTINEL }),
				AWAIT,
				toolResult("t4", { isError: true, meta: meta("reject", "user_reject", "permission-rule") }),
				// refused by config
				assistantToolUse("t5", "Edit", { file_path: "/x", old_string: SENTINEL, new_string: "b" }),
				toolResult("t5", { isError: true, meta: meta("reject", "config", "permission-rule") }),
				// no result by turn end
				assistantToolUse("t6", "WebFetch", { url: `https://${SENTINEL}.example` }),
				// outside the six, bidi name
				assistantToolUse("t7", "Bash‮", { command: "x" }),
				toolResult("t7"),
				resultOk,
			],
		});
		const port = recordingPort();
		const rt = await h.start({ approvals: port });
		const sent = await prompt(h, rt);
		await until(() => port.requests.length >= 1, "request 1");
		port.ctx?.answer("r1", allowResponse({ command: `echo ${SENTINEL}` }));
		await until(() => port.requests.length >= 2, "request 2");
		port.ctx?.answer("r4", denyResponse("no"));
		const outcome = await sent.done;
		expect(outcome.ok).toBe(true);
		const rows = h.events.filter((e) => e.eventType === "HeadlessStatus").map((e) => e.content);
		expect(rows).toContain("Bash: ran, you approved it");
		expect(rows).toContain("Read: ran without asking");
		expect(rows).toContain("Bash: didn't succeed");
		expect(rows).toContain("Write: you declined it");
		expect(rows).toContain("Edit: refused");
		expect(rows).toContain("WebFetch: called, no result seen");
		expect(rows).toContain("A tool: ran without asking");
		expect(rows.some((r) => r?.includes("‮"))).toBe(false);
		// the per-turn rows count only unasked and refused calls from the six; an approved call isn't "without asking"
		expect(rows).toContain(
			"Ran without asking you this turn: Read (1). These were read-only, or your Claude settings allowed them.",
		);
		expect(rows).toContain("Claude tried this and was refused: Edit (1).");
		expect(h.reported()).not.toContain(SENTINEL);
	});

	test("under restricted the per-turn row says Claude treated them as read-only; zero calls: no per-turn row", async () => {
		const h = harness({
			defaultTurn: [
				INIT,
				assistantToolUse("t1", "Read", { file_path: "/x" }),
				toolResult("t1"),
				resultOk,
			],
		});
		const rt = await h.start({ mode: "restricted" });
		await (await prompt(h, rt)).done;
		expect(h.events.map((e) => e.content)).toContain(
			"Ran without asking you this turn: Read (1). Claude treated these as read-only.",
		);
		await rt.dispose();

		const quiet = harness();
		const rt2 = await quiet.start();
		await (await prompt(quiet, rt2)).done;
		expect(quiet.events.filter((e) => e.eventType === "HeadlessStatus")).toEqual([]);
	});

	test("a request reaches the approval port with the stream's own id; cancel, tool results and the turn's end are told to it", async () => {
		const h = harness({
			defaultTurn: [
				INIT,
				assistantToolUse("t1", "Bash", { command: "ls" }),
				canUseTool("r1", "Bash", "t1", { command: "ls" }),
				{ say: { type: "control_cancel_request", request_id: "r1" } },
				toolResult("t1"),
				resultOk,
			],
		});
		const port = recordingPort();
		const rt = await h.start({ approvals: port });
		await (await prompt(h, rt)).done;
		expect(port.requests[0]).toMatchObject({ id: "r1", method: "claude/can_use_tool" });
		expect(port.calls).toEqual(["request", "cancel:r1", "toolResult:t1", "turnEnded"]);
	});

	test("a control_request line emits no timeline row of its own", async () => {
		const h = harness({
			defaultTurn: [INIT, canUseTool("r1", "Bash", "t1", { command: "ls" }), AWAIT, resultOk],
		});
		const port = recordingPort();
		const rt = await h.start({ approvals: port });
		const sent = await prompt(h, rt);
		await until(() => port.ctx !== null, "request");
		port.ctx?.answer("r1", denyResponse("no"));
		await sent.done;
		expect(h.reported()).not.toContain("can_use_tool");
	});
});

describe("stopping", () => {
	test("Stop fences first, interrupts, and leaves nothing running; the prompt fails with the Stop's words", async () => {
		const port = recordingPort();
		const h = harness({ defaultTurn: [INIT, { hold: true }] });
		const rt = await h.start({ approvals: port });
		const sent = await prompt(h, rt);
		await until(() => h.fake.log().some((e) => e.ev === "user"), "user line");
		const result = await stopClaudeStreamSession(FORK_ID, FAST_TIMINGS);
		expect(result).toMatchObject({ hadChild: true, gone: true });
		expect(port.calls[0]).toBe("fence");
		expect(await sent.done).toMatchObject({ ok: false, code: "stopped" });
		expect(h.fake.controlSubtypes()).toContain("interrupt");
		expect(alive(h.fake.pid())).toBe(false);
		expect(hasClaudeStreamRuntime(FORK_ID)).toBe(false);
		// a stop is not an unexpected exit: no degraded report
		expect(h.states.some((s) => s.managedState === "degraded")).toBe(false);
	});

	test("a child that ignores the interrupt and SIGTERM is ended by SIGKILL", async () => {
		const h = harness({ defaultTurn: [INIT, { hold: true }], ignoreTerm: true, exitOnEof: false });
		const rt = await h.start();
		await prompt(h, rt);
		await until(() => h.fake.log().some((e) => e.ev === "user"), "user line");
		const result = await rt.stop(FAST_TIMINGS);
		expect(result.gone).toBe(true);
		expect(alive(h.fake.pid())).toBe(false);
		expect(h.guard.sent.length).toBeGreaterThanOrEqual(0);
	});

	test("stopping a session this host holds no fork for reports no child", async () => {
		expect(await stopClaudeStreamSession(FORK_ID)).toEqual({
			hadChild: false,
			gone: true,
			unchecked: false,
		});
	});

	test("a prompt for a fork this host holds no process for reports degraded once and is refused", async () => {
		const h = harness();
		await expect(
			promptClaudeStreamSession({ sessionId: FORK_ID, prompt: "hi", actionId: "a" }, h.callbacks),
		).rejects.toMatchObject({ kind: "no_runtime" });
		expect(h.states).toHaveLength(1);
		expect(h.states[0]).toMatchObject({ managedState: "degraded", status: "idle" });
	});
});

describe("the decline of a request that is never shown to a person (T9, T10, T11, X19)", () => {
	// Every can_use_tool line any recording holds, by request id.
	const recorded = new Map<string, Record<string, any>>();
	for (const name of [
		"tools-m04",
		"tools-webfetch-edit-notebook",
		"bash-blocked-path",
		"read-outside",
		"key-fork-restricted-write-deny",
		"cancel-interrupt",
		"user-reject",
		"bash-fail",
	]) {
		for (const frame of outLines(name)) {
			if (frame.type === "control_request" && frame.request?.subtype === "can_use_tool") {
				recorded.set(frame.request_id, frame);
			}
		}
	}
	const frames = [...recorded.values()];
	const raw = (frame: Record<string, any>) => ({ say: frame });
	const deniesOf = (h: Harness) =>
		h.fake
			.log()
			.filter((e) => e.ev === "control_response")
			.map((e) => ({ id: e.requestId, body: e.response.response }));

	test("the recordings hold every one of the six tools", () => {
		expect(frames.length).toBeGreaterThanOrEqual(8);
		const names = new Set(frames.map((f) => f.request.tool_name));
		for (const tool of ["Bash", "Read", "Write", "Edit", "NotebookEdit", "WebFetch"]) {
			expect(names.has(tool), tool).toBe(true);
		}
		// ...and a few outside the six (an MCP tool, AskUserQuestion), which are declined the same way
		expect(names.has("AskUserQuestion")).toBe(true);
	});

	test.each(frames.map((f) => [`${f.request.tool_name} ${f.request_id.slice(0, 8)}`, f] as const))(
		"with no approval path, %s gets exactly one deny carrying its own request id and the fixed words",
		async (_name, frame) => {
			const h = harness({ defaultTurn: [INIT, raw(frame), AWAIT, resultOk] });
			const rt = await h.start();
			const outcome = await (await prompt(h, rt)).done;
			expect(outcome.ok).toBe(true);
			expect(deniesOf(h)).toEqual([
				{ id: frame.request_id, body: denyResponse(CLAUDE_LOCAL_DECLINE_TEXT) },
			]);
			expect(rt.state).toBe("live");
		},
		20_000,
	);

	test("with an approval path, the request of each of the six tools reaches it, answered by nobody here", async () => {
		const seen = new Set<string>();
		for (const tool of ["Bash", "Read", "Write", "Edit", "NotebookEdit", "WebFetch"]) {
			const frame = frames.find((f) => f.request.tool_name === tool) as Record<string, any>;
			const port = recordingPort();
			const h = harness({ defaultTurn: [INIT, raw(frame), AWAIT, resultOk] });
			const rt = await h.start({ approvals: port });
			const sent = await prompt(h, rt);
			await until(() => port.ctx !== null, `the ${tool} request`);
			expect(port.requests[0]).toMatchObject({
				id: frame.request_id,
				method: "claude/can_use_tool",
			});
			expect(deniesOf(h)).toEqual([]);
			port.ctx?.answer(frame.request_id, denyResponse("no"));
			await sent.done;
			expect(deniesOf(h).map((d) => d.id)).toEqual([frame.request_id]);
			seen.add(tool);
			await rt.dispose();
		}
		expect(seen.size).toBe(6);
	}, 40_000);

	const base = (extra: Record<string, unknown>, drop: string[] = []) => {
		const request: Record<string, unknown> = {
			subtype: "can_use_tool",
			tool_name: "Bash",
			tool_use_id: "toolu_m1",
			input: { command: "ls" },
			...extra,
		};
		for (const key of drop) delete request[key];
		return { say: { type: "control_request", request_id: "mal-1", request } };
	};
	const malformed: Array<[string, ReturnType<typeof base>]> = [
		["tool_name missing", base({}, ["tool_name"])],
		["tool_name not a string", base({ tool_name: 5 })],
		["tool_name empty", base({ tool_name: "" })],
		["tool_use_id missing", base({}, ["tool_use_id"])],
		["tool_use_id empty", base({ tool_use_id: "" })],
		["tool_use_id not a string", base({ tool_use_id: 7 })],
		["input missing", base({}, ["input"])],
		["input a string", base({ input: "ls" })],
		["input null", base({ input: null })],
		["input an array", base({ input: ["ls"] })],
		["agent_id empty", base({ agent_id: "" })],
		["agent_id null", base({ agent_id: null })],
		["agent_id set", base({ agent_id: "sub" })],
	];
	test.each(malformed)(
		"a malformed request (%s) is declined by its own id and never reaches the approval path",
		async (_name, frame) => {
			const port = recordingPort();
			const h = harness({ defaultTurn: [INIT, frame, AWAIT, resultOk] });
			const rt = await h.start({ approvals: port });
			expect((await (await prompt(h, rt)).done).ok).toBe(true);
			expect(deniesOf(h)).toEqual([{ id: "mal-1", body: denyResponse(CLAUDE_LOCAL_DECLINE_TEXT) }]);
			expect(port.calls).not.toContain("request");
			expect(rt.state).toBe("live");
		},
		15_000,
	);

	test("a second request for a tool_use_id already asked about this turn is declined; the first reaches the port", async () => {
		const port = recordingPort();
		const first = base({}).say;
		const second = { type: "control_request", request_id: "mal-2", request: { ...first.request } };
		const h = harness({
			defaultTurn: [INIT, { say: first }, { say: second }, AWAIT, AWAIT, resultOk],
		});
		const rt = await h.start({ approvals: port });
		const sent = await prompt(h, rt);
		await until(() => deniesOf(h).length === 1, "the duplicate's decline");
		expect(deniesOf(h)).toEqual([{ id: "mal-2", body: denyResponse(CLAUDE_LOCAL_DECLINE_TEXT) }]);
		expect(port.requests.map((r) => r.id)).toEqual(["mal-1"]);
		port.ctx?.answer("mal-1", denyResponse("no"));
		await sent.done;
		expect(deniesOf(h).map((d) => d.id)).toEqual(["mal-2", "mal-1"]);
	});

	test("an approval path that throws in step, or rejects later, is a deny by the request's id and the runtime lives", async () => {
		for (const how of ["throws", "rejects"] as const) {
			const port = recordingPort();
			port.onToolRequest = () => {
				if (how === "throws") throw new Error("boom /Users/someone");
				return Promise.reject(new Error("boom later"));
			};
			const h = harness({ defaultTurn: [INIT, base({}), AWAIT, resultOk] });
			const rt = await h.start({ approvals: port });
			expect((await (await prompt(h, rt)).done).ok, how).toBe(true);
			expect(deniesOf(h), how).toEqual([
				{ id: "mal-1", body: denyResponse(CLAUDE_LOCAL_DECLINE_TEXT) },
			]);
			expect(JSON.stringify(h.fake.log())).not.toContain("someone");
			expect(rt.state, how).toBe("live");
			await rt.dispose();
		}
	});

	test("a locally declined call is a row of its own kind, never 'you declined it', whatever Claude then says", async () => {
		const h = harness({
			defaultTurn: [
				INIT,
				assistantToolUse("t1", "Write", { file_path: "/x", content: "y" }),
				canUseTool("r1", "Write", "t1", { file_path: "/x", content: "y" }),
				AWAIT,
				// Claude reports our deny as a user rejection (measured: user_reject for a deny we sent)
				toolResult("t1", {
					isError: true,
					meta: {
						non_execution_kind: "permission-rule",
						permission_decision: { decision: "reject", source: "user_reject" },
					},
				}),
				resultOk,
			],
		});
		const rt = await h.start();
		await (await prompt(h, rt)).done;
		const rows = h.events.filter((e) => e.eventType === "HeadlessStatus").map((e) => e.content);
		expect(rows).toContain("Write: AgentPulse declined it; you weren't asked");
		expect(rows.some((r) => r?.includes("you declined it"))).toBe(false);
	});

	test("warning rows are capped per turn", async () => {
		const steps: unknown[] = [INIT];
		for (let i = 0; i < 8; i++) {
			const step = base({ tool_name: "mcp__x__y", tool_use_id: `tu${i}` }).say;
			steps.push({ say: { ...step, request_id: `w${i}` } }, AWAIT);
		}
		const h = harness({ defaultTurn: [...steps, resultOk] as never });
		const rt = await h.start();
		await (await prompt(h, rt)).done;
		expect(h.events.filter((e) => e.eventType === "ManagedWarning").length).toBeLessThanOrEqual(3);
		expect(h.events.filter((e) => e.eventType === "ManagedWarning").length).toBeGreaterThanOrEqual(
			1,
		);
		expect(deniesOf(h)).toHaveLength(8);
	});
});

describe("rows from recorded tool_result_meta (T13)", () => {
	test("each recorded variant earns the row its meta says", async () => {
		const variants: Array<{
			fixture: string;
			use: Record<string, any>;
			result: Record<string, any>;
			meta: Record<string, any>;
		}> = [];
		for (const fixture of ["user-reject", "key-restricted-clean", "bash-fail"]) {
			const lines = outLines(fixture);
			for (const line of lines) {
				if (line.type !== "user" || !Array.isArray(line.tool_result_meta)) continue;
				for (const meta of line.tool_result_meta) {
					// The fixtures keep the assistant lines of only some runs; a tool_use the recording lacks is made up
					// for the id (the row names the tool, the meta decides the kind).
					const found = lines
						.filter((l) => l.type === "assistant")
						.flatMap((l) => l.message?.content ?? [])
						.find((b: Record<string, any>) => b.type === "tool_use" && b.id === meta.id);
					const use = found ?? { type: "tool_use", id: meta.id, name: "Write", input: {} };
					variants.push({ fixture, use, result: line, meta });
				}
			}
		}
		expect(variants.length).toBeGreaterThanOrEqual(6);
		const expectedRow = (v: (typeof variants)[number]) => {
			const tool = v.use.name;
			if (v.meta.non_execution_kind) {
				return `${tool}: ${v.meta.permission_decision?.source === "user_reject" ? "you declined it" : "refused"}`;
			}
			const block = v.result.message.content.find(
				(b: Record<string, any>) => b.tool_use_id === v.meta.id,
			);
			return `${tool}: ${block?.is_error ? "didn't succeed" : "ran without asking"}`;
		};
		const kinds = new Set(variants.map(expectedRow).map((r) => r.split(": ")[1]));
		expect(kinds.has("you declined it")).toBe(true);
		expect(kinds.has("refused")).toBe(true);
		expect(kinds.has("didn't succeed")).toBe(true);
		for (const v of variants) {
			const sess = (o: unknown) =>
				JSON.parse(
					JSON.stringify(o).replaceAll(/"session_id":"[0-9a-f-]{36}"/g, '"session_id":"$SESSION"'),
				);
			const h = harness({
				defaultTurn: [
					INIT,
					{
						say: sess({
							type: "assistant",
							message: { role: "assistant", content: [v.use] },
							session_id: "$SESSION",
						}),
					},
					{ say: sess(v.result) },
					resultOk,
				],
			});
			const rt = await h.start();
			await (await prompt(h, rt)).done;
			const rows = h.events.filter((e) => e.eventType === "HeadlessStatus").map((e) => e.content);
			expect(rows, `${v.fixture} ${v.use.name}`).toContain(expectedRow(v));
			await rt.dispose();
		}
	}, 60_000);
});

describe("a stop that finds something left running (X15)", () => {
	test("gone:false is not remembered: a retry runs the ladder again, and the slot is freed only when all is gone", async () => {
		const h = harness();
		const kills: Array<[number, string]> = [];
		let pidOfChild = 0;
		const state = { leftover: true, listed: 0 };
		const table: ProcessTable = {
			async list() {
				state.listed++;
				const rows = [
					{ pid: process.pid, ppid: 1, started: "now" },
					{ pid: pidOfChild, ppid: process.pid, started: "Mon Nov  6 06:00:00 2026" },
				];
				if (state.leftover)
					rows.push({ pid: 424242, ppid: pidOfChild, started: "Mon Nov  6 06:00:01 2026" });
				return rows;
			},
		};
		const rt = await h.start({
			stopReach: {
				table,
				killPid: (pid, signal) => void kills.push([pid, signal]),
				ownPid: process.pid,
			},
		});
		pidOfChild = rt.pid;
		rt.beginSettle();
		rt.settled();
		const first = await rt.stop({ interruptMs: 0, stdinCloseMs: 200, termMs: 200, killMs: 200 });
		expect(first.gone).toBe(false);
		expect(rt.state).not.toBe("gone");
		expect(hasClaudeStreamRuntime(FORK_ID)).toBe(true);
		const listedAfterFirst = state.listed;
		// the leftover goes away; a retry asks again and finishes
		state.leftover = false;
		const retry = await rt.stop({ interruptMs: 0, stdinCloseMs: 200, termMs: 200, killMs: 200 });
		expect(state.listed).toBeGreaterThan(listedAfterFirst);
		expect(retry.gone).toBe(true);
		await rt.closed;
		expect(hasClaudeStreamRuntime(FORK_ID)).toBe(false);
		// the descendant was signalled by the ladder, by pid, from the table (the guard's own list is empty: nothing real)
		expect(kills.some(([pid]) => pid === 424242)).toBe(true);
	}, 30_000);

	test("the wait after SIGKILL is at least the table's own timeout plus a poll", async () => {
		const process_ = await import("./claude-process.js");
		const src = await Bun.file(new URL("./claude-process.ts", import.meta.url)).text();
		expect(src).toContain("Math.max(t.killMs, TABLE_TIMEOUT_MS + DESCENDANT_POLL_MS)");
		expect(process_.FORK_STOP_TIMINGS.killMs).toBeGreaterThan(0);
	});
});
