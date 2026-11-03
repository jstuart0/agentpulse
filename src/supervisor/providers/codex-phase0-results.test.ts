/**
 * Phase 0 (AGEN-87): every spike row has a recorded verdict, and none of them
 * is a stop-and-re-plan outcome. The required list is held here, not read from
 * results.json, so a dropped row fails.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "__fixtures__", "codex-0.163");
const REQUIRED = Array.from({ length: 19 }, (_, i) => `S${i + 1}`);

type Row = { id: string; name: string; verdict: string; outcome: string; observed: string };
const results = JSON.parse(readFileSync(join(DIR, "results.json"), "utf8")) as {
	codexVersion: string;
	transport: string;
	rows: Row[];
};

describe("phase 0 results", () => {
	test("row ids equal S1 to S19", () => {
		expect(results.rows.map((r) => r.id).sort()).toEqual([...REQUIRED].sort());
	});

	test("each row has a measured or not_triggerable verdict and an observation", () => {
		for (const row of results.rows) {
			expect(["measured", "not_triggerable"], row.id).toContain(row.verdict);
			expect(row.observed.length, row.id).toBeGreaterThan(10);
			expect(row.outcome.length, row.id).toBeGreaterThan(0);
		}
	});

	test("no row is at stop_and_re_plan", () => {
		for (const row of results.rows) expect(row.outcome, row.id).not.toBe("stop_and_re_plan");
	});

	test("S4 has a real fileChange fixture with the diff before the request", () => {
		const frames = readFileSync(join(DIR, "file-change-accept.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).frame);
		const started = frames.findIndex(
			(f) => f.method === "item/started" && f.params?.item?.type === "fileChange",
		);
		const request = frames.findIndex((f) => f.method === "item/fileChange/requestApproval");
		expect(started).toBeGreaterThanOrEqual(0);
		expect(request).toBeGreaterThan(started);
		expect(frames[started].params.item.changes[0].diff.length).toBeGreaterThan(0);
	});

	test("S19 records no_listener, not a second client that can answer", () => {
		const row = results.rows.find((r) => r.id === "S19")!;
		expect(row.outcome).toBe("no_listener");
		expect(row.outcome).not.toMatch(/answer/);
	});

	test("the run was over stdio on the version the fixtures name", () => {
		expect(results.transport).toBe("stdio");
		expect(results.codexVersion).toBe("0.163.0");
	});
});
