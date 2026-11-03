/**
 * `events.occurred_at` is what a supervisor SAYS the event happened. It is unauthenticated
 * input, kept only for display, and no decision may read it: not ordering, retention,
 * liveness, ownership, attribution or auth. This scans the server tree: the files that decide
 * those things must not mention it, and the only files that do are the schema, the one write
 * path and the DTO.
 */
import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const MENTION = /occurredAt|occurred_at/;
const serverRoot = join(import.meta.dir, "..");

/** Comments stripped, so prose about the column isn't a reader. */
const withoutComments = (text: string) =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Directories and filename families where a decision about a session or a host is made. */
const DECIDES = [
	/^auth\//,
	/^services\/session-[^/]*\.ts$/,
	/^services\/supervisor-[^/]*\.ts$/,
	/^services\/retention[^/]*\.ts$/,
	/^services\/authorization[^/]*\.ts$/,
];

/** Where the column is declared, written, mapped to the DTO or backfilled in the legacy init. */
const ALLOWED = new Set([
	"db/schema/core/events.ts",
	"db/client.ts",
	"services/event-normalizer.ts",
	"services/event-processor.ts",
	"services/event-dto.ts",
	"services/managed-session-state.ts",
]);

describe("occurred_at has no readers that decide anything", () => {
	test("the matcher flags a reader (positive control)", () => {
		expect(MENTION.test("if (row.occurredAt < cutoff) expire(row)")).toBe(true);
		expect(MENTION.test("ORDER BY occurred_at")).toBe(true);
		expect(MENTION.test("createdAt")).toBe(false);
	});

	test("in the tree: no deciding file mentions it, and every mention is in the allowlist", async () => {
		const files = (await readdir(serverRoot, { recursive: true })).filter(
			(n) => n.endsWith(".ts") && !n.endsWith(".test.ts"),
		);
		// Population floor, with named members from each deciding family.
		expect(files.length).toBeGreaterThan(100);
		for (const named of [
			"auth/middleware.ts",
			"services/authorization.ts",
			"services/session-ownership.ts",
			"services/session-tracker.ts",
			"services/supervisor-registry.ts",
			"services/supervisor-liveness.ts",
			"services/retention-service.ts",
		]) {
			expect(files, named).toContain(named);
		}

		const deciding = files.filter((f) => DECIDES.some((pattern) => pattern.test(f)));
		expect(deciding.length).toBeGreaterThan(10);

		const mentioning: string[] = [];
		for (const file of files) {
			const text = withoutComments(await readFile(join(serverRoot, file), "utf8"));
			if (MENTION.test(text)) mentioning.push(file);
		}
		expect(mentioning.filter((f) => DECIDES.some((p) => p.test(f)))).toEqual([]);
		expect(mentioning.filter((f) => !ALLOWED.has(f)).sort()).toEqual([]);
		// The allowlist is accounted for: each entry really mentions it.
		for (const allowed of ALLOWED) expect(mentioning, allowed).toContain(allowed);
	});
});
