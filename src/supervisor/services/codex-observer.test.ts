// Phase 4 (AGEN-16): codex-observer identity, origin, turn semantics,
// injected-context skip, native marker, atomic state, opt-out.
//
// Harness rule 8: never touches the real home directory. Every test uses
// processRolloutFile with a temp rollout file, an injected fetchImpl, and
// a fresh tmp homeDir. Every test copies the fixture with a fresh session
// id (session_meta.payload.id rewritten), since isNativeCovered caches
// positive results in a process-wide Set keyed by (home, sessionId) — a
// fresh id per test is sufficient without a reset hook.

import { afterAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
	codexNativeMarkerPath,
	evictNativeMarkers,
	isCodexObserverEnabled,
	isNativeCovered,
	processRolloutFile,
	saveState,
} = await import("./codex-observer.js");
const { CODEX_NATIVE_MARKER_DIR, DELIVERY_ID_HEADER, ORIGIN_CODEX_OBSERVER, ORIGIN_HEADER } =
	await import("../../shared/hook-headers.js");

const FIXTURE_PATH = join(
	import.meta.dir,
	"__fixtures__",
	"codex-rollout-0.145",
	"rollout-sanitized.jsonl",
);
const FIXTURE_RAW = readFileSync(FIXTURE_PATH, "utf8");
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

type Captured = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tmpDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

function fakeFetch(captured: Captured[], opts: { fail?: (n: number) => boolean } = {}) {
	let n = 0;
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		n++;
		if (opts.fail?.(n)) {
			return new Response("boom", { status: 500, statusText: "Internal Server Error" });
		}
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		captured.push({ url: String(input), headers, body });
		return new Response("{}", { status: 200 });
	};
}

function fixtureWithSessionId(sessionId: string): string {
	return FIXTURE_RAW.replaceAll(PLACEHOLDER_ID, sessionId);
}

function writeFixtureCopy(
	dir: string,
	sessionId = crypto.randomUUID(),
): { path: string; sessionId: string } {
	const path = join(dir, "rollout.jsonl");
	writeFileSync(path, fixtureWithSessionId(sessionId));
	return { path, sessionId };
}

function singleLineRollout(dir: string, sessionId: string, extraLines: string[]): string {
	const path = join(dir, "rollout.jsonl");
	const lines = [
		JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: "/tmp/x" } }),
		...extraLines,
		"",
	];
	writeFileSync(path, lines.join("\n"));
	return path;
}

function userMessageLine(content: Array<{ type: string; text: string }>): string {
	return JSON.stringify({
		type: "response_item",
		payload: { type: "message", role: "user", content },
	});
}

// The split point used by O2s and O12(c): right after the first
// function_call (call_0001example), before its output.
function splitFixture(sessionId: string): [string, string] {
	const full = fixtureWithSessionId(sessionId);
	const lines = full.split("\n").filter((l) => l.length > 0);
	const splitIdx = lines.findIndex(
		(l) => l.includes('"call_id":"call_0001example"') && l.includes('"type":"function_call"'),
	);
	const part1 = `${lines.slice(0, splitIdx + 1).join("\n")}\n`;
	const part2 = `${lines.slice(splitIdx + 1).join("\n")}\n`;
	return [part1, part2];
}

describe("O1: posts exactly the expected hook sequence, with identity headers", () => {
	test("full fixture run", async () => {
		const dir = mkTmp("ap-codex-obs-");
		const home = mkTmp("ap-codex-home-");
		const { path } = writeFixtureCopy(dir);
		const captured: Captured[] = [];
		await processRolloutFile(
			path,
			undefined,
			"http://x",
			null,
			new Map(),
			fakeFetch(captured),
			home,
		);

		expect(captured.map((c) => c.body.hook_event_name)).toEqual([
			"SessionStart",
			"UserPromptSubmit",
			"PreToolUse",
			"PostToolUse",
			"PreToolUse",
			"PostToolUse",
			"Stop",
		]);

		for (const c of captured) {
			expect(c.headers["x-agent-type"]).toBe("codex_cli");
			expect(c.headers[ORIGIN_HEADER.toLowerCase()]).toBe(ORIGIN_CODEX_OBSERVER);
			expect(c.headers[DELIVERY_ID_HEADER.toLowerCase()]).toMatch(/^[0-9a-f]{32}$/);
		}
		const ids = captured.map((c) => c.headers[DELIVERY_ID_HEADER.toLowerCase()]);
		expect(new Set(ids).size).toBe(ids.length);

		const pre = captured.filter((c) => c.body.hook_event_name === "PreToolUse");
		const post = captured.filter((c) => c.body.hook_event_name === "PostToolUse");
		expect(pre.map((c) => c.body.tool_use_id)).toEqual(["call_0001example", "call_0003example"]);
		expect(post.map((c) => c.body.tool_use_id)).toEqual(["call_0001example", "call_0003example"]);
	});
});

test("O2 a replay from zero sends identical bodies and ids", async () => {
	const dir = mkTmp("ap-codex-obs-");
	const home = mkTmp("ap-codex-home-");
	const { path } = writeFixtureCopy(dir);

	const first: Captured[] = [];
	await processRolloutFile(path, undefined, "http://x", null, new Map(), fakeFetch(first), home);
	const second: Captured[] = [];
	await processRolloutFile(path, undefined, "http://x", null, new Map(), fakeFetch(second), home);

	expect(second.map((c) => c.headers[DELIVERY_ID_HEADER.toLowerCase()])).toEqual(
		first.map((c) => c.headers[DELIVERY_ID_HEADER.toLowerCase()]),
	);
	expect(second.map((c) => c.body)).toEqual(first.map((c) => c.body));
});

test("O2s a mid-turn resume sends the same bodies as a replay from zero, except the restarted PostToolUse.tool_name", async () => {
	const dir = mkTmp("ap-codex-obs-");
	const home = mkTmp("ap-codex-home-");
	const sessionId = crypto.randomUUID();
	const [part1, part2] = splitFixture(sessionId);

	const zeroPath = join(dir, "zero.jsonl");
	writeFileSync(zeroPath, part1 + part2);
	const zeroCaptured: Captured[] = [];
	await processRolloutFile(
		zeroPath,
		undefined,
		"http://x",
		null,
		new Map(),
		fakeFetch(zeroCaptured),
		home,
	);

	const resumePath = join(dir, "resume.jsonl");
	writeFileSync(resumePath, part1);
	const firstHalf: Captured[] = [];
	const state1 = await processRolloutFile(
		resumePath,
		undefined,
		"http://x",
		null,
		new Map(),
		fakeFetch(firstHalf),
		home,
	);
	writeFileSync(resumePath, part1 + part2);
	const secondHalf: Captured[] = [];
	// A fresh callMap simulates a process restart between the two halves.
	await processRolloutFile(
		resumePath,
		state1,
		"http://x",
		null,
		new Map(),
		fakeFetch(secondHalf),
		home,
	);

	const resumedAll = [...firstHalf, ...secondHalf];
	expect(resumedAll).toHaveLength(zeroCaptured.length);
	for (let i = 0; i < resumedAll.length; i++) {
		const a = resumedAll[i]?.body as Record<string, unknown>;
		const b = zeroCaptured[i]?.body as Record<string, unknown>;
		const isSplitPost = a.hook_event_name === "PostToolUse" && a.tool_use_id === "call_0001example";
		if (isSplitPost) {
			const { tool_name: _a, ...aRest } = a;
			const { tool_name: _b, ...bRest } = b;
			expect(aRest, `line ${i}`).toEqual(bRest);
			expect(a.tool_name, `line ${i}`).toBe("unknown_tool");
		} else {
			expect(a, `line ${i}`).toEqual(b);
		}
	}
});

test("O3 a 500 on the 3rd post throws; a rerun re-posts 1-2 identically", async () => {
	const dir = mkTmp("ap-codex-obs-");
	const home = mkTmp("ap-codex-home-");
	const { path } = writeFixtureCopy(dir);

	const firstAttempt: Captured[] = [];
	let threw = false;
	try {
		await processRolloutFile(
			path,
			undefined,
			"http://x",
			null,
			new Map(),
			fakeFetch(firstAttempt, { fail: (n) => n === 3 }),
			home,
		);
	} catch {
		threw = true;
	}
	expect(threw).toBe(true);
	expect(firstAttempt).toHaveLength(2);

	const rerun: Captured[] = [];
	await processRolloutFile(path, undefined, "http://x", null, new Map(), fakeFetch(rerun), home);
	expect(rerun.slice(0, 2).map((c) => c.body)).toEqual(firstAttempt.map((c) => c.body));
	expect(rerun.slice(0, 2).map((c) => c.headers[DELIVERY_ID_HEADER.toLowerCase()])).toEqual(
		firstAttempt.map((c) => c.headers[DELIVERY_ID_HEADER.toLowerCase()]),
	);
});

test("O4 an appended line produces exactly one new post under a new id, and the offset covers the file", async () => {
	const dir = mkTmp("ap-codex-obs-");
	const home = mkTmp("ap-codex-home-");
	const { path } = writeFixtureCopy(dir);
	const callMap = new Map<string, string>();
	const first: Captured[] = [];
	const state = await processRolloutFile(
		path,
		undefined,
		"http://x",
		null,
		callMap,
		fakeFetch(first),
		home,
	);

	const newLine = `${userMessageLine([{ type: "input_text", text: "one more thing" }])}\n`;
	appendFileSync(path, newLine);
	const second: Captured[] = [];
	const state2 = await processRolloutFile(
		path,
		state,
		"http://x",
		null,
		callMap,
		fakeFetch(second),
		home,
	);

	expect(second).toHaveLength(1);
	expect(second[0]?.body.hook_event_name).toBe("UserPromptSubmit");
	expect(second[0]?.headers[DELIVERY_ID_HEADER.toLowerCase()]).not.toBe(
		first.at(-1)?.headers[DELIVERY_ID_HEADER.toLowerCase()],
	);
	expect(state2.offset).toBe(statSync(path).size);
});

test("O5 the header/origin constants equal the exact literals", () => {
	expect(DELIVERY_ID_HEADER).toBe("X-AgentPulse-Delivery-Id");
	expect(ORIGIN_HEADER).toBe("X-AgentPulse-Origin");
	expect(ORIGIN_CODEX_OBSERVER).toBe("codex-observer");
});

test("O6 every post's session_id equals session_meta.payload.id", async () => {
	const dir = mkTmp("ap-codex-obs-");
	const home = mkTmp("ap-codex-home-");
	const { path, sessionId } = writeFixtureCopy(dir);
	const captured: Captured[] = [];
	await processRolloutFile(path, undefined, "http://x", null, new Map(), fakeFetch(captured), home);
	expect(captured.length).toBeGreaterThan(0);
	for (const c of captured) expect(c.body.session_id).toBe(sessionId);
});

test("O7 exactly one Stop per turn, from the fixture's task_complete", async () => {
	const dir = mkTmp("ap-codex-obs-");
	const home = mkTmp("ap-codex-home-");
	const { path } = writeFixtureCopy(dir);
	const captured: Captured[] = [];
	await processRolloutFile(path, undefined, "http://x", null, new Map(), fakeFetch(captured), home);
	const stops = captured.filter((c) => c.body.hook_event_name === "Stop");
	expect(stops).toHaveLength(1);
	expect(stops[0]?.body.last_assistant_message).toBe(
		"Validation added and the full suite is green.",
	);
	expect(stops[0]?.body.turn_id).toBe("turn-0001");
});

test("O7c a task_complete with an empty last_agent_message posts a Stop with no last_assistant_message key", async () => {
	const dir = mkTmp("ap-codex-obs-");
	const home = mkTmp("ap-codex-home-");
	const sessionId = crypto.randomUUID();
	const path = singleLineRollout(dir, sessionId, [
		JSON.stringify({
			type: "event_msg",
			payload: { type: "task_complete", turn_id: "turn-0001", last_agent_message: "" },
		}),
	]);
	const captured: Captured[] = [];
	await processRolloutFile(path, undefined, "http://x", null, new Map(), fakeFetch(captured), home);
	const stop = captured.find((c) => c.body.hook_event_name === "Stop");
	expect(stop).toBeDefined();
	expect("last_assistant_message" in (stop?.body ?? {})).toBe(false);
});

test("O8 a legacy task_completed line posts exactly one Stop, with turn_id when present", async () => {
	const dir = mkTmp("ap-codex-obs-");
	const home = mkTmp("ap-codex-home-");
	const sessionId = crypto.randomUUID();
	const path = singleLineRollout(dir, sessionId, [
		JSON.stringify({
			type: "event_msg",
			payload: { type: "task_completed", turn_id: "turn-legacy" },
		}),
	]);
	const captured: Captured[] = [];
	await processRolloutFile(path, undefined, "http://x", null, new Map(), fakeFetch(captured), home);
	const stops = captured.filter((c) => c.body.hook_event_name === "Stop");
	expect(stops).toHaveLength(1);
	expect(stops[0]?.body.turn_id).toBe("turn-legacy");
});

test("O9 saveState writes atomically, replacing pre-existing tmp garbage", () => {
	const dir = mkTmp("ap-codex-state-");
	const target = join(dir, "state.json");
	writeFileSync(`${target}.tmp`, "not json garbage {{{");
	saveState({ files: { a: { offset: 5, sessionId: "s1" } } }, target);
	expect(existsSync(`${target}.tmp`)).toBe(false);
	expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
		files: { a: { offset: 5, sessionId: "s1" } },
	});
});

describe("O10 isCodexObserverEnabled", () => {
	test('"off" disables', () => {
		expect(isCodexObserverEnabled({ AGENTPULSE_CODEX_OBSERVER: "off" })).toBe(false);
	});
	test("unset enables", () => {
		expect(isCodexObserverEnabled({})).toBe(true);
	});
	test('"" enables', () => {
		expect(isCodexObserverEnabled({ AGENTPULSE_CODEX_OBSERVER: "" })).toBe(true);
	});
	test('"on" enables', () => {
		expect(isCodexObserverEnabled({ AGENTPULSE_CODEX_OBSERVER: "on" })).toBe(true);
	});
	test('"OFF" (wrong case) still enables — the check is case-sensitive', () => {
		expect(isCodexObserverEnabled({ AGENTPULSE_CODEX_OBSERVER: "OFF" })).toBe(true);
	});
	test("supervisor/index.ts gates startCodexObserver on it", () => {
		const src = readFileSync(join(import.meta.dir, "..", "index.ts"), "utf8");
		expect(src).toMatch(/isCodexObserverEnabled\(process\.env\)/);
	});
});

test("O11 the injected-context item is not posted; the real prompt is posted once", async () => {
	const dir = mkTmp("ap-codex-obs-");
	const home = mkTmp("ap-codex-home-");
	const { path } = writeFixtureCopy(dir);
	const captured: Captured[] = [];
	const state = await processRolloutFile(
		path,
		undefined,
		"http://x",
		null,
		new Map(),
		fakeFetch(captured),
		home,
	);
	const prompts = captured.filter((c) => c.body.hook_event_name === "UserPromptSubmit");
	expect(prompts).toHaveLength(1);
	expect(prompts[0]?.body.prompt).toBe(
		"Please add input validation to the signup form and run the test suite.",
	);
	expect(captured.every((c) => !String(c.body.prompt ?? "").includes("environment_context"))).toBe(
		true,
	);
	expect(state.offset).toBe(statSync(path).size);
});

describe("O11b skip-rule edges", () => {
	async function postedPromptsFor(
		content: Array<{ type: string; text: string }>,
	): Promise<Captured[]> {
		const dir = mkTmp("ap-codex-obs-");
		const home = mkTmp("ap-codex-home-");
		const sessionId = crypto.randomUUID();
		const path = singleLineRollout(dir, sessionId, [userMessageLine(content)]);
		const captured: Captured[] = [];
		await processRolloutFile(
			path,
			undefined,
			"http://x",
			null,
			new Map(),
			fakeFetch(captured),
			home,
		);
		return captured.filter((c) => c.body.hook_event_name === "UserPromptSubmit");
	}

	test("leading whitespace before the tag still skips", async () => {
		const posted = await postedPromptsFor([
			{ type: "input_text", text: "   <environment_context>x</environment_context>" },
		]);
		expect(posted).toHaveLength(0);
	});

	test("a leading newline before the tag still skips", async () => {
		const posted = await postedPromptsFor([
			{ type: "input_text", text: "\n<environment_context>x</environment_context>" },
		]);
		expect(posted).toHaveLength(0);
	});

	test("the tag in a second input_text block still skips (any block)", async () => {
		const posted = await postedPromptsFor([
			{ type: "input_text", text: "some preamble" },
			{ type: "input_text", text: "<environment_context>x</environment_context>" },
		]);
		expect(posted).toHaveLength(0);
	});

	test("a mid-text mention is posted", async () => {
		const posted = await postedPromptsFor([
			{ type: "input_text", text: "please show <environment_context>" },
		]);
		expect(posted).toHaveLength(1);
	});

	test('"please show <environment_context>" is posted', async () => {
		const posted = await postedPromptsFor([
			{ type: "input_text", text: "please show <environment_context>" },
		]);
		expect(posted[0]?.body.prompt).toBe("please show <environment_context>");
	});
});

describe("O12 a native-hook marker stands the observer down", () => {
	test("(a) marker present before the call -> 0 posts, offset = file size", async () => {
		const dir = mkTmp("ap-codex-obs-");
		const home = mkTmp("ap-codex-home-");
		const { path, sessionId } = writeFixtureCopy(dir);
		mkdirSync(join(home, ".agentpulse", "codex-native"), { recursive: true });
		writeFileSync(codexNativeMarkerPath(home, sessionId), "");

		const captured: Captured[] = [];
		const state = await processRolloutFile(
			path,
			undefined,
			"http://x",
			null,
			new Map(),
			fakeFetch(captured),
			home,
		);
		expect(captured).toHaveLength(0);
		expect(state.offset).toBe(statSync(path).size);
	});

	test("(b) no marker -> it posts", async () => {
		const dir = mkTmp("ap-codex-obs-");
		const home = mkTmp("ap-codex-home-");
		const { path } = writeFixtureCopy(dir);
		const captured: Captured[] = [];
		await processRolloutFile(
			path,
			undefined,
			"http://x",
			null,
			new Map(),
			fakeFetch(captured),
			home,
		);
		expect(captured.length).toBeGreaterThan(0);
	});

	test("(c) a marker created between two runs stops posting from the next run", async () => {
		const dir = mkTmp("ap-codex-obs-");
		const home = mkTmp("ap-codex-home-");
		const sessionId = crypto.randomUUID();
		const [part1, part2] = splitFixture(sessionId);
		const path = join(dir, "rollout.jsonl");
		writeFileSync(path, part1);

		const first: Captured[] = [];
		const state = await processRolloutFile(
			path,
			undefined,
			"http://x",
			null,
			new Map(),
			fakeFetch(first),
			home,
		);
		expect(first.length).toBeGreaterThan(0);

		mkdirSync(join(home, ".agentpulse", "codex-native"), { recursive: true });
		writeFileSync(codexNativeMarkerPath(home, sessionId), "");
		writeFileSync(path, part1 + part2);

		const second: Captured[] = [];
		await processRolloutFile(path, state, "http://x", null, new Map(), fakeFetch(second), home);
		expect(second).toHaveLength(0);
	});
});

test("O12b invalid session ids never match a marker, even if a file exists at the naive join path", () => {
	const home = mkTmp("ap-codex-home-");
	const markerDir = join(home, ".agentpulse", "codex-native");
	mkdirSync(markerDir, { recursive: true });

	for (const id of ["../x", "a/b", "a".repeat(129), "a b"]) {
		try {
			const naivePath = join(markerDir, id);
			mkdirSync(join(naivePath, ".."), { recursive: true });
			writeFileSync(naivePath, "");
		} catch {
			// some invalid ids can't be materialized as a literal path on every fs
		}
		expect(isNativeCovered(id, home), id).toBe(false);
	}
	// "" fails the length >= 1 charset requirement with no filesystem interaction possible.
	expect(isNativeCovered("", home)).toBe(false);
});

describe("O13 evictNativeMarkers", () => {
	function touch(path: string, mtimeMs: number) {
		writeFileSync(path, "");
		const t = mtimeMs / 1000;
		utimesSync(path, t, t);
	}

	test("removes only a stale, well-formed marker file; leaves everything else", () => {
		const home = mkTmp("ap-codex-home-");
		const dir = join(home, ".agentpulse", "codex-native");
		mkdirSync(dir, { recursive: true });
		const now = Date.UTC(2026, 0, 10);
		const maxAgeMs = 5 * 24 * 60 * 60 * 1000;

		const stale = join(dir, "session-stale");
		touch(stale, now - maxAgeMs - 1000);
		const fresh = join(dir, "session-fresh");
		touch(fresh, now - 1000);
		const boundary = join(dir, "session-boundary");
		touch(boundary, now - maxAgeMs);
		const badName = join(dir, "session_bad");
		touch(badName, now - maxAgeMs - 1000);
		const oldDir = join(dir, "session-olddir");
		mkdirSync(oldDir);
		const oldT = (now - maxAgeMs - 1000) / 1000;
		utimesSync(oldDir, oldT, oldT);
		const target = join(dir, "session-symlink-target");
		touch(target, now - 1000);
		const link = join(dir, "session-symlink");
		symlinkSync(target, link);

		evictNativeMarkers(home, now, maxAgeMs);

		expect(existsSync(stale)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(boundary)).toBe(true);
		expect(existsSync(badName)).toBe(true);
		expect(existsSync(oldDir)).toBe(true);
		expect(existsSync(link)).toBe(true);
		expect(existsSync(target)).toBe(true);
	});

	test("a missing directory does not throw", () => {
		const home = mkTmp("ap-codex-home-");
		expect(() => evictNativeMarkers(home, Date.now(), 1000)).not.toThrow();
	});
});

test("O14 no UserPromptSubmit body has a turn_id key", async () => {
	const dir = mkTmp("ap-codex-obs-");
	const home = mkTmp("ap-codex-home-");
	const { path } = writeFixtureCopy(dir);
	const captured: Captured[] = [];
	await processRolloutFile(path, undefined, "http://x", null, new Map(), fakeFetch(captured), home);
	const prompts = captured.filter((c) => c.body.hook_event_name === "UserPromptSubmit");
	expect(prompts.length).toBeGreaterThan(0);
	for (const c of prompts) expect("turn_id" in c.body).toBe(false);
});

describe("O-marker literal pin", () => {
	test("CODEX_NATIVE_MARKER_DIR is the exact literal", () => {
		expect(CODEX_NATIVE_MARKER_DIR).toBe(".agentpulse/codex-native");
	});
	test("codexNativeMarkerPath matches the manual join", () => {
		expect(codexNativeMarkerPath("/home/x", "sid-1")).toBe(
			join("/home/x", ".agentpulse", "codex-native", "sid-1"),
		);
	});
});
