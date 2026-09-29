import { describe, expect, test } from "bun:test";
import {
	EVENT_DUPLICATE_WINDOW_MS,
	areNearInTime,
	getEventSourcePriority,
	normalizeComparableContent,
} from "../../shared/event-authority.js";
import type { EventCategory, EventSource } from "../../shared/types.js";
import { type InsertPlan, type RecentEventRow, planEventInsert } from "./event-dedup.js";
import type { NormalizedEvent } from "./event-normalizer.js";

const FILE_TZ = process.env.TZ;

function withTZ<T>(tz: string, fn: () => T): T {
	const saved = process.env.TZ;
	process.env.TZ = tz;
	try {
		return fn();
	} finally {
		process.env.TZ = saved ?? "UTC";
	}
}

// ── Frozen oracle: the insertNormalizedEvents loop as of 2d4bb8a ─────────────
// Copied verbatim (minus the DB I/O) so the differential test can prove the
// planner reproduces it for content_window on ISO timestamps. Do not "fix"
// this copy; it is the reference.

type OracleComparable = {
	id?: number;
	category: EventCategory | null;
	source: EventSource | string;
	content: string | null;
	createdAt?: string | null;
};

function oracleChooseHigher<T extends { source: EventSource | string; createdAt?: string | null }>(
	left: T,
	right: T,
) {
	const leftPriority = getEventSourcePriority(left.source);
	const rightPriority = getEventSourcePriority(right.source);
	if (leftPriority !== rightPriority) return leftPriority > rightPriority ? left : right;
	return (left.createdAt || "") >= (right.createdAt || "") ? left : right;
}

function oracleIsAuthorityDuplicate(existing: OracleComparable, incoming: OracleComparable) {
	if (existing.category !== "assistant_message" || incoming.category !== "assistant_message")
		return false;
	if (
		!normalizeComparableContent(existing.content) ||
		!normalizeComparableContent(incoming.content)
	)
		return false;
	if (normalizeComparableContent(existing.content) !== normalizeComparableContent(incoming.content))
		return false;
	if (!areNearInTime(existing.createdAt, incoming.createdAt, EVENT_DUPLICATE_WINDOW_MS))
		return false;
	return getEventSourcePriority(existing.source) !== getEventSourcePriority(incoming.source);
}

function oracleKey(event: {
	eventType: string;
	category: string | null;
	source: string;
	content: string | null;
	providerEventType: string | null;
	rawPayload?: Record<string, unknown>;
}) {
	const transcriptId =
		typeof event.rawPayload?.transcript_uuid === "string"
			? event.rawPayload.transcript_uuid
			: typeof event.rawPayload?.transcript_timestamp === "string"
				? event.rawPayload.transcript_timestamp
				: "";
	return [
		event.eventType || "",
		event.category || "",
		event.source || "",
		event.content || "",
		event.providerEventType || "",
		transcriptId,
	].join("::");
}

function oracle(
	recentEvents: RecentEventRow[],
	normalizedEvents: NormalizedEvent[],
	nowIso: string,
) {
	const seen = new Set(recentEvents.map((event) => oracleKey({ ...event })));
	const deleteIds = new Set<number>();
	const retained: Array<NormalizedEvent & { createdAt: string }> = [];
	let contentWindow = 0;
	let authority = 0;
	const authorityPool: OracleComparable[] = recentEvents.map((event) => ({
		...event,
		category: event.category as EventCategory | null,
		source: event.source as EventSource,
		createdAt: event.createdAt,
	}));

	for (const event of normalizedEvents) {
		const normalizedEvent = { ...event, createdAt: nowIso };
		const key = oracleKey(event);
		if (seen.has(key)) {
			contentWindow++;
			continue;
		}

		const strongerExisting = authorityPool.find((existing) => {
			if (!oracleIsAuthorityDuplicate(existing, normalizedEvent)) return false;
			return oracleChooseHigher(existing, normalizedEvent) === existing;
		});
		if (strongerExisting) {
			authority++;
			continue;
		}

		for (const existing of authorityPool) {
			if (!existing.id) continue;
			if (!oracleIsAuthorityDuplicate(existing, normalizedEvent)) continue;
			if (oracleChooseHigher(existing, normalizedEvent) === normalizedEvent) {
				deleteIds.add(existing.id);
			}
		}

		seen.add(key);
		retained.push(normalizedEvent);
		authorityPool.push({
			id: 0,
			category: normalizedEvent.category,
			source: normalizedEvent.source,
			content: normalizedEvent.content,
			createdAt: normalizedEvent.createdAt,
		});
	}
	return { retained, deleteIds, contentWindow, authority };
}

// ── Generators ───────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SOURCES: EventSource[] = [
	"observed_transcript",
	"observed_status",
	"observed_hook",
	"managed_control",
	"launch_system",
];
const CATEGORIES: EventCategory[] = [
	"assistant_message",
	"assistant_message",
	"tool_event",
	"status_update",
];
const EVENT_TYPES = ["AssistantMessage", "TranscriptAssistantMessage", "PreToolUse", "Stop"];
const CONTENTS: Array<string | null> = ["All done.", "all  DONE.", "Running Bash", "", null];
const PROVIDER_TYPES: Array<string | null> = ["Stop", "claude_transcript_text", null];

function pick<T>(rand: () => number, items: readonly T[]): T {
	return items[Math.floor(rand() * items.length)] as T;
}

function randomRawPayload(rand: () => number): Record<string, unknown> {
	const r = rand();
	if (r < 0.2) return { transcript_uuid: pick(rand, ["u1", "u2"]) };
	if (r < 0.3) return { transcript_timestamp: pick(rand, ["t1", "t2"]) };
	return {};
}

function randomEvent(rand: () => number): NormalizedEvent {
	return {
		eventType: pick(rand, EVENT_TYPES),
		category: pick(rand, CATEGORIES),
		source: pick(rand, SOURCES),
		content: pick(rand, CONTENTS),
		isNoise: rand() < 0.2,
		providerEventType: pick(rand, PROVIDER_TYPES),
		toolName: rand() < 0.3 ? "Bash" : null,
		toolInput: null,
		toolResponse: null,
		rawPayload: randomRawPayload(rand),
	};
}

function randomCase(seed: number) {
	const rand = mulberry32(seed);
	const nowMs = Date.UTC(2026, 8, 28, 12, 0, 0) + Math.floor(rand() * 1000);
	const nowIso = new Date(nowMs).toISOString();
	const recentCount = Math.floor(rand() * 8);
	const recent: RecentEventRow[] = [];
	for (let i = 0; i < recentCount; i++) {
		const e = randomEvent(rand);
		const offsetMs = Math.floor(rand() * 32_000) - 1_000;
		recent.push({
			id: recentCount - i,
			eventType: e.eventType,
			category: e.category,
			source: e.source,
			content: e.content,
			providerEventType: e.providerEventType,
			createdAt: rand() < 0.05 ? "garbage" : new Date(nowMs - offsetMs).toISOString(),
		});
	}
	const incoming: NormalizedEvent[] = [];
	const incomingCount = 1 + Math.floor(rand() * 5);
	for (let i = 0; i < incomingCount; i++) incoming.push(randomEvent(rand));
	return { recent, incoming, nowIso };
}

function stripPlanned(plan: InsertPlan) {
	return plan.retained.map(({ dedupKey: _k, deletesIfStored: _d, ...rest }) => rest);
}

function unionDeletes(plan: InsertPlan) {
	return [...new Set(plan.retained.flatMap((row) => row.deletesIfStored))].sort((a, b) => a - b);
}

const CONTENT_WINDOW = { kind: "content_window" } as const;

function assistant(source: EventSource, content = "All done here."): NormalizedEvent {
	return {
		eventType: source === "observed_transcript" ? "TranscriptAssistantMessage" : "AssistantMessage",
		category: "assistant_message",
		source,
		content,
		isNoise: false,
		providerEventType: "Stop",
		toolName: null,
		toolInput: null,
		toolResponse: null,
		rawPayload: {},
	};
}

function recentAssistant(id: number, source: EventSource, createdAt: string): RecentEventRow {
	return {
		id,
		eventType: "AssistantMessage",
		category: "assistant_message",
		source,
		content: "All done here.",
		providerEventType: "Stop",
		createdAt,
	};
}

// ── U1.1 ─────────────────────────────────────────────────────────────────────

describe("planEventInsert: content_window matches the 2d4bb8a loop (U1.1)", () => {
	test("500 seeded cases", () => {
		let authorityCases = 0;
		let windowCases = 0;
		for (let seed = 1; seed <= 500; seed++) {
			const { recent, incoming, nowIso } = randomCase(seed);
			const expected = oracle(recent, incoming, nowIso);
			const plan = planEventInsert({ policy: CONTENT_WINDOW, recent, incoming, nowIso });
			const label = `seed ${seed}`;

			expect(stripPlanned(plan), label).toEqual(expected.retained);
			expect(unionDeletes(plan), label).toEqual([...expected.deleteIds].sort((a, b) => a - b));
			for (const row of plan.retained) expect(row.dedupKey, label).toBeNull();
			expect(plan.drops.contentWindow ?? 0, label).toBe(expected.contentWindow);
			expect(plan.drops.authority ?? 0, label).toBe(expected.authority);

			if (expected.deleteIds.size > 0 || expected.authority > 0) authorityCases++;
			if (expected.contentWindow > 0) windowCases++;
		}
		// Population floor: the generator must actually exercise both drop paths.
		expect(authorityCases).toBeGreaterThanOrEqual(25);
		expect(windowCases).toBeGreaterThanOrEqual(25);
	});

	test("named member: a stronger incoming row deletes the weaker stored one", () => {
		const nowIso = "2026-09-28T12:00:10.000Z";
		const plan = planEventInsert({
			policy: CONTENT_WINDOW,
			recent: [recentAssistant(7, "observed_hook", "2026-09-28T12:00:05.000Z")],
			incoming: [assistant("observed_transcript")],
			nowIso,
		});
		expect(plan.retained).toHaveLength(1);
		expect(plan.retained[0]?.source).toBe("observed_transcript");
		expect(plan.retained[0]?.deletesIfStored).toEqual([7]);
		expect(plan.retained[0]?.createdAt).toBe(nowIso);
	});
});

// ── U1.2 / U1.3 ──────────────────────────────────────────────────────────────

describe("planEventInsert: stored timestamps are UTC regardless of process TZ", () => {
	for (const tz of ["America/New_York", "Asia/Kolkata"]) {
		test(`U1.2 a bare recent SQLite time under ${tz} is near`, () => {
			withTZ(tz, () => {
				const plan = planEventInsert({
					policy: CONTENT_WINDOW,
					recent: [recentAssistant(3, "observed_hook", "2026-09-28 12:00:05")],
					incoming: [assistant("observed_transcript")],
					nowIso: "2026-09-28T12:00:10.000Z",
				});
				expect(plan.retained[0]?.deletesIfStored).toEqual([3]);

				const reverse = planEventInsert({
					policy: CONTENT_WINDOW,
					recent: [recentAssistant(4, "observed_transcript", "2026-09-28 12:00:05")],
					incoming: [assistant("observed_hook")],
					nowIso: "2026-09-28T12:00:10.000Z",
				});
				expect(reverse.retained).toEqual([]);
				expect(reverse.drops.authority).toBe(1);
			});
		});
	}

	test("U1.3 Postgres +00 and -04 forms of one instant plan identically", () => {
		withTZ("America/New_York", () => {
			const nowIso = "2026-09-28T12:00:10.000Z";
			const forms = ["2026-09-28 12:00:05.123456+00", "2026-09-28 08:00:05.123456-04"];
			const plans = forms.map((createdAt) =>
				planEventInsert({
					policy: CONTENT_WINDOW,
					recent: [recentAssistant(9, "observed_hook", createdAt)],
					incoming: [assistant("observed_transcript")],
					nowIso,
				}),
			);
			expect(plans[0]?.retained[0]?.deletesIfStored).toEqual([9]);
			expect(plans[1]).toEqual(plans[0] as InsertPlan);
		});
	});
});

// ── U1.4 / U1.5 ──────────────────────────────────────────────────────────────

describe("planEventInsert: purity", () => {
	test("U1.4 inputs are deep-equal after planning", () => {
		for (let seed = 1000; seed < 1050; seed++) {
			const { recent, incoming, nowIso } = randomCase(seed);
			const recentBefore = structuredClone(recent);
			const incomingBefore = structuredClone(incoming);
			planEventInsert({ policy: CONTENT_WINDOW, recent, incoming, nowIso });
			expect(recent, `seed ${seed}`).toEqual(recentBefore);
			expect(incoming, `seed ${seed}`).toEqual(incomingBefore);
		}
	});

	test("U1.5 input order is preserved in retained", () => {
		const incoming = ["c", "a", "b", "d"].map(
			(content): NormalizedEvent => ({
				eventType: "PreToolUse",
				category: "tool_event",
				source: "observed_hook",
				content,
				isNoise: false,
				providerEventType: "PreToolUse",
				toolName: "Bash",
				toolInput: null,
				toolResponse: null,
				rawPayload: {},
			}),
		);
		const plan = planEventInsert({
			policy: CONTENT_WINDOW,
			recent: [],
			incoming,
			nowIso: "2026-09-28T12:00:00.000Z",
		});
		expect(plan.retained.map((row) => row.content)).toEqual(["c", "a", "b", "d"]);
	});
});

// ── U1.6 ─────────────────────────────────────────────────────────────────────

describe("planEventInsert: window edge (U1.6)", () => {
	const nowIso = "2026-09-28T12:00:15.000Z";

	function deletesFor(createdAt: string) {
		return planEventInsert({
			policy: CONTENT_WINDOW,
			recent: [recentAssistant(5, "observed_hook", createdAt)],
			incoming: [assistant("observed_transcript")],
			nowIso,
		}).retained[0]?.deletesIfStored;
	}

	test("exactly 15,000 ms is near", () => {
		expect(EVENT_DUPLICATE_WINDOW_MS).toBe(15_000);
		expect(deletesFor("2026-09-28T12:00:00.000Z")).toEqual([5]);
		expect(deletesFor("2026-09-28 12:00:00")).toEqual([5]);
	});

	test("15,001 ms is not near", () => {
		expect(deletesFor("2026-09-28T11:59:59.999Z")).toEqual([]);
	});

	test("garbage timestamps are never near", () => {
		expect(deletesFor("garbage")).toEqual([]);
		expect(deletesFor("")).toEqual([]);
		const plan = planEventInsert({
			policy: CONTENT_WINDOW,
			recent: [recentAssistant(5, "observed_hook", "2026-09-28T12:00:15.000Z")],
			incoming: [assistant("observed_transcript")],
			nowIso: "not-a-time",
		});
		expect(plan.retained[0]?.deletesIfStored).toEqual([]);
	});
});

test("TZ sentinel: the file leaves TZ restored", () => {
	expect(process.env.TZ).toBe(FILE_TZ ?? "UTC");
});
