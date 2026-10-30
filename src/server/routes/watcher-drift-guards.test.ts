/**
 * Source-scan guards for three wiring rules of the watcher work. Each reads the
 * non-test source under src/server, has a population floor, a named expected
 * set, and a planted negative showing the scan can see a violation.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SERVER = join(import.meta.dir, "..");

function* walk(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			if (name === "node_modules") continue;
			yield* walk(full);
		} else if (name.endsWith(".ts")) {
			yield full;
		}
	}
}

/** Production source: no tests, no test helpers, no child-process fixtures. */
function production(): Array<{ rel: string; text: string }> {
	const out: Array<{ rel: string; text: string }> = [];
	for (const full of walk(SERVER)) {
		const rel = relative(SERVER, full);
		if (/\.(test|fixture)\.ts$/.test(rel) || rel.startsWith("test-utils/")) continue;
		out.push({ rel, text: readFileSync(full, "utf8") });
	}
	return out;
}

describe("every watcher-config write invalidates the watched-session cache", () => {
	const WRITE_RE = /\.(?:insert|update|delete)\(watcherConfigs\)/g;
	/** Files that write the table, with why each is allowed to. */
	const EXPECTED: Record<string, string> = {
		"services/ai/watcher-config-service.ts": "the writer: every write there invalidates the cache",
		"services/ai/watcher-maintenance.ts":
			"the boot one-shot runs before the runner starts, when the cache is empty",
		"services/ai/proposal-resolution.ts":
			"clears the confirmation columns inside the dispatch transaction; the cache holds only enabled and mode, which that update does not touch",
	};

	test("exactly these files write watcher_configs, with at least five write sites", () => {
		const found: Record<string, number> = {};
		for (const f of production()) {
			const n = f.text.match(WRITE_RE)?.length ?? 0;
			if (n > 0) found[f.rel] = n;
		}
		expect(Object.keys(found).sort()).toEqual(Object.keys(EXPECTED).sort());
		expect(Object.values(found).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(5);
	});

	test("the writer invalidates after each of its writes", () => {
		const text = readFileSync(join(SERVER, "services/ai/watcher-config-service.ts"), "utf8");
		expect(text.match(WRITE_RE)?.length).toBe(4);
		expect(text.match(/invalidateWatchedSessions\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
	});

	test("planted negative: the pattern sees a write in another file", () => {
		expect("await db.update(watcherConfigs).set({ enabled: true })".match(WRITE_RE)).toHaveLength(
			1,
		);
		expect("const rows = await db.select().from(watcherConfigs)".match(WRITE_RE)).toBeNull();
	});
});

describe("events are written through insertNormalizedEvents from a fixed set of files", () => {
	const EXPECTED = [
		"services/ai/ai-events.ts",
		"services/event-processor.ts",
		"services/managed-session-state.ts",
		"services/session-tracker.ts",
		"services/transcript-sync.ts",
	];

	test("exactly five files call it", () => {
		const callers = production()
			.filter((f) => f.text.includes("insertNormalizedEvents("))
			.map((f) => f.rel)
			.sort();
		expect(callers).toEqual(EXPECTED);
		expect(callers.length).toBeGreaterThanOrEqual(5);
	});

	test("only ai-events.ts can write an ai_ category: the other writers' inputs come from the reserved-name guards", () => {
		const aiEvents = readFileSync(join(SERVER, "services/ai/ai-events.ts"), "utf8");
		expect(aiEvents).toContain("insertNormalizedEvents(");
		const normalizer = readFileSync(join(SERVER, "services/event-normalizer.ts"), "utf8");
		expect(normalizer).toContain("ingest_reserved_event_type");
		const managed = readFileSync(join(SERVER, "services/managed-session-state.ts"), "utf8");
		expect(managed).toContain("ReservedEventTypeError");
	});

	test("planted negative: a new caller would change the set", () => {
		const callers = [...EXPECTED, "services/new-writer.ts"].sort();
		expect(callers).not.toEqual(EXPECTED);
	});
});

describe("the routes that act as a person check Origin", () => {
	const FILES = [
		"routes/ai-watcher.ts",
		"routes/ai-inbox.ts",
		"routes/ai-status.ts",
		"routes/channels.ts",
	];
	const EXPECTED = [
		"POST /ai/action-requests/:id/decide",
		"POST /ai/inbox/hitl/:id/decide",
		"POST /ai/proposals/:id/decision",
		"POST /channels/:id/relink",
		"PUT /ai/sessions/:sessionId/watcher",
		"PUT /ai/status",
	];

	/** `METHOD path` of every registration in `text` whose handler calls refuseBadOrigin. */
	function guardedRoutes(text: string): string[] {
		const reg = /\b\w+Router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g;
		const marks: Array<{ at: number; key: string }> = [];
		for (let m = reg.exec(text); m; m = reg.exec(text)) {
			marks.push({ at: m.index, key: `${(m[1] as string).toUpperCase()} ${m[2]}` });
		}
		const out: string[] = [];
		marks.forEach((mark, i) => {
			const end = marks[i + 1]?.at ?? text.length;
			if (text.slice(mark.at, end).includes("refuseBadOrigin(")) out.push(mark.key);
		});
		return out;
	}

	test("exactly these six routes call refuseBadOrigin", () => {
		const found = FILES.flatMap((f) => guardedRoutes(readFileSync(join(SERVER, f), "utf8"))).sort();
		expect(found).toEqual(EXPECTED);
	});

	test("planted negative: a route without the call, and a route with it, are told apart", () => {
		const sample = [
			'aiInboxRouter.post("/a", async (c) => { return c.json({}); });',
			'aiInboxRouter.post("/b", async (c) => { const bad = refuseBadOrigin(c); return bad; });',
		].join("\n");
		expect(guardedRoutes(sample)).toEqual(["POST /b"]);
	});
});
