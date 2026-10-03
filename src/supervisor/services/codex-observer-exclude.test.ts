/**
 * The Codex observer and the exclude rules. The observer reads the rollout files
 * Codex writes and posts hook events for them, so it applies the same rules as
 * every other sender: a session whose directory is covered is never posted, and
 * once covered it stays covered. While the rules file is invalid it reads and
 * advances but posts nothing, and the paused stretch is never replayed. The
 * AGENTPULSE_SKIP variable is not visible to the observer; path rules are what
 * cover an observer-only host.
 *
 * Every case uses a throwaway home (rules, marker directory) and an injected
 * fetch: nothing here reaches a server.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRulesWatch } from "./exclude-rules-watch.js";

const { loadState, processRolloutFile, saveState, scanRolloutFiles } = await import(
	"./codex-observer.js"
);

const made: string[] = [];
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

type Captured = { hook: string; body: Record<string, unknown> };

function fakeFetch(captured: Captured[]) {
	return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
		captured.push({ hook: String(body.hook_event_name), body });
		return new Response("{}", { status: 200 });
	};
}

let version = 0;
function world() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ap-observer-exclude-")));
	made.push(root);
	const home = join(root, "home");
	const secret = join(root, "work", "secret-project");
	const open = join(root, "work", "open-project");
	for (const dir of [home, secret, open, join(home, ".agentpulse")]) {
		mkdirSync(dir, { recursive: true });
	}
	chmodSync(join(home, ".agentpulse"), 0o700);
	const rulesFile = join(home, ".agentpulse", "exclude");
	const writeRules = (lines: string[]) => {
		writeFileSync(rulesFile, `${lines.join("\n")}\n`, { mode: 0o600 });
		chmodSync(rulesFile, 0o600);
		const at = new Date(Date.parse("2026-02-01T00:00:00Z") + ++version * 1000);
		utimesSync(rulesFile, at, at);
	};
	const rules = createRulesWatch({ home });
	return { root, home, secret, open, writeRules, rules, rulesFile };
}

const meta = (id: string, cwd: string) =>
	`${JSON.stringify({ type: "session_meta", payload: { id, cwd, model: "m" } })}\n`;
const prompt = (text: string) =>
	`${JSON.stringify({
		type: "response_item",
		payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
	})}\n`;

function rollout(w: ReturnType<typeof world>, id: string, cwd: string, ...lines: string[]) {
	const path = join(w.root, `rollout-${id}.jsonl`);
	writeFileSync(path, meta(id, cwd) + lines.join(""));
	return path;
}

const run = (
	w: ReturnType<typeof world>,
	path: string,
	state: Parameters<typeof processRolloutFile>[1],
	captured: Captured[],
	rules: Parameters<typeof processRolloutFile>[7] = w.rules,
) =>
	processRolloutFile(path, state, "http://x", null, new Map(), fakeFetch(captured), w.home, rules);

describe("a session whose directory is covered is never posted", () => {
	test("covered from the first scan: nothing posted, the offset is the end of the file, the state remembers the exclusion and nothing about where the session was", async () => {
		const w = world();
		w.writeRules([join(w.root, "work", "secret-project")]);
		const path = rollout(w, "sess-a", join(w.secret, "sub"), prompt("private text"));
		const captured: Captured[] = [];
		const state = await run(w, path, undefined, captured);
		expect(captured).toEqual([]);
		expect(state).toEqual({ offset: statSync(path).size, sessionId: "sess-a", excluded: true });
		expect("cwd" in state).toBe(false);
		expect(JSON.stringify(state)).not.toContain("secret-project");
	});

	test("a clean directory posts as before, and the state remembers where the session is", async () => {
		const w = world();
		w.writeRules([w.secret]);
		const path = rollout(w, "sess-b", w.open, prompt("hello"));
		const captured: Captured[] = [];
		const state = await run(w, path, undefined, captured);
		expect(captured.map((c) => c.hook)).toEqual(["SessionStart", "UserPromptSubmit"]);
		expect(state.cwd).toBe(w.open);
		expect(state.excluded).not.toBe(true);
	});

	test("with no rules at all nothing changes (the control for every case here)", async () => {
		const w = world();
		const path = rollout(w, "sess-c", w.secret, prompt("hello"));
		const captured: Captured[] = [];
		await run(w, path, undefined, captured);
		expect(captured.map((c) => c.hook)).toEqual(["SessionStart", "UserPromptSubmit"]);
	});

	test("a rule added after the session started stops it: later lines are not posted and the state says excluded", async () => {
		const w = world();
		const path = rollout(w, "sess-d", w.secret, prompt("before the rule"));
		const first: Captured[] = [];
		const state = await run(w, path, undefined, first);
		expect(first).toHaveLength(2);

		w.writeRules([w.secret]);
		appendFileSync(path, prompt("after the rule"));
		const second: Captured[] = [];
		const next = await run(w, path, state, second);
		expect(second).toEqual([]);
		expect(next).toEqual({ excluded: true, offset: statSync(path).size, sessionId: "sess-d" });
	});

	test("excluded is sticky: removing the rule later does not resume the session, and its offset keeps advancing", async () => {
		const w = world();
		w.writeRules([w.secret]);
		const path = rollout(w, "sess-e", w.secret, prompt("one"));
		const state = await run(w, path, undefined, []);
		rmSync(w.rulesFile);
		appendFileSync(path, prompt("two"));
		const captured: Captured[] = [];
		const next = await run(w, path, state, captured);
		expect(captured).toEqual([]);
		expect(next).toMatchObject({ excluded: true, offset: statSync(path).size });
	});

	test("one signature check per file at most: the rules are asked for once per call", async () => {
		const w = world();
		w.writeRules([w.secret]);
		const path = rollout(w, "sess-f", w.open, prompt("a"), prompt("b"), prompt("c"));
		let asked = 0;
		await run(w, path, undefined, [], {
			current: () => {
				asked++;
				return w.rules.current();
			},
		});
		expect(asked).toBe(1);
	});
});

describe("an entry that has no directory (state from before, or rewritten by an older observer)", () => {
	function oldEntry(path: string, id: string, afterFirstLines: number) {
		const lines = readLines(path);
		const offset = lines
			.slice(0, afterFirstLines)
			.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0);
		return { offset, sessionId: id };
	}
	const readLines = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean);

	test("the directory is read from the file's first session_meta; a covered one stops the session, a clean one carries on and is remembered", async () => {
		const w = world();
		w.writeRules([w.secret]);
		const secretPath = rollout(w, "old-secret", w.secret, prompt("a"));
		const openPath = rollout(w, "old-open", w.open, prompt("a"));
		const secretState = oldEntry(secretPath, "old-secret", 2);
		const openState = oldEntry(openPath, "old-open", 2);
		appendFileSync(secretPath, prompt("new secret line"));
		appendFileSync(openPath, prompt("new open line"));

		const secretPosts: Captured[] = [];
		const nextSecret = await run(w, secretPath, secretState, secretPosts);
		expect(secretPosts).toEqual([]);
		expect(nextSecret).toMatchObject({ excluded: true });
		expect("cwd" in nextSecret).toBe(false);

		const openPosts: Captured[] = [];
		const nextOpen = await run(w, openPath, openState, openPosts);
		expect(openPosts.map((c) => c.hook)).toEqual(["UserPromptSubmit"]);
		expect(nextOpen.cwd).toBe(w.open);
	});

	test("no session_meta to be found and rules exist: excluded; with no rules there is nothing to decide and it carries on", async () => {
		const w = world();
		const path = join(w.root, "rollout-headless.jsonl");
		writeFileSync(path, prompt("a") + prompt("b"));
		const state = { offset: Buffer.byteLength(prompt("a")), sessionId: "headless" };

		const noRules: Captured[] = [];
		await run(w, path, state, noRules);
		expect(noRules.map((c) => c.hook)).toEqual(["UserPromptSubmit"]);

		w.writeRules([w.secret]);
		const withRules: Captured[] = [];
		const next = await run(w, path, state, withRules);
		expect(withRules).toEqual([]);
		expect(next.excluded).toBe(true);
	});

	test("an upgraded state file keeps what it has and drops what it cannot trust", () => {
		const w = world();
		const file = join(w.root, "state.json");
		writeFileSync(
			file,
			JSON.stringify({
				files: {
					"/a": { offset: 10, sessionId: "s1" },
					"/b": { offset: 20, sessionId: "s2", cwd: "/x/y", excluded: true },
					"/c": { offset: 30, sessionId: "s3", cwd: 5, excluded: "yes" },
					"/d": { offset: 40, sessionId: "s4", cwd: null },
				},
			}),
		);
		const state = loadState(file);
		expect(state.files["/a"]).toEqual({ offset: 10, sessionId: "s1" });
		expect(state.files["/b"]).toEqual({ offset: 20, sessionId: "s2", cwd: "/x/y", excluded: true });
		expect(state.files["/c"]).toEqual({ offset: 30, sessionId: "s3" });
		expect(state.files["/d"]).toEqual({ offset: 40, sessionId: "s4", cwd: null });
	});
});

describe("while the rules file is invalid the observer reads and advances but posts nothing, and the paused stretch is never replayed", () => {
	test("break the file, append lines, fix the file: those lines are never posted and the saved offset is past them", async () => {
		const w = world();
		w.writeRules([w.secret]);
		const path = rollout(w, "sess-g", w.open, prompt("before"));
		const first: Captured[] = [];
		const state = await run(w, path, undefined, first);
		expect(first).toHaveLength(2);

		w.writeRules(["relative/path"]);
		appendFileSync(path, prompt("paused one") + prompt("paused two"));
		const paused: Captured[] = [];
		const afterPause = await run(w, path, state, paused);
		expect(paused).toEqual([]);
		expect(afterPause.offset).toBe(statSync(path).size);

		w.writeRules([w.secret]);
		appendFileSync(path, prompt("after the fix"));
		const resumed: Captured[] = [];
		const afterFix = await run(w, path, afterPause, resumed);
		expect(resumed.map((c) => c.body.prompt)).toEqual(["after the fix"]);
		expect(afterFix.offset).toBe(statSync(path).size);
	});

	test("a session that starts while the file is invalid: nothing of it is posted, its directory is learned, and after the fix only new lines go out (or none, when it is covered)", async () => {
		const w = world();
		w.writeRules(["relative/path"]);
		const cleanPath = rollout(w, "sess-h", w.open, prompt("during the pause"));
		const secretPath = rollout(w, "sess-i", w.secret, prompt("during the pause"));
		const cleanState = await run(w, cleanPath, undefined, []);
		const secretState = await run(w, secretPath, undefined, []);
		expect(cleanState).toMatchObject({ offset: statSync(cleanPath).size, cwd: w.open });
		expect(secretState).toMatchObject({ offset: statSync(secretPath).size, cwd: w.secret });

		w.writeRules([w.secret]);
		appendFileSync(cleanPath, prompt("later clean"));
		appendFileSync(secretPath, prompt("later secret"));
		const clean: Captured[] = [];
		const secret: Captured[] = [];
		await run(w, cleanPath, cleanState, clean);
		const afterSecret = await run(w, secretPath, secretState, secret);
		expect(clean.map((c) => c.body.prompt)).toEqual(["later clean"]);
		expect(secret).toEqual([]);
		expect(afterSecret.excluded).toBe(true);
		expect("cwd" in afterSecret).toBe(false);
	});

	test("the invalid marker is the watch's business: the observer itself neither creates nor removes it", async () => {
		const w = world();
		w.writeRules(["relative/path"]);
		const path = rollout(w, "sess-j", w.open, prompt("x"));
		await run(w, path, undefined, [], { current: () => ({ state: "invalid", rules: [] }) });
		expect(() => statSync(join(w.home, ".agentpulse", "exclude.invalid"))).toThrow();
	});
});

describe("an excluded entry keeps only the flag", () => {
	test("an entry saved with a directory is rewritten without it the next time it is looked at, and the file on disk follows", async () => {
		const w = world();
		w.writeRules([w.secret]);
		const path = rollout(w, "sess-k", w.secret, prompt("x"));
		const old = { offset: 5, sessionId: "sess-k", cwd: w.secret, excluded: true as const };
		const stateFile = join(w.root, "observer-state.json");
		saveState({ files: { [path]: old } }, stateFile);
		expect(readFileSync(stateFile, "utf8")).toContain("secret-project");

		const loaded = loadState(stateFile);
		const saves: unknown[] = [];
		await scanRolloutFiles([path], {
			state: loaded,
			callMapsByFile: new Map(),
			serverUrl: "http://x",
			apiKey: null,
			rules: w.rules,
			fetchImpl: fakeFetch([]),
			homeDir: w.home,
			save: (state) => {
				saves.push(JSON.parse(JSON.stringify(state)));
				saveState(state, stateFile);
			},
		});
		expect(saves).toHaveLength(1);
		expect(loaded.files[path]).toEqual({
			offset: statSync(path).size,
			sessionId: "sess-k",
			excluded: true,
		});
		expect(readFileSync(stateFile, "utf8")).not.toContain("secret-project");
	});
});

describe("every session_meta in a file is judged, not only the first", () => {
	const metaLine = (id: string, cwd?: string) =>
		`${JSON.stringify({ type: "session_meta", payload: { id, ...(cwd ? { cwd } : {}), model: "m" } })}\n`;

	test("a later session_meta in a covered directory: nothing from it on is posted, and the entry is excluded without a directory", async () => {
		const w = world();
		w.writeRules([w.secret]);
		const path = join(w.root, "rollout-multi.jsonl");
		writeFileSync(
			path,
			metaLine("first", w.open) +
				prompt("while clean") +
				metaLine("second", w.secret) +
				prompt("while covered"),
		);
		const captured: Captured[] = [];
		const state = await run(w, path, undefined, captured);
		expect(captured.map((c) => [c.hook, c.body.session_id, c.body.prompt])).toEqual([
			["SessionStart", "first", undefined],
			["UserPromptSubmit", "first", "while clean"],
		]);
		expect(state).toEqual({ offset: statSync(path).size, sessionId: "second", excluded: true });
	});

	test("the same when the later session_meta arrives in a later scan", async () => {
		const w = world();
		w.writeRules([w.secret]);
		const path = join(w.root, "rollout-multi-2.jsonl");
		writeFileSync(path, metaLine("first", w.open) + prompt("while clean"));
		const first: Captured[] = [];
		const state = await run(w, path, undefined, first);
		expect(first).toHaveLength(2);
		appendFileSync(path, metaLine("second", w.secret) + prompt("while covered"));
		const second: Captured[] = [];
		const next = await run(w, path, state, second);
		expect(second).toEqual([]);
		expect(next).toMatchObject({ excluded: true });
		expect("cwd" in next).toBe(false);
	});

	test("a later session_meta in another clean directory carries on, and the entry follows it", async () => {
		const w = world();
		w.writeRules([w.secret]);
		const other = join(w.root, "work", "third-project");
		mkdirSync(other, { recursive: true });
		const path = join(w.root, "rollout-multi-3.jsonl");
		writeFileSync(
			path,
			metaLine("first", w.open) + metaLine("second", other) + prompt("in the second"),
		);
		const captured: Captured[] = [];
		const state = await run(w, path, undefined, captured);
		expect(captured.map((c) => [c.hook, c.body.session_id])).toEqual([
			["SessionStart", "first"],
			["SessionStart", "second"],
			["UserPromptSubmit", "second"],
		]);
		expect(state).toMatchObject({ sessionId: "second", cwd: other });
	});

	test("a later session_meta with no directory, while rules exist: excluded (a directory that cannot be determined is covered)", async () => {
		const w = world();
		w.writeRules([w.secret]);
		const path = join(w.root, "rollout-multi-4.jsonl");
		writeFileSync(path, metaLine("first", w.open) + metaLine("second") + prompt("nowhere"));
		const captured: Captured[] = [];
		const state = await run(w, path, undefined, captured);
		expect(captured.map((c) => c.body.session_id)).toEqual(["first"]);
		expect(state).toMatchObject({ excluded: true });
	});

	test("with no rules every session_meta goes out as before (the control)", async () => {
		const w = world();
		const path = join(w.root, "rollout-multi-5.jsonl");
		writeFileSync(path, metaLine("first", w.open) + metaLine("second", w.secret) + prompt("x"));
		const captured: Captured[] = [];
		await run(w, path, undefined, captured);
		expect(captured.map((c) => c.hook)).toEqual([
			"SessionStart",
			"SessionStart",
			"UserPromptSubmit",
		]);
	});
});

describe("called without rules, the observer fails closed", () => {
	test("nothing is posted, the offset advances (a stretch nobody could judge is not replayed later), and a clean directory makes no difference", async () => {
		const w = world();
		const path = rollout(w, "sess-l", w.open, prompt("a"), prompt("b"));
		const captured: Captured[] = [];
		const state = await processRolloutFile(
			path,
			undefined,
			"http://x",
			null,
			new Map(),
			fakeFetch(captured),
			w.home,
		);
		expect(captured).toEqual([]);
		expect(state.offset).toBe(statSync(path).size);
	});
});

describe("the state file is rewritten only when an entry changed", () => {
	test("a scan that changes nothing does not save; a new file, a grown file and an excluded session each do, once", async () => {
		const w = world();
		w.writeRules([w.secret]);
		const cleanPath = rollout(w, "sess-m", w.open, prompt("a"));
		const secretPath = rollout(w, "sess-n", w.secret, prompt("a"));
		const state = { files: {} as Record<string, never> } as Parameters<typeof saveState>[0];
		let saves = 0;
		const scan = () =>
			scanRolloutFiles([cleanPath, secretPath], {
				state,
				callMapsByFile: new Map(),
				serverUrl: "http://x",
				apiKey: null,
				rules: w.rules,
				fetchImpl: fakeFetch([]),
				homeDir: w.home,
				save: () => {
					saves++;
				},
			});

		await scan();
		expect(saves).toBe(2);
		await scan();
		await scan();
		expect(saves).toBe(2);
		appendFileSync(cleanPath, prompt("more"));
		await scan();
		expect(saves).toBe(3);
		await scan();
		expect(saves).toBe(3);
		appendFileSync(secretPath, prompt("more secret"));
		await scan();
		expect(saves).toBe(4);
		await scan();
		expect(saves).toBe(4);
	});
});
