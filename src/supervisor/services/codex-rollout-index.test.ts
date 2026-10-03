/**
 * Which rollout files the Codex observer looks at: the recent day directories,
 * plus any file written to within the resume window wherever it sits (a resumed
 * session keeps appending to its original file). The index must not walk and
 * stat the whole tree on every scan, must not stat while sorting, and must
 * survive anything vanishing mid-scan. A file seen for the first time outside the
 * recent days is tailed from its current end, never replayed.
 *
 * Real-filesystem cases use a throwaway directory; the cost cases use an
 * in-memory filesystem that counts calls. Nothing here touches a real home, a
 * server, or the network. Windows has never been exercised: paths are built with
 * path.join and the tests compare paths built the same way.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
	appendFileSync,
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_EXCLUDE_RULES } from "./codex-observer-test-support.js";
import { createRulesWatch } from "./exclude-rules-watch.js";

const { scanRolloutFiles } = await import("./codex-observer.js");
const { COLD_RECHECK_MS, RELIST_FALLBACK_MS, createRolloutIndex, resumeWindowMsFromEnv } =
	await import("./codex-rollout-index.js");
type RolloutFs = import("./codex-rollout-index.js").RolloutFs;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-06-15T12:00:00Z");

const made: string[] = [];
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-rollout-index-")));
	made.push(dir);
	return dir;
}

function dayDir(root: string, daysAgo: number): string {
	const d = new Date(T0 - daysAgo * DAY);
	return join(
		root,
		String(d.getUTCFullYear()),
		String(d.getUTCMonth() + 1).padStart(2, "0"),
		String(d.getUTCDate()).padStart(2, "0"),
	);
}

describe("AGENTPULSE_CODEX_RESUME_WINDOW_HOURS", () => {
	test("unset, empty or unusable means 24 hours; a number is hours; 0 turns it off", () => {
		expect(resumeWindowMsFromEnv({})).toBe(DAY);
		expect(resumeWindowMsFromEnv({ AGENTPULSE_CODEX_RESUME_WINDOW_HOURS: "" })).toBe(DAY);
		expect(resumeWindowMsFromEnv({ AGENTPULSE_CODEX_RESUME_WINDOW_HOURS: "abc" })).toBe(DAY);
		expect(resumeWindowMsFromEnv({ AGENTPULSE_CODEX_RESUME_WINDOW_HOURS: "-3" })).toBe(DAY);
		expect(resumeWindowMsFromEnv({ AGENTPULSE_CODEX_RESUME_WINDOW_HOURS: "48" })).toBe(2 * DAY);
		expect(resumeWindowMsFromEnv({ AGENTPULSE_CODEX_RESUME_WINDOW_HOURS: "0" })).toBe(0);
	});
});

describe("on a real directory tree", () => {
	function tree() {
		const root = scratch();
		const put = (dir: string, name: string, ageMs: number) => {
			mkdirSync(dir, { recursive: true });
			const path = join(dir, name);
			writeFileSync(path, "{}\n");
			const at = new Date(T0 - ageMs);
			utimesSync(path, at, at);
			return path;
		};
		return { root, put };
	}

	test("the recent day directories are always in; an old directory is in only for a file written within the window", () => {
		const { root, put } = tree();
		const today = put(dayDir(root, 0), "rollout-today-old-mtime.jsonl", 3 * DAY);
		const resumed = put(dayDir(root, 20), "rollout-resumed.jsonl", 2 * HOUR);
		const ancient = put(dayDir(root, 20), "rollout-ancient.jsonl", 3 * DAY);
		put(dayDir(root, 0), "notes.txt", HOUR);
		put(dayDir(root, 20), "rollout-wrong-suffix.json", HOUR);
		const index = createRolloutIndex({ root, backfillDays: 0, resumeWindowMs: DAY, now: () => T0 });
		const { files, resumedOnly } = index.list();
		expect(files.sort()).toEqual([resumed, today].sort());
		expect(files).not.toContain(ancient);
		expect([...resumedOnly]).toEqual([resumed]);
	});

	test("the backfill days stay in whatever the file's age", () => {
		const { root, put } = tree();
		const twoDaysAgo = put(dayDir(root, 2), "rollout-backfill.jsonl", 2 * DAY);
		const index = createRolloutIndex({ root, backfillDays: 2, resumeWindowMs: DAY, now: () => T0 });
		const listing = index.list();
		expect(listing.files).toEqual([twoDaysAgo]);
		expect(listing.resumedOnly.size).toBe(0);
	});

	test("files come back newest first", () => {
		const { root, put } = tree();
		const a = put(dayDir(root, 0), "rollout-a.jsonl", 5 * HOUR);
		const b = put(dayDir(root, 9), "rollout-b.jsonl", HOUR);
		const c = put(dayDir(root, 0), "rollout-c.jsonl", 10 * HOUR);
		const index = createRolloutIndex({ root, backfillDays: 0, resumeWindowMs: DAY, now: () => T0 });
		expect(index.list().files).toEqual([b, a, c]);
	});

	test("a zero window keeps resumed-session discovery off", () => {
		const { root, put } = tree();
		const today = put(dayDir(root, 0), "rollout-today.jsonl", HOUR);
		put(dayDir(root, 20), "rollout-resumed.jsonl", HOUR);
		const index = createRolloutIndex({ root, backfillDays: 0, resumeWindowMs: 0, now: () => T0 });
		expect(index.list().files).toEqual([today]);
	});

	test("a missing root lists nothing and does not throw", () => {
		const root = join(scratch(), "nothing-here");
		const index = createRolloutIndex({ root, backfillDays: 3, resumeWindowMs: DAY, now: () => T0 });
		expect(index.list()).toEqual({ files: [], resumedOnly: new Set() });
	});

	test("a file deleted between two scans drops out", () => {
		const { root, put } = tree();
		const keep = put(dayDir(root, 0), "rollout-keep.jsonl", HOUR);
		const gone = put(dayDir(root, 0), "rollout-gone.jsonl", 2 * HOUR);
		const index = createRolloutIndex({ root, backfillDays: 0, resumeWindowMs: DAY, now: () => T0 });
		expect(index.list().files).toEqual([keep, gone]);
		rmSync(gone);
		expect(index.list().files).toEqual([keep]);
	});
});

/** An in-memory filesystem that counts calls and can be edited between scans. */
function memoryFs() {
	const dirs = new Map<string, { mtime: number; entries: { name: string; isDir: boolean }[] }>();
	const files = new Map<string, number>();
	const calls = { readdir: 0, mtime: 0 };
	const log = { readdirs: [] as string[] };
	const failing = new Set<string>();
	const fs: RolloutFs = {
		readdir(dir) {
			calls.readdir++;
			log.readdirs.push(dir);
			if (failing.has(dir)) return null;
			return dirs.get(dir)?.entries.map((e) => ({ ...e })) ?? null;
		},
		mtimeMs(path) {
			calls.mtime++;
			if (failing.has(path)) return null;
			return dirs.get(path)?.mtime ?? files.get(path) ?? null;
		},
	};
	const ensureDir = (dir: string, mtime: number) => {
		if (!dirs.has(dir)) dirs.set(dir, { mtime, entries: [] });
	};
	const link = (parent: string, name: string, isDir: boolean, mtime: number) => {
		ensureDir(parent, mtime);
		const node = dirs.get(parent);
		if (node && !node.entries.some((e) => e.name === name)) node.entries.push({ name, isDir });
	};
	const addDir = (path: string, mtime: number) => {
		ensureDir(path, mtime);
	};
	/** Adds a dir and links it into its parents up to the root. */
	const addDay = (root: string, daysAgo: number, mtime: number) => {
		const day = dayDir(root, daysAgo);
		const month = join(day, "..");
		const year = join(month, "..");
		addDir(root, mtime);
		addDir(year, mtime);
		addDir(month, mtime);
		addDir(day, mtime);
		link(root, year.slice(root.length + 1), true, mtime);
		link(year, month.slice(year.length + 1), true, mtime);
		link(month, day.slice(month.length + 1), true, mtime);
		return day;
	};
	const addFile = (dir: string, name: string, mtime: number) => {
		link(dir, name, false, mtime);
		files.set(join(dir, name), mtime);
		return join(dir, name);
	};
	return { fs, dirs, files, calls, log, failing, addDay, addFile, addDir, link };
}

function bigTree(root: string, fx: ReturnType<typeof memoryFs>) {
	for (let d = 0; d < 365; d++) {
		const day = fx.addDay(root, d, T0 - d * DAY);
		for (let n = 0; n < 20; n++) fx.addFile(day, `rollout-${n}.jsonl`, T0 - d * DAY - n * 1000);
	}
}

describe("scan cost on a large tree", () => {
	const root = join("sessions-root");

	test("a scan with nothing changed lists no directory and stats only the few that can change", () => {
		const fx = memoryFs();
		bigTree(root, fx);
		let t = T0;
		const index = createRolloutIndex({
			root,
			backfillDays: 0,
			resumeWindowMs: DAY,
			now: () => t,
			fs: fx.fs,
		});
		index.list();
		fx.calls.readdir = 0;
		fx.calls.mtime = 0;
		t += 5_000;
		const listing = index.list();
		expect(fx.calls.readdir).toBe(0);
		// root, years, months, and the one or two day directories that are recent
		expect(fx.calls.mtime).toBeLessThan(100);
		expect(listing.files.length).toBeGreaterThanOrEqual(20);
	});

	test("nothing is statted while sorting: the calls grow with the files, not with n log n", () => {
		const fx = memoryFs();
		const day = fx.addDay(root, 0, T0);
		for (let n = 0; n < 300; n++) fx.addFile(day, `rollout-${n}.jsonl`, T0 - n * 1000);
		const index = createRolloutIndex({
			root,
			backfillDays: 0,
			resumeWindowMs: DAY,
			now: () => T0,
			fs: fx.fs,
		});
		fx.calls.mtime = 0;
		index.list();
		// root + year + month + day + one stat per file
		expect(fx.calls.mtime).toBeLessThanOrEqual(4 + 300);
		const listing = index.list();
		expect(listing.files).toHaveLength(300);
		expect(listing.files[0]).toBe(join(day, "rollout-0.jsonl"));
	});

	test("a cold directory is left alone until its recheck is due, and then a resumed file is found", () => {
		const fx = memoryFs();
		bigTree(root, fx);
		let t = T0;
		const index = createRolloutIndex({
			root,
			backfillDays: 0,
			resumeWindowMs: DAY,
			now: () => t,
			fs: fx.fs,
		});
		index.list();

		const oldDay = dayDir(root, 100);
		const resumed = join(oldDay, "rollout-3.jsonl");
		fx.files.set(resumed, t + 1_000); // appended: only the file's mtime changes
		t += 5_000;
		expect(index.list().files).not.toContain(resumed);

		t += 2 * COLD_RECHECK_MS;
		const listing = index.list();
		expect(listing.files).toContain(resumed);
		expect(listing.resumedOnly.has(resumed)).toBe(true);
	});

	test("once found, a resumed file is checked on every scan and falls out when its window ends", () => {
		const fx = memoryFs();
		bigTree(root, fx);
		let t = T0;
		const index = createRolloutIndex({
			root,
			backfillDays: 0,
			resumeWindowMs: DAY,
			now: () => t,
			fs: fx.fs,
		});
		index.list();
		const oldDay = dayDir(root, 100);
		const resumed = join(oldDay, "rollout-3.jsonl");
		fx.files.set(resumed, t);
		t += 2 * COLD_RECHECK_MS;
		expect(index.list().files).toContain(resumed);

		fx.files.set(resumed, t + 100);
		t += 5_000;
		fx.calls.mtime = 0;
		index.list();
		expect(fx.calls.mtime).toBeGreaterThanOrEqual(20); // the hot directory's files are statted again

		t += DAY + HOUR;
		index.list();
		t += 5_000;
		expect(index.list().files).not.toContain(resumed);
	});

	test("a new day directory is seen on the next scan; a new file in a cold directory after its recheck, listing only that directory", () => {
		const fx = memoryFs();
		bigTree(root, fx);
		let t = T0;
		const index = createRolloutIndex({
			root,
			backfillDays: 0,
			resumeWindowMs: DAY,
			now: () => t,
			fs: fx.fs,
		});
		index.list();

		const newDay = fx.addDay(root, -1, t + 1);
		const month = join(newDay, "..");
		const monthNode = fx.dirs.get(month);
		if (monthNode) monthNode.mtime = t + 1;
		const fresh = fx.addFile(newDay, "rollout-new.jsonl", t + 2);
		t += 5_000;
		// The new day is not "today" for the index (its clock still says the 15th), but it is a new directory with a fresh file.
		expect(index.list().files).toContain(fresh);

		const coldDay = dayDir(root, 200);
		const added = fx.addFile(coldDay, "rollout-added.jsonl", t);
		const coldNode = fx.dirs.get(coldDay);
		if (coldNode) coldNode.mtime = t;
		t += 2 * COLD_RECHECK_MS;
		fx.log.readdirs.length = 0;
		expect(index.list().files).toContain(added);
		expect(fx.log.readdirs).toEqual([coldDay]);
	});

	test("a directory whose listing changed without its mtime changing is still re-listed after the fallback", () => {
		const fx = memoryFs();
		bigTree(root, fx);
		let t = T0;
		const index = createRolloutIndex({
			root,
			backfillDays: 0,
			resumeWindowMs: DAY,
			now: () => t,
			fs: fx.fs,
		});
		index.list();
		const coldDay = dayDir(root, 50);
		const added = fx.addFile(coldDay, "rollout-sneaky.jsonl", t);
		// The directory's own mtime is left unchanged on purpose.
		t += COLD_RECHECK_MS * 2;
		expect(index.list().files).not.toContain(added);
		t += RELIST_FALLBACK_MS;
		expect(index.list().files).toContain(added);
	});

	test("anything that vanishes mid-scan is skipped, not thrown", () => {
		const fx = memoryFs();
		const day = fx.addDay(root, 0, T0);
		const keep = fx.addFile(day, "rollout-keep.jsonl", T0);
		const doomed = fx.addFile(day, "rollout-doomed.jsonl", T0);
		const otherDay = fx.addDay(root, 30, T0 - 30 * DAY);
		fx.addFile(otherDay, "rollout-x.jsonl", T0);
		const index = createRolloutIndex({
			root,
			backfillDays: 0,
			resumeWindowMs: DAY,
			now: () => T0,
			fs: fx.fs,
		});
		fx.failing.add(doomed); // stat fails
		fx.failing.add(otherDay); // directory vanished
		const listing = index.list();
		expect(listing.files).toEqual([keep]);

		fx.failing.clear();
		fx.failing.add(day); // the recent day directory itself cannot be read
		expect(() => index.list()).not.toThrow();
	});

	test("a directory removed after it was listed takes its files with it, even if its parent never changed", () => {
		const fx = memoryFs();
		fx.addFile(fx.addDay(root, 0, T0), "rollout-today.jsonl", T0);
		const oldDay = fx.addDay(root, 30, T0 - 30 * DAY);
		const resumed = fx.addFile(oldDay, "rollout-resumed.jsonl", T0 - HOUR);
		let t = T0;
		const index = createRolloutIndex({
			root,
			backfillDays: 0,
			resumeWindowMs: DAY,
			now: () => t,
			fs: fx.fs,
		});
		expect(index.list().files).toContain(resumed);
		fx.dirs.delete(oldDay);
		fx.files.delete(resumed);
		t += 2 * COLD_RECHECK_MS;
		expect(index.list().files).not.toContain(resumed);
	});
});

describe("a resumed file seen for the first time is tailed from its end", () => {
	let version = 0;
	function world() {
		const root = scratch();
		const home = join(root, "home");
		const secret = join(root, "work", "secret-project");
		const open = join(root, "work", "open-project");
		for (const dir of [home, secret, open, join(home, ".agentpulse")]) {
			mkdirSync(dir, { recursive: true });
		}
		chmodSync(join(home, ".agentpulse"), 0o700);
		return { root, home, secret, open };
	}
	const meta = (id: string, cwd: string) =>
		`${JSON.stringify({ type: "session_meta", payload: { id, cwd, model: "m" } })}\n`;
	const prompt = (text: string) =>
		`${JSON.stringify({
			type: "response_item",
			payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
		})}\n`;

	function ctx(w: ReturnType<typeof world>, extra: Record<string, unknown> = {}) {
		const posts: { hook: string; sessionId: string; text?: string }[] = [];
		const state = { files: {} as Record<string, unknown> };
		const context = {
			state: state as never,
			callMapsByFile: new Map<string, Map<string, string>>(),
			serverUrl: "http://x",
			apiKey: null,
			rules: NO_EXCLUDE_RULES,
			homeDir: w.home,
			fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body ?? "{}")) as {
					hook_event_name: string;
					session_id: string;
					prompt?: string;
				};
				posts.push({ hook: body.hook_event_name, sessionId: body.session_id, text: body.prompt });
				return new Response("{}", { status: 200 });
			},
			save: () => {},
			...extra,
		};
		return { context, posts, state };
	}

	function rollout(w: ReturnType<typeof world>, id: string, cwd: string, ...lines: string[]) {
		const dir = join(w.root, "sessions", "2025", "01", "02");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `rollout-${id}.jsonl`);
		writeFileSync(path, meta(id, cwd) + lines.join(""));
		return path;
	}

	test("the history is not replayed; a line appended afterwards is posted once, under the session in the file", async () => {
		const w = world();
		const path = rollout(w, "resumed-1", w.open, prompt("old one"), prompt("old two"));
		const { context, posts, state } = ctx(w, { seedAtEnd: new Set([path]) });
		await scanRolloutFiles([path], context as never);
		expect(posts).toEqual([]);
		expect(state.files[path]).toEqual({
			offset: statSync(path).size,
			sessionId: "resumed-1",
			cwd: w.open,
		});

		appendFileSync(path, prompt("new line"));
		await scanRolloutFiles([path], context as never);
		expect(posts).toEqual([{ hook: "UserPromptSubmit", sessionId: "resumed-1", text: "new line" }]);
	});

	test("a file outside the seed set is replayed from the start as before (the control)", async () => {
		const w = world();
		const path = rollout(w, "plain-1", w.open, prompt("one"));
		const { context, posts } = ctx(w, { seedAtEnd: new Set<string>() });
		await scanRolloutFiles([path], context as never);
		expect(posts.map((p) => p.hook)).toEqual(["SessionStart", "UserPromptSubmit"]);
	});

	test("a file that already has saved state continues from its offset, seed set or not", async () => {
		const w = world();
		const path = rollout(w, "known-1", w.open, prompt("seen"));
		const offset = statSync(path).size;
		appendFileSync(path, prompt("unseen"));
		const { context, posts, state } = ctx(w, { seedAtEnd: new Set([path]) });
		state.files[path] = { offset, sessionId: "known-1", cwd: w.open };
		await scanRolloutFiles([path], context as never);
		expect(posts.map((p) => p.text)).toEqual(["unseen"]);
	});

	test("a covered directory: nothing is ever posted for the resumed file, and the exclusion sticks", async () => {
		const w = world();
		const rulesFile = join(w.home, ".agentpulse", "exclude");
		writeFileSync(rulesFile, `${w.secret}\n`, { mode: 0o600 });
		chmodSync(rulesFile, 0o600);
		const at = new Date(Date.parse("2026-02-01T00:00:00Z") + ++version * 1000);
		utimesSync(rulesFile, at, at);
		const rules = createRulesWatch({ home: w.home });
		const path = rollout(w, "secret-1", join(w.secret, "sub"), prompt("history"));
		const { context, posts, state } = ctx(w, { seedAtEnd: new Set([path]), rules });
		await scanRolloutFiles([path], context as never);
		appendFileSync(path, prompt("private"));
		await scanRolloutFiles([path], context as never);
		appendFileSync(path, prompt("more private"));
		await scanRolloutFiles([path], context as never);
		expect(posts).toEqual([]);
		expect(state.files[path]).toMatchObject({ excluded: true });
	});

	test("while the rules are invalid nothing is posted for the resumed file, and that stretch is not replayed afterwards", async () => {
		const w = world();
		writeFileSync(join(w.home, ".agentpulse", "exclude"), "relative/path\n", { mode: 0o600 });
		chmodSync(join(w.home, ".agentpulse", "exclude"), 0o600);
		const rules = createRulesWatch({ home: w.home });
		const path = rollout(w, "paused-1", w.open, prompt("history"));
		const { context, posts } = ctx(w, { seedAtEnd: new Set([path]), rules });
		await scanRolloutFiles([path], context as never);
		appendFileSync(path, prompt("during the pause"));
		await scanRolloutFiles([path], context as never);
		expect(posts).toEqual([]);
		(context as { rules: unknown }).rules = NO_EXCLUDE_RULES;
		await scanRolloutFiles([path], context as never);
		expect(posts).toEqual([]);
		appendFileSync(path, prompt("after"));
		await scanRolloutFiles([path], context as never);
		expect(posts.map((p) => p.text)).toEqual(["after"]);
	});
});

describe("a listed file that has been deleted", () => {
	test("is skipped without an error line, and the rest of the scan carries on", async () => {
		const root = scratch();
		const present = join(root, "rollout-present.jsonl");
		writeFileSync(
			present,
			`${JSON.stringify({ type: "session_meta", payload: { id: "del-1", cwd: root } })}\n`,
		);
		const missing = join(root, "rollout-missing.jsonl");
		const seen: string[] = [];
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			await scanRolloutFiles([missing, present], {
				state: { files: {} },
				callMapsByFile: new Map(),
				serverUrl: "http://x",
				apiKey: null,
				rules: NO_EXCLUDE_RULES,
				homeDir: root,
				fetchImpl: async (_i, init) => {
					seen.push(
						String((JSON.parse(String(init?.body)) as { hook_event_name: string }).hook_event_name),
					);
					return new Response("{}", { status: 200 });
				},
				save: () => {},
			});
			expect(errors).not.toHaveBeenCalled();
		} finally {
			errors.mockRestore();
		}
		expect(seen).toEqual(["SessionStart"]);
	});

	test("any other failure on a file is still reported", async () => {
		const root = scratch();
		const notAFile = join(root, "rollout-dir.jsonl");
		mkdirSync(notAFile);
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			await scanRolloutFiles([notAFile], {
				state: { files: {} },
				callMapsByFile: new Map(),
				serverUrl: "http://x",
				apiKey: null,
				rules: NO_EXCLUDE_RULES,
				homeDir: root,
				save: () => {},
			});
			expect(errors).toHaveBeenCalledTimes(1);
		} finally {
			errors.mockRestore();
		}
	});
});
