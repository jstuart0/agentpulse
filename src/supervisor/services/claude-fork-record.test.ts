import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FORK_RECORD_ENTRIES, createClaudeForkRecord } from "./claude-fork-record.js";

const S = "11111111-1111-4111-8111-111111111111";
const N = "22222222-2222-4222-8222-222222222222";
let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "claude-fork-record-"));
	chmodSync(dir, 0o700);
	file = join(dir, "claude-forks.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const record = () => createClaudeForkRecord({ path: file, log: () => {} });
const entry = (forkId = N, source = S) => ({ forkId, source, mode: "ask" as const, dir: "/work" });

describe("claude fork record", () => {
	test("an entry written is found, privately, and nothing else is", () => {
		const r = record();
		expect(r.write(entry())).toBe(true);
		expect(r.lookup(N)).toMatchObject({ forkId: N, source: S, mode: "ask", dir: "/work" });
		expect(r.isFork(N)).toBe(true);
		expect(r.isFork(S)).toBe(false);
		expect(r.lookup(S)).toBeNull();
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	test("a fork equal to its source, a non-UUID or an unknown mode is refused and nothing is written", () => {
		const r = record();
		expect(r.write({ ...entry(), source: N })).toBe(false);
		expect(r.write(entry("not-a-uuid"))).toBe(false);
		expect(r.write({ ...entry(), mode: "bypass" as never })).toBe(false);
		expect(r.isFork(N)).toBe(false);
	});

	test("an untrusted file (a link, loose permissions, bad JSON) reads as empty", () => {
		const r = record();
		r.write(entry());
		chmodSync(file, 0o644);
		expect(r.isFork(N)).toBe(false);
		rmSync(file);
		writeFileSync(file, "{not json", { mode: 0o600 });
		expect(r.isFork(N)).toBe(false);
		rmSync(file);
		const target = join(dir, "real.json");
		writeFileSync(target, JSON.stringify({ version: 1, entries: [{ ...entry(), at: "x" }] }), {
			mode: 0o600,
		});
		symlinkSync(target, file);
		expect(r.isFork(N)).toBe(false);
	});

	test("hand-edited entries that fail validation are dropped on read", () => {
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				entries: [
					{ ...entry(), mode: "yolo", at: "x" },
					{ ...entry(S, N), at: "x" },
				],
			}),
			{ mode: 0o600 },
		);
		expect(record().isFork(N)).toBe(false);
		expect(record().isFork(S)).toBe(true);
	});

	test("bounded and newest first; a rewrite of the same fork replaces it", () => {
		const r = record();
		for (let i = 0; i < MAX_FORK_RECORD_ENTRIES + 5; i++) {
			const forkId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
			expect(r.write(entry(forkId))).toBe(true);
		}
		expect(r.isFork("00000000-0000-4000-8000-000000000000")).toBe(false);
		expect(
			r.isFork(`00000000-0000-4000-8000-${String(MAX_FORK_RECORD_ENTRIES + 4).padStart(12, "0")}`),
		).toBe(true);
	});

	test("a write into an unwritable place reports false instead of throwing", () => {
		const blocked = join(dir, "blocked");
		mkdirSync(blocked, { mode: 0o500 });
		const r = createClaudeForkRecord({
			path: join(blocked, "sub", "claude-forks.json"),
			log: () => {},
		});
		expect(r.write(entry())).toBe(false);
		chmodSync(blocked, 0o700);
	});

	test("status tells no record, a listed fork, an unlisted id and an unreadable record apart", () => {
		const r = record();
		expect(r.status(N)).toBe("not_fork"); // no file at all
		r.write(entry());
		expect(r.status(N)).toBe("fork");
		expect(r.status(S)).toBe("not_fork");
		chmodSync(file, 0o644);
		expect(r.status(N)).toBe("unknown"); // there, and not to be believed
		rmSync(file);
		writeFileSync(file, "{not json", { mode: 0o600 });
		expect(r.status(N)).toBe("unknown");
		rmSync(file);
		const target = join(dir, "real.json");
		writeFileSync(target, JSON.stringify({ version: 1, entries: [{ ...entry(), at: "x" }] }), {
			mode: 0o600,
		});
		symlinkSync(target, file);
		expect(r.status(N)).toBe("unknown");
	});

	test("a record that can't be believed is not overwritten: the write refuses and leaves it", () => {
		const r = record();
		r.write(entry());
		chmodSync(file, 0o644);
		const before = readFileSync(file, "utf8");
		expect(r.write(entry("33333333-3333-4333-8333-333333333333"))).toBe(false);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	test("a fork whose process is live is kept past the bound; a dead one is dropped", () => {
		const live = new Set<string>();
		const r = createClaudeForkRecord({ path: file, log: () => {}, isLive: (id) => live.has(id) });
		const first = "00000000-0000-4000-8000-000000000000";
		const second = "00000000-0000-4000-8000-000000000001";
		live.add(first);
		r.write(entry(first));
		r.write(entry(second));
		for (let i = 2; i < MAX_FORK_RECORD_ENTRIES + 3; i++) {
			r.write(entry(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`));
		}
		expect(r.isFork(first)).toBe(true);
		expect(r.isFork(second)).toBe(false);
	});
});
