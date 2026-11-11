/**
 * AGEN-146: the writers of stored agent text, pinned. A new writer of `events` rows or of a session's
 * text fields fails here until it is redacted (or named, with the reason it is not) in the inventory
 * below and in CLAUDE.md. Source scans, like the other guards in this tree.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SRC = join(ROOT, "src");

async function sourceFiles(): Promise<string[]> {
	const out: string[] = [];
	for await (const file of new Glob("**/*.ts").scan({ cwd: SRC })) {
		if (/\.test\.ts$|\.d\.ts$|\/test-utils\/|\/__fixtures__\/|\/__test|\.fixture\.ts$/.test(file))
			continue;
		out.push(file);
	}
	return out.sort();
}

const read = (file: string): string => readFileSync(join(SRC, file), "utf8");

async function filesWith(pattern: RegExp): Promise<Map<string, number>> {
	const found = new Map<string, number>();
	for (const file of await sourceFiles()) {
		const matches = read(file).match(pattern);
		if (matches) found.set(relative("", file), matches.length);
	}
	return found;
}

/** The text of `export async function <name>` up to its closing brace at column 0. */
function functionBody(source: string, name: string): string {
	const start = source.search(new RegExp(`export (?:async )?function ${name}\\b`));
	expect(start, `${name} exists`).toBeGreaterThanOrEqual(0);
	const end = source.indexOf("\n}\n", start);
	return source.slice(start, end + 3);
}

describe("the writers of events rows", () => {
	test("planEventInsert( is called at exactly the three insert entry points", async () => {
		const found = await filesWith(/\bplanEventInsert\(/g);
		expect(Object.fromEntries(found)).toEqual({
			"server/services/event-dedup.ts": 1, // the definition
			"server/services/event-processor.ts": 3,
		});
	});

	test("persistEvents( is called only from the processor and the Codex approvals service (fixed text)", async () => {
		const found = await filesWith(/\bpersistEvents\(/g);
		expect([...found.keys()].sort()).toEqual([
			"server/services/codex-approvals.ts",
			"server/services/event-processor.ts",
		]);
	});

	test(".insert(events) writers are the processor and two fixed-text system rows", async () => {
		const found = await filesWith(/\.insert\(events\)/g);
		expect([...found.keys()].sort()).toEqual([
			"server/services/claude-takeover-settle.ts", // first row of a takeover: its source name is redacted (D9)
			"server/services/control-actions.ts", // SESSION_RESUMED_CONTENT, fixed
			"server/services/event-processor.ts",
		]);
	});

	test("every insert entry point redacts before it plans", () => {
		const processor = read("server/services/event-processor.ts");
		for (const name of ["insertNormalizedEvents", "insertHookEvents", "insertManagedEvents"]) {
			const body = functionBody(processor, name);
			expect(body, `${name} redacts`).toContain("redactEventsForStorage(");
			expect(
				body.indexOf("redactEventsForStorage("),
				`${name}: redaction comes first`,
			).toBeLessThan(body.indexOf("planEventInsert("));
		}
	});

	test("insertManagedEvents redacts outside its transaction and after the replay pre-check", () => {
		const body = functionBody(read("server/services/event-processor.ts"), "insertManagedEvents");
		expect(body.indexOf("managedDeliveryReceipts")).toBeLessThan(
			body.indexOf("redactEventsForStorage("),
		);
		expect(body.indexOf("redactEventsForStorage(")).toBeLessThan(body.indexOf("withTransaction("));
	});

	test("the hook path normalizes only a prepared payload", () => {
		const processor = read("server/services/event-processor.ts");
		const calls = [...processor.matchAll(/normalizeHookEvent\(\s*([^,)\s]+)/g)].map((m) => m[1]);
		expect(calls.length).toBeGreaterThanOrEqual(2);
		for (const arg of calls) expect(arg).toMatch(/^(?:stored|preparedAck)\.payload$/);
		expect(processor).toContain("storableFromPrepared(");
	});

	test("the legacy observer branch passes a branded value, not a flag", () => {
		const processor = read("server/services/event-processor.ts");
		expect(processor).toMatch(/insertNormalizedEvents\(sessionId, normalizedEvents\)/);
		expect(processor).toMatch(/const normalizedEvents = storableFromPrepared\(/);
	});

	test("a session id that is a secret is refused before the session row is read or created", () => {
		const body = functionBody(read("server/services/event-processor.ts"), "processHookEvent");
		expect(body.indexOf("refuseSessionIdForStorage(")).toBeGreaterThan(0);
		expect(body.indexOf("refuseSessionIdForStorage(")).toBeLessThan(
			body.indexOf(".insert(sessions)"),
		);
	});
});

describe("the writers of a session's text fields", () => {
	// file -> number of write sites, with the verdict for each file.
	const INVENTORY: Record<string, { sites: number; redaction: RegExp; why: string }> = {
		"server/services/event-processor.ts": {
			sites: 5, // model, currentTask (task event), gitBranch, currentTask and planSummary (status)
			redaction: /redactShortForStorage\(|redactTextForStorage\(|stored\.payload\./,
			why: "redacted (D9)",
		},
		"server/services/managed-session-state.ts": {
			sites: 1,
			redaction: /withRedactedNames\(/,
			why: "titles and model redacted on entry (D9)",
		},
		"server/services/session-tracker.ts": {
			sites: 3, // rename (a person), native name (redacted), reset to the stored native name (already redacted)
			redaction: /redactShortForStorage\(/,
			why: "native name redacted; a manual rename is a person's own words",
		},
		"server/services/launch-dispatch.ts": {
			sites: 1,
			redaction: /desiredDisplayName/,
			why: "a launch's desired name is the operator's own input",
		},
	};

	test("every write of model, currentTask, planSummary, gitBranch or displayName is in the inventory", async () => {
		const pattern =
			/\b(?:updates|sessionUpdates)\.(?:model|currentTask|planSummary|gitBranch|displayName)\s*=|\.set\(\{\s*displayName:/g;
		const found = await filesWith(pattern);
		// Not session rows: an LLM provider's own `model` setting.
		found.delete("server/services/ai/providers-service.ts");
		const actual = Object.fromEntries(found);
		const expected = Object.fromEntries(
			Object.entries(INVENTORY).map(([file, v]) => [file, v.sites]),
		);
		expect(actual).toEqual(expected);
	});

	test("each inventoried file redacts, or says why it need not", () => {
		for (const [file, entry] of Object.entries(INVENTORY)) {
			expect(read(file), `${file}: ${entry.why}`).toMatch(entry.redaction);
		}
	});

	test("the takeover's first row redacts the interpolated source name", () => {
		const settle = read("server/services/claude-takeover-settle.ts");
		expect(settle).toMatch(/forkFirstRowContent\([\s\S]{0,200}redactShortForStorage\(/);
		expect(settle).toMatch(/forkDisplayName\([\s\S]{0,200}redactShortForStorage\(/);
	});

	test("cwd and transcript_path are left as written, on purpose", () => {
		// Operational identity: the takeover compares directories, the host's exclude rules judge them
		// and transcript sync reads the path. Masking would break each. Named residual (D9). They are
		// still made storable (AGEN-39): a path with U+0000 names no real file.
		const module = read("server/services/ingest-redaction.ts");
		expect(module).toMatch(/VERBATIM_KEYS[\s\S]{0,120}"cwd"[\s\S]{0,40}"transcript_path"/);
	});
});

describe("storable text (AGEN-39)", () => {
	test("the normalizer never cuts with a bare slice, which can split a surrogate pair", () => {
		expect(read("server/services/event-normalizer.ts")).not.toMatch(/\.slice\(0,/);
	});

	test("every supervisor agent POST reads its body through the one bounded well-formed pass", () => {
		const source = read("server/routes/supervisors.ts");
		const start = source.indexOf("const supervisorsAgentRouter");
		const end = source.indexOf("export { supervisorsAgentRouter");
		expect(start).toBeGreaterThanOrEqual(0);
		const agent = source.slice(start, end);
		const blocks = agent
			.split(/(?=supervisorsAgentRouter\.post\()/)
			.filter((b) => b.startsWith("supervisorsAgentRouter.post("));
		expect(blocks.length).toBeGreaterThanOrEqual(11);
		// routes that take no body at all
		const bodyless = ["/supervisors/:id/launches/claim", "/supervisors/:id/control-actions/claim"];
		for (const block of blocks) {
			const path = block.match(/post\(\s*"([^"]+)"/)?.[1] ?? "";
			if (path.includes(":"))
				expect(block, `${path} checks its path parameters`).toContain("wellFormedPathParams");
			if (bodyless.includes(path)) continue;
			expect(block, `${path} reads its body through the bounded pass`).toMatch(
				/parseJsonObject\(|readHeartbeatBody\(/,
			);
			expect(block, `${path} doesn't parse the body on its own`).not.toMatch(/c\.req\.json\(/);
		}
		// the pass itself, and the receipts staying on raw text
		expect(source).toMatch(/function parseJsonObject[\s\S]{0,800}boundedWellFormedValue\(/);
		expect(read("server/services/supervisor-exclude-state.ts")).toContain(
			"boundedWellFormedValue(",
		);
	});

	test("every writer of host or agent text imports the one storage rule", () => {
		for (const file of [
			"server/services/ingest-redaction.ts",
			"server/services/event-normalizer.ts",
			"server/services/event-processor.ts",
			"server/services/managed-session-state.ts",
			"server/routes/supervisors.ts",
			"server/services/ask/ask-service.ts",
			"server/services/codex-approval-presentation.ts",
		]) {
			expect(read(file), file).toMatch(/from "(?:\.\.?\/)+(?:services\/)?storage-text\.js"/);
		}
	});
});
