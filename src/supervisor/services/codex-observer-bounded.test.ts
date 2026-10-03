/**
 * The Codex observer reads a rollout file in bounded passes: each pass takes at
 * most MAX_PASS_BYTES and MAX_PASS_LINES, advances the saved offset by exactly
 * the bytes of the complete lines it replayed, and leaves the rest for the next
 * scan. A line still being written waits. Two scans never overlap.
 *
 * Every case uses a throwaway home and an injected fetch.
 */
import { afterAll, describe, expect, test } from "bun:test";
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

const { MAX_PASS_BYTES, MAX_PASS_LINES, processRolloutFile, singleFlight } = await import(
	"./codex-observer.js"
);
type FileState = Awaited<ReturnType<typeof processRolloutFile>>;
type Rules = Parameters<typeof processRolloutFile>[7];

const made: string[] = [];
afterAll(() => {
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ap-observer-bounded-")));
	made.push(dir);
	return dir;
}

type Post = { hook: string; text?: string; deliveryId: string };

function recorder() {
	const posts: Post[] = [];
	const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const body = JSON.parse(String(init?.body ?? "{}")) as {
			hook_event_name: string;
			prompt?: string;
		};
		const headers = new Headers(init?.headers);
		posts.push({
			hook: body.hook_event_name,
			text: body.prompt,
			deliveryId: headers.get("x-agentpulse-delivery-id") ?? "",
		});
		return new Response("{}", { status: 200 });
	};
	return { posts, fetchImpl };
}

const metaLine = (id: string, cwd: string, eol = "\n") =>
	`${JSON.stringify({ type: "session_meta", payload: { id, cwd, model: "m" } })}${eol}`;
const promptLine = (text: string, eol = "\n") =>
	`${JSON.stringify({
		type: "response_item",
		payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
	})}${eol}`;

/** Runs passes until the saved offset reaches the end of the file; returns every pass. */
async function drain(
	path: string,
	home: string,
	rules: Rules,
	fetchImpl: ReturnType<typeof recorder>["fetchImpl"],
	maxPasses = 5000,
) {
	const passes: { offset: number; before: number; state: FileState }[] = [];
	let state: FileState | undefined;
	const callMap = new Map<string, string>();
	for (let i = 0; i < maxPasses; i++) {
		const before = state?.offset ?? 0;
		state = await processRolloutFile(
			path,
			state,
			"http://x",
			null,
			callMap,
			fetchImpl,
			home,
			rules,
		);
		passes.push({ offset: state.offset, before, state });
		if (state.offset === statSync(path).size) break;
	}
	return passes;
}

/** Builds a file from lines; returns the byte offset at the end of each line. */
function writeLines(path: string, lines: string[]): number[] {
	const ends: number[] = [];
	let total = 0;
	for (const line of lines) {
		total += Buffer.byteLength(line, "utf8");
		ends.push(total);
	}
	writeFileSync(path, lines.join(""));
	return ends;
}

const filler = (n: number) => "x".repeat(n);
const mixed = (i: number) => `${i}|é日😀|${filler(i % 7)}`;

describe("a long rollout is replayed in bounded passes", () => {
	test("a 50 MB rollout is consumed over several passes: every event once, in order, offsets exact", async () => {
		const dir = scratch();
		const path = join(dir, "rollout-big.jsonl");
		const lineCount = 5000;
		const lines = [metaLine("big-1", dir)];
		for (let i = 0; i < lineCount; i++) lines.push(promptLine(`${i}:${filler(10_000)}`));
		const ends = writeLines(path, lines);
		expect(statSync(path).size).toBeGreaterThan(50_000_000);

		const { posts, fetchImpl } = recorder();
		const passes = await drain(path, dir, NO_EXCLUDE_RULES, fetchImpl);

		expect(passes.length).toBeGreaterThan(40);
		const validOffsets = new Set(ends);
		let previous = 0;
		for (const pass of passes) {
			expect(validOffsets.has(pass.offset)).toBe(true);
			expect(pass.offset).toBeGreaterThan(previous);
			expect(pass.offset - previous).toBeLessThanOrEqual(MAX_PASS_BYTES);
			previous = pass.offset;
		}
		expect(previous).toBe(statSync(path).size);

		const prompts = posts.filter((p) => p.hook === "UserPromptSubmit");
		expect(prompts.length).toBe(lineCount);
		for (let i = 0; i < lineCount; i++) {
			expect(prompts[i]?.text?.startsWith(`${i}:`)).toBe(true);
		}
		expect(posts[0]?.hook).toBe("SessionStart");
		expect(new Set(posts.map((p) => p.deliveryId)).size).toBe(posts.length);
	}, 120_000);

	test("many short lines are capped by line count, not bytes", async () => {
		const dir = scratch();
		const path = join(dir, "rollout-short.jsonl");
		const lines = [metaLine("short-1", dir)];
		for (let i = 0; i < 2300; i++) lines.push(promptLine(`n${i}`));
		const ends = writeLines(path, lines);

		const { posts, fetchImpl } = recorder();
		const passes = await drain(path, dir, NO_EXCLUDE_RULES, fetchImpl);

		expect(passes.length).toBe(Math.ceil(lines.length / MAX_PASS_LINES));
		let linesBefore = 0;
		for (const pass of passes) {
			const index = ends.indexOf(pass.offset);
			expect(index).toBeGreaterThanOrEqual(0);
			expect(index + 1 - linesBefore).toBeLessThanOrEqual(MAX_PASS_LINES);
			linesBefore = index + 1;
		}
		expect(posts.filter((p) => p.hook === "UserPromptSubmit").map((p) => p.text)).toEqual(
			Array.from({ length: 2300 }, (_, i) => `n${i}`),
		);
	});

	test("one line larger than the byte cap is still consumed whole", async () => {
		const dir = scratch();
		const path = join(dir, "rollout-huge-line.jsonl");
		const lines = [
			metaLine("huge-1", dir),
			promptLine("before"),
			promptLine(filler(MAX_PASS_BYTES + 400_000)),
			promptLine("after"),
		];
		writeLines(path, lines);
		const { posts, fetchImpl } = recorder();
		const passes = await drain(path, dir, NO_EXCLUDE_RULES, fetchImpl, 20);
		expect(passes.at(-1)?.offset).toBe(statSync(path).size);
		const texts = posts.filter((p) => p.hook === "UserPromptSubmit").map((p) => p.text?.length);
		expect(texts).toEqual([6, MAX_PASS_BYTES + 400_000, 5]);
	});
});

describe("the cap can fall anywhere in a line", () => {
	for (const eol of ["\n", "\r\n"]) {
		for (let shift = 0; shift < 9; shift++) {
			test(`${JSON.stringify(eol)} line endings, multi-byte text, cap shifted by ${shift} bytes`, async () => {
				const dir = scratch();
				const path = join(dir, "rollout-cap.jsonl");
				const lines = [metaLine("cap-1", dir, eol), promptLine(`0|${filler(shift)}`, eol)];
				for (let i = 1; i < 600; i++) lines.push(promptLine(`${mixed(i)}${filler(3000)}`, eol));
				const ends = writeLines(path, lines);

				const { posts, fetchImpl } = recorder();
				const passes = await drain(path, dir, NO_EXCLUDE_RULES, fetchImpl);

				const valid = new Set(ends);
				for (const pass of passes) expect(valid.has(pass.offset)).toBe(true);
				expect(passes.length).toBeGreaterThan(1);
				const prompts = posts.filter((p) => p.hook === "UserPromptSubmit");
				expect(prompts.length).toBe(600);
				expect(prompts[0]?.text).toBe(`0|${filler(shift)}`);
				for (let i = 1; i < 600; i++) expect(prompts[i]?.text).toBe(`${mixed(i)}${filler(3000)}`);
				expect(new Set(posts.map((p) => p.deliveryId)).size).toBe(posts.length);
			});
		}
	}

	test("a pass that ends between the CR and the LF leaves that line for the next pass", async () => {
		const dir = scratch();
		const path = join(dir, "rollout-crlf.jsonl");
		const meta = metaLine("crlf-1", dir, "\r\n");
		const metaBytes = Buffer.byteLength(meta);
		// The first prompt line is sized so the cap lands right after its CR.
		const probe = Buffer.byteLength(promptLine("", "\r"));
		const second = promptLine(filler(MAX_PASS_BYTES - metaBytes - probe), "\r\n");
		expect(metaBytes + Buffer.byteLength(second) - 1).toBe(MAX_PASS_BYTES);
		writeLines(path, [meta, second, promptLine("tail", "\r\n")]);

		const { posts, fetchImpl } = recorder();
		const passes = await drain(path, dir, NO_EXCLUDE_RULES, fetchImpl);
		expect(passes[0]?.offset).toBe(metaBytes);
		expect(posts.filter((p) => p.hook === "UserPromptSubmit").map((p) => p.text?.length)).toEqual([
			MAX_PASS_BYTES - metaBytes - probe,
			4,
		]);
	});

	test("a pass that ends inside a four-byte character does not corrupt the text", async () => {
		const dir = scratch();
		const path = join(dir, "rollout-emoji.jsonl");
		const meta = metaLine("emoji-1", dir);
		const metaBytes = Buffer.byteLength(meta);
		// Bytes of the line before its text: the line minus the emoji, the closing JSON and the LF.
		const base = Buffer.byteLength(promptLine("😀")) - 4 - Buffer.byteLength('"}]}}\n');
		// Two bytes of the emoji fall before the cap, two after.
		const pad = MAX_PASS_BYTES - metaBytes - base - 2;
		const text = `${filler(pad)}😀`;
		const line = promptLine(text);
		const emojiStart = Buffer.from(meta + line).indexOf("😀");
		expect(MAX_PASS_BYTES - emojiStart).toBe(2);
		writeLines(path, [meta, line, promptLine("tail")]);

		const { posts, fetchImpl } = recorder();
		await drain(path, dir, NO_EXCLUDE_RULES, fetchImpl);
		expect(posts.filter((p) => p.hook === "UserPromptSubmit").map((p) => p.text)).toEqual([
			text,
			"tail",
		]);
	});
});

describe("a line still being written waits", () => {
	test("a partial last line is not replayed or counted; the rest of it arrives later and posts once", async () => {
		const dir = scratch();
		const path = join(dir, "rollout-partial.jsonl");
		const lines = [metaLine("part-1", dir), promptLine("one"), promptLine("two é日😀")];
		const ends = writeLines(path, lines);
		const whole = Buffer.from(promptLine("three 😀 é"));
		// Cut inside the four-byte character.
		const cut = whole.indexOf(Buffer.from("😀")) + 2;
		appendFileSync(path, whole.subarray(0, cut));

		const { posts, fetchImpl } = recorder();
		const callMap = new Map<string, string>();
		const first = await processRolloutFile(
			path,
			undefined,
			"http://x",
			null,
			callMap,
			fetchImpl,
			dir,
			NO_EXCLUDE_RULES,
		);
		expect(first.offset).toBe(ends[2] as number);
		expect(posts.filter((p) => p.hook === "UserPromptSubmit").map((p) => p.text)).toEqual([
			"one",
			"two é日😀",
		]);

		const again = await processRolloutFile(
			path,
			first,
			"http://x",
			null,
			callMap,
			fetchImpl,
			dir,
			NO_EXCLUDE_RULES,
		);
		expect(again.offset).toBe(first.offset);
		expect(posts).toHaveLength(3);

		appendFileSync(path, whole.subarray(cut));
		const last = await processRolloutFile(
			path,
			again,
			"http://x",
			null,
			callMap,
			fetchImpl,
			dir,
			NO_EXCLUDE_RULES,
		);
		expect(last.offset).toBe(statSync(path).size);
		expect(posts.filter((p) => p.hook === "UserPromptSubmit").map((p) => p.text)).toEqual([
			"one",
			"two é日😀",
			"three 😀 é",
		]);
	});
});

describe("scans never overlap", () => {
	test("a tick that arrives while a scan is running does nothing, and the next tick after it runs", async () => {
		let started = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const guarded = singleFlight(async () => {
			started++;
			await gate;
		});
		const first = guarded();
		const second = guarded();
		const third = guarded();
		expect(started).toBe(1);
		release();
		await Promise.all([first, second, third]);
		expect(started).toBe(1);
		await guarded();
		expect(started).toBe(2);
	});

	test("a scan that throws does not wedge the guard", async () => {
		let started = 0;
		const guarded = singleFlight(async () => {
			started++;
			throw new Error("boom");
		});
		await expect(guarded()).rejects.toThrow("boom");
		await expect(guarded()).rejects.toThrow("boom");
		expect(started).toBe(2);
	});
});

describe("the exclude decision still comes before any post, however the file is chunked", () => {
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
		const rulesFile = join(home, ".agentpulse", "exclude");
		const writeRules = (rulesLines: string[]) => {
			writeFileSync(rulesFile, `${rulesLines.join("\n")}\n`, { mode: 0o600 });
			chmodSync(rulesFile, 0o600);
			const at = new Date(Date.parse("2026-02-01T00:00:00Z") + ++version * 1000);
			utimesSync(rulesFile, at, at);
		};
		return { root, home, secret, open, writeRules, rules: createRulesWatch({ home }) };
	}

	test("a covered file posts nothing in any pass and ends excluded", async () => {
		const w = world();
		w.writeRules([w.secret]);
		const path = join(w.root, "rollout-secret.jsonl");
		const lines = [metaLine("sec-1", w.secret)];
		for (let i = 0; i < 2000; i++) lines.push(promptLine(`private ${i} ${filler(2000)}`));
		writeLines(path, lines);
		const { posts, fetchImpl } = recorder();
		const passes = await drain(path, w.home, w.rules, fetchImpl, 50);
		expect(posts).toEqual([]);
		expect(passes.at(-1)?.state.excluded).toBe(true);
		expect(passes.at(-1)?.offset).toBe(statSync(path).size);
	});

	test("a session_meta in a covered directory deep in the file stops the posts from that line on", async () => {
		const w = world();
		w.writeRules([w.secret]);
		const path = join(w.root, "rollout-mixed.jsonl");
		const lines = [metaLine("mix-open", w.open)];
		for (let i = 0; i < 700; i++) lines.push(promptLine(`open ${i}`));
		lines.push(metaLine("mix-secret", w.secret));
		for (let i = 0; i < 700; i++) lines.push(promptLine(`secret ${i}`));
		writeLines(path, lines);
		const { posts, fetchImpl } = recorder();
		const passes = await drain(path, w.home, w.rules, fetchImpl, 50);
		const texts = posts.filter((p) => p.hook === "UserPromptSubmit").map((p) => p.text);
		expect(texts).toEqual(Array.from({ length: 700 }, (_, i) => `open ${i}`));
		expect(posts.some((p) => (p.text ?? "").startsWith("secret"))).toBe(false);
		expect(passes.at(-1)?.state.excluded).toBe(true);
	});

	test("while the rules are invalid the offset advances pass by pass and nothing is posted", async () => {
		const w = world();
		writeFileSync(join(w.home, ".agentpulse", "exclude"), "relative/path\n", { mode: 0o600 });
		const path = join(w.root, "rollout-paused.jsonl");
		const lines = [metaLine("pause-1", w.open)];
		for (let i = 0; i < 1200; i++) lines.push(promptLine(`p${i}`));
		writeLines(path, lines);
		const { posts, fetchImpl } = recorder();
		const passes = await drain(path, w.home, w.rules, fetchImpl, 50);
		expect(posts).toEqual([]);
		expect(passes.length).toBeGreaterThan(1);
		expect(passes.at(-1)?.offset).toBe(statSync(path).size);
	});
});
