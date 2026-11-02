/**
 * The offline outbox store (AGEN-83 phase 3), against a real filesystem in a temp home, with an
 * injected clock and an injectable writer. Nothing here touches a network: the module has none.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFileAtomicNoFollow } from "../../shared/private-file.js";
import type { ManagedSessionStateInput } from "../../shared/types.js";
import {
	OUTBOX_LIMITS,
	type OutboxEntry,
	type OutboxLimits,
	type ReportOutbox,
	createReportOutbox,
	foldStateReports,
	outboxDirName,
} from "./report-outbox.js";

const SUPERVISOR = "sup-1";
const T0 = Date.parse("2026-11-01T12:00:00Z");
const HOUR = 3_600_000;

let home: string;
let clock: number;
const logs: string[] = [];

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "ap-outbox-"));
	clock = T0;
	logs.length = 0;
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const rootDir = () => join(home, ".agentpulse", "supervisor-outbox");
const sessionDir = (sessionId: string) => join(rootDir(), outboxDirName(sessionId));
const entryFile = (sessionId: string, seq: number) =>
	join(sessionDir(sessionId), `${String(seq).padStart(16, "0")}.json`);

function open(
	over: {
		limits?: Partial<OutboxLimits>;
		writer?: (path: string, text: string) => void;
		supervisorId?: string;
	} = {},
): ReportOutbox {
	return createReportOutbox({
		home,
		supervisorId: over.supervisorId ?? SUPERVISOR,
		now: () => clock,
		log: (line) => logs.push(line),
		limits: over.limits,
		writer: over.writer,
	});
}

const stateBody = (sessionId: string, extra: Record<string, unknown> = {}) =>
	JSON.stringify({ sessionId, ...extra });
const eventsBody = (n: number, tag = "e") =>
	JSON.stringify({
		events: Array.from({ length: n }, (_, i) => ({
			eventType: "ManagedProbe",
			category: "system_event",
			content: `${tag}-${i}`,
		})),
	});

function putState(box: ReportOutbox, sessionId: string, extra: Record<string, unknown> = {}) {
	return box.append(sessionId, {
		kind: "state",
		body: stateBody(sessionId, extra),
		attempted: false,
	});
}
function putEvents(box: ReportOutbox, sessionId: string, n = 1, tag = "e", attempted = false) {
	return box.append(sessionId, {
		kind: "events",
		body: eventsBody(n, tag),
		attempted,
		deliveryId: attempted ? `fixed-${tag}-12345678` : undefined,
	});
}

function drain(box: ReportOutbox, sessionId: string): OutboxEntry[] {
	const out: OutboxEntry[] = [];
	for (;;) {
		const h = box.head(sessionId);
		if (!h || h === "held") return out;
		out.push(h);
		box.remove(sessionId, h.seq, "delivered");
	}
}

/** Plants an entry file as a previous run (or an attacker) could have left it. */
function plant(
	sessionId: string,
	seq: number,
	content: Record<string, unknown> | string,
	supervisorId = SUPERVISOR,
) {
	const dir = sessionDir(sessionId);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		chmodSync(join(home, ".agentpulse"), 0o700);
		chmodSync(rootDir(), 0o700);
		const meta = join(dir, "session.json");
		writeFileSync(meta, JSON.stringify({ v: 1, sessionId, supervisorId }), { mode: 0o600 });
		chmodSync(meta, 0o600);
	}
	const file = entryFile(sessionId, seq);
	const text =
		typeof content === "string"
			? content
			: JSON.stringify({
					v: 1,
					sessionId,
					seq,
					kind: "events",
					queuedAt: new Date(T0).toISOString(),
					attempted: false,
					body: eventsBody(1, `p${seq}`),
					deliveryId: `plant-${seq}-12345678`,
					...content,
				});
	writeFileSync(file, text, { mode: 0o600 });
	chmodSync(file, 0o600);
}

describe("FIFO, restart and the healthy host", () => {
	test("a session's entries come out in the order they went in, across kinds", async () => {
		const box = open();
		await box.ready();
		putState(box, "s1", { status: "active" });
		putEvents(box, "s1", 1, "a");
		putState(box, "s1", { status: "completed" });
		putEvents(box, "s1", 2, "b");
		const out = drain(box, "s1");
		expect(out.map((e) => e.kind)).toEqual(["state", "events", "state", "events"]);
		expect(out.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
		expect(box.hasPending("s1")).toBe(false);
		expect(existsSync(sessionDir("s1")), "an emptied session leaves no directory").toBe(false);
	});

	test("a healthy host creates no root at all, and nothing is read or written until the first append", async () => {
		const box = open();
		await box.ready();
		expect(box.hasPending("s1")).toBe(false);
		expect(box.head("s1")).toBeNull();
		expect(box.sessions()).toEqual([]);
		expect(box.summary()).toEqual({
			pending: 0,
			oldestPendingAt: null,
			lastFlushAt: null,
			lastFlushDelivered: 0,
			lastFlushLost: 0,
		});
		expect(existsSync(join(home, ".agentpulse"))).toBe(false);
		putState(box, "s1");
		expect(existsSync(rootDir())).toBe(true);
	});

	test("after a restart the same sessions, ids, seqs and summary come back", async () => {
		const a = open();
		await a.ready();
		putState(a, "s1");
		putEvents(a, "s1", 2, "x");
		putEvents(a, "s2", 1, "y");
		a.beginFlush();
		a.endFlush("2026-11-01T12:30:00.000Z");
		const before = {
			sessions: a.sessions(),
			heads: a.sessions().map((s) => a.head(s)),
			summary: a.summary(),
		};
		const b = open();
		await b.ready();
		expect(b.listed()).toBe(true);
		expect(b.sessions()).toEqual(before.sessions);
		expect(b.sessions().map((s) => b.head(s))).toEqual(before.heads);
		expect(b.summary()).toEqual({ ...before.summary, lastFlushAt: "2026-11-01T12:30:00.000Z" });
		// the next entry continues the numbering
		putEvents(b, "s1", 1, "z");
		expect(drain(b, "s1").map((e) => e.seq)).toEqual([1, 2, 3]);
	});

	test("the summary counts reports, the flush totals and what was lost, and survives in the meta file", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1", 3, "a");
		putState(box, "s1");
		box.beginFlush();
		const h = box.head("s1") as OutboxEntry;
		box.remove("s1", h.seq, "delivered"); // 3 events
		const second = box.head("s1") as OutboxEntry;
		box.remove("s1", second.seq, "lost"); // 1 state
		box.endFlush("2026-11-01T13:00:00.000Z");
		expect(box.summary()).toMatchObject({
			pending: 0,
			lastFlushAt: "2026-11-01T13:00:00.000Z",
			lastFlushDelivered: 3,
			lastFlushLost: 1,
		});
		const again = open();
		await again.ready();
		expect(again.summary()).toMatchObject({ lastFlushDelivered: 3, lastFlushLost: 1 });
	});
});

describe("privacy and trust", () => {
	test("the root and session directories are 0700 and entries and the session file 0600", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1");
		box.beginFlush();
		box.endFlush("2026-11-01T13:00:00.000Z");
		expect(statSync(rootDir()).mode & 0o777).toBe(0o700);
		expect(statSync(sessionDir("s1")).mode & 0o777).toBe(0o700);
		for (const file of [
			entryFile("s1", 1),
			join(sessionDir("s1"), "session.json"),
			join(rootDir(), "outbox-meta.json"),
		]) {
			expect(statSync(file).mode & 0o777, file).toBe(0o600);
		}
	});

	test("a symlinked root turns the outbox off: nothing is written through it and appends are lost", async () => {
		mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
		const elsewhere = join(home, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		symlinkSync(elsewhere, rootDir());
		const box = open();
		await box.ready();
		expect(putEvents(box, "s1")).toBe("lost");
		expect(box.enabled).toBe(false);
		expect(readdirSync(elsewhere)).toEqual([]);
		expect(logs.join("\n")).toContain("offline outbox is off");
	});

	test("a root that becomes a symlink after the outbox loaded is refused at the next append", async () => {
		const box = open();
		await box.ready();
		mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
		const elsewhere = join(home, "elsewhere");
		mkdirSync(elsewhere, { mode: 0o700 });
		symlinkSync(elsewhere, rootDir());
		expect(putEvents(box, "s1")).toBe("lost");
		expect(box.enabled).toBe(false);
		expect(readdirSync(elsewhere)).toEqual([]);
	});

	test("a root others can write to turns the outbox off", async () => {
		mkdirSync(rootDir(), { recursive: true, mode: 0o777 });
		chmodSync(rootDir(), 0o777);
		const box = open();
		await box.ready();
		expect(box.enabled).toBe(false);
		expect(putState(box, "s1")).toBe("lost");
	});

	test("a symlinked session directory is unknown: never read, and purgeDir unlinks the link only", async () => {
		const a = open();
		await a.ready();
		putEvents(a, "s1");
		const real = sessionDir("s1");
		const moved = join(home, "moved");
		rmSync(moved, { recursive: true, force: true });
		mkdirSync(moved, { mode: 0o700 });
		for (const name of readdirSync(real))
			writeFileSync(join(moved, name), readFileSync(join(real, name)), { mode: 0o600 });
		rmSync(real, { recursive: true });
		symlinkSync(moved, real);

		const b = open();
		await b.ready();
		expect(b.sessions()).toEqual([]);
		expect(b.unknownDirs()).toEqual([outboxDirName("s1")]);
		b.purgeDir(outboxDirName("s1"));
		expect(lstatSync(real, { throwIfNoEntry: false })).toBeUndefined();
		expect(readdirSync(moved).length, "the target of the link is untouched").toBeGreaterThan(0);
		expect(b.unknownDirs()).toEqual([]);
	});

	test("a symlink as the head makes the session held; another session still delivers; only a purge clears it", async () => {
		const a = open();
		await a.ready();
		putEvents(a, "P", 1, "p");
		putEvents(a, "P", 1, "p2");
		putEvents(a, "Q", 1, "q");
		const secret = join(home, "secret.json");
		writeFileSync(secret, "{}", { mode: 0o600 });
		rmSync(entryFile("P", 1));
		symlinkSync(secret, entryFile("P", 1));
		const b = open();
		await b.ready();
		expect(b.head("P")).toBe("held");
		expect(b.head("P"), "held is not cached away").toBe("held");
		const q = b.head("Q");
		expect(q).not.toBe("held");
		expect((q as OutboxEntry).sessionId).toBe("Q");
		b.remove("Q", 1, "delivered");
		expect(b.hasPending("P")).toBe(true);
		expect(readFileSync(secret, "utf-8"), "the link's target was never touched").toBe("{}");
		b.purge("P");
		expect(existsSync(sessionDir("P"))).toBe(false);
		expect(readFileSync(secret, "utf-8")).toBe("{}");
	});

	test("a hard-linked head is held, not read", async () => {
		const a = open();
		await a.ready();
		putEvents(a, "s1");
		linkSync(entryFile("s1", 1), join(home, "twin.json"));
		const b = open();
		await b.ready();
		expect(b.head("s1")).toBe("held");
	});

	test("an entry readable by others is held", async () => {
		const a = open();
		await a.ready();
		putEvents(a, "s1");
		chmodSync(entryFile("s1", 1), 0o644);
		const b = open();
		await b.ready();
		expect(b.head("s1")).toBe("held");
	});

	test("a session directory that changes owner permissions after load is held", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1");
		// group-readable is not private, though nobody else can write into it
		chmodSync(sessionDir("s1"), 0o750);
		expect(box.head("s1")).toBe("held");
		expect(putEvents(box, "s1")).toBe("lost");
	});
});

describe("an entry that fails validation is dropped and counted, and the next one is the head", () => {
	const CASES: Array<[string, Record<string, unknown> | string]> = [
		["not JSON", "{not json"],
		["a wrong version", { v: 2 }],
		["another session's id", { sessionId: "someone-else" }],
		["a seq that isn't its file name", { seq: 99 }],
		["a bad delivery id", { deliveryId: "has spaces!" }],
		["a body that isn't JSON", { body: "{oops" }],
		["a body with no events", { body: JSON.stringify({ nope: 1 }) }],
		[
			"a state body for another session",
			{ kind: "state", body: JSON.stringify({ sessionId: "other" }) },
		],
		["an unknown kind", { kind: "mystery" }],
		["a missing attempted flag", { attempted: undefined }],
	];
	for (const [label, bad] of CASES) {
		test(label, async () => {
			plant("s1", 1, bad);
			plant("s1", 2, {});
			const box = open();
			await box.ready();
			const head = box.head("s1") as OutboxEntry;
			expect(head.seq).toBe(2);
			expect(existsSync(entryFile("s1", 1))).toBe(false);
			box.beginFlush();
			box.endFlush("2026-11-01T13:00:00.000Z");
			expect(box.summary().lastFlushLost).toBe(1);
		});
	}

	test("a supervisor id mismatch purges the whole directory, counted lost", async () => {
		plant("s1", 1, {}, "another-supervisor");
		plant("s1", 2, {}, "another-supervisor");
		const box = open();
		await box.ready();
		expect(box.hasPending("s1")).toBe(false);
		expect(existsSync(sessionDir("s1"))).toBe(false);
		box.beginFlush();
		box.endFlush("2026-11-01T13:00:00.000Z");
		expect(box.summary().lastFlushLost).toBe(2);
	});

	test("a directory without a readable session.json is unknown, and purgeDir counts its entries", async () => {
		plant("s1", 1, {});
		plant("s1", 2, {});
		rmSync(join(sessionDir("s1"), "session.json"));
		const box = open();
		await box.ready();
		expect(box.unknownDirs()).toEqual([outboxDirName("s1")]);
		box.purgeDir(outboxDirName("s1"));
		expect(existsSync(sessionDir("s1"))).toBe(false);
		box.beginFlush();
		box.endFlush("2026-11-01T13:00:00.000Z");
		expect(box.summary().lastFlushLost).toBe(2);
	});

	test("purgeDir refuses a name that isn't one of its own directories", async () => {
		const box = open();
		await box.ready();
		mkdirSync(join(home, "victim"), { recursive: true });
		writeFileSync(join(home, "victim", "keep.txt"), "x");
		box.purgeDir("../../victim");
		box.purgeDir("..");
		box.purgeDir("s-not-a-hash");
		expect(existsSync(join(home, "victim", "keep.txt"))).toBe(true);
	});

	test("a leftover temp file from a crashed write is removed at load and is never an entry", async () => {
		plant("s1", 1, {});
		const tmp = join(sessionDir("s1"), ".0000000000000002.json.123.abc.def.tmp");
		writeFileSync(tmp, "partial", { mode: 0o600 });
		const box = open();
		await box.ready();
		expect(existsSync(tmp)).toBe(false);
		expect(drain(box, "s1").map((e) => e.seq)).toEqual([1]);
	});
});

describe("bounds", () => {
	/** The largest padding for which an entry is still queued, found by bisection; and the file size it gives. */
	function largestQueuedPad(limits: Partial<OutboxLimits>): { pad: number; fileBytes: number } {
		const probe = (pad: number, id: string) => {
			const box = open({ limits });
			return {
				result: box.append(id, {
					kind: "events",
					body: JSON.stringify({
						events: [{ eventType: "P", category: "system_event", content: "x".repeat(pad) }],
					}),
					attempted: false,
					deliveryId: "probe-delivery-1234",
				}),
				box,
			};
		};
		let lo = 0;
		let hi = (limits.entryBytes ?? OUTBOX_LIMITS.entryBytes) + 10;
		let n = 0;
		// ids of one length, so the envelope is the same size for every probe
		const pid = (k: number) => `probe-${String(k).padStart(4, "0")}`;
		while (lo < hi) {
			const mid = Math.ceil((lo + hi) / 2);
			if (probe(mid, pid(n++)).result === "queued") lo = mid;
			else hi = mid - 1;
		}
		const finalId = pid(n++);
		const check = probe(lo, finalId);
		expect(check.result).toBe("queued");
		const next = probe(lo + 1, pid(n++));
		expect(next.result).toBe("lost");
		return { pad: lo, fileBytes: statSync(entryFile(finalId, 1)).size };
	}

	test("an entry is queued at exactly the entry limit and lost one byte over", () => {
		const limit = 16_384;
		const { fileBytes } = largestQueuedPad({ entryBytes: limit });
		expect(fileBytes).toBe(limit);
	});

	test("the session entry cap: at the cap everything is kept; one over folds the oldest non-head state entry, the head untouched", async () => {
		const box = open({ limits: { sessionEntries: 5 } });
		await box.ready();
		for (let i = 1; i <= 5; i++)
			putState(box, "s1", { cwd: `/c${i}`, model: i === 1 ? "head-model" : undefined });
		expect(box.summary().pending).toBe(5);
		putState(box, "s1", { cwd: "/c6" });
		expect(box.summary().pending).toBe(5);
		const out = drain(box, "s1");
		expect(out.map((e) => e.seq)).toEqual([1, 3, 4, 5, 6]);
		expect(JSON.parse(out[0]?.body as string)).toMatchObject({ cwd: "/c1", model: "head-model" });
		// seq 2 was folded into the next state entry (seq 3): its cwd was superseded by 3's
		expect(JSON.parse(out[1]?.body as string).cwd).toBe("/c3");
	});

	test("the session entry cap with events: the oldest non-head events become a gap, the head is kept, the loss is counted", async () => {
		const box = open({ limits: { sessionEntries: 4 } });
		await box.ready();
		for (let i = 1; i <= 4; i++) putEvents(box, "s1", 1, `m${i}`);
		expect(putEvents(box, "s1", 1, "m5")).toBe("queued");
		const out = drain(box, "s1");
		expect(out[0]?.seq).toBe(1);
		expect(out[0]?.kind).toBe("events");
		expect(out.filter((e) => e.kind === "gap")).toHaveLength(1);
		const gap = out.find((e) => e.kind === "gap") as OutboxEntry;
		expect(gap.lost).toBeGreaterThanOrEqual(1);
		expect(gap.deliveryId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
		const event = JSON.parse(gap.body).events[0];
		expect(event).toMatchObject({ eventType: "ManagedEventsLost", category: "system_event" });
		expect(event.content).toContain("while this machine was offline");
		expect(event.rawPayload.lost).toBe(gap.lost);
		box.beginFlush();
		box.endFlush("2026-11-01T14:00:00.000Z");
		expect(box.summary().lastFlushLost).toBe(gap.lost as number);
	});

	test("the gap says '1 event ... wasn't' for one and 'N events ... weren't' for more", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "one", 1, "a");
		putEvents(box, "many", 3, "b");
		clock = T0 + 25 * HOUR;
		box.ageOut(clock);
		const one = box.head("one") as OutboxEntry;
		expect(JSON.parse(one.body).events[0].content).toMatch(
			/^1 event from this session wasn't delivered while this machine was offline/,
		);
		const many = box.head("many") as OutboxEntry;
		expect(many.lost).toBe(3);
		expect(JSON.parse(many.body).events[0].content).toMatch(
			/^3 events from this session weren't delivered while this machine was offline/,
		);
	});

	test("an unattempted gap absorbs further drops; an attempted gap is frozen", async () => {
		const box = open({ limits: { sessionEntries: 3 } });
		await box.ready();
		for (let i = 0; i < 8; i++) putEvents(box, "s1", 1, `m${i}`);
		let entries = [];
		const h1 = box.head("s1") as OutboxEntry;
		expect(h1.seq).toBe(1);
		const all: OutboxEntry[] = [];
		for (;;) {
			const h = box.head("s1");
			if (!h || h === "held") break;
			all.push(h);
			box.remove("s1", h.seq, "delivered");
		}
		entries = all;
		expect(entries.filter((e) => e.kind === "gap")).toHaveLength(1);

		const frozen = open({ limits: { sessionEntries: 3 } });
		await frozen.ready();
		putEvents(frozen, "f", 1, "head");
		putEvents(frozen, "f", 1, "x");
		putEvents(frozen, "f", 1, "y");
		putEvents(frozen, "f", 1, "z");
		// make the gap (seq 2) the attempted one, as if it had been sent
		const q = frozen.sessions();
		expect(q).toEqual(["f"]);
		const first = frozen.head("f") as OutboxEntry;
		frozen.remove("f", first.seq, "delivered"); // the gap is now the head
		const gap = frozen.head("f") as OutboxEntry;
		expect(gap.kind).toBe("gap");
		expect(frozen.markAttempted("f", gap.seq)).toBe(true);
		putEvents(frozen, "f", 1, "p");
		putEvents(frozen, "f", 1, "q");
		putEvents(frozen, "f", 1, "r");
		const rest = drain(frozen, "f");
		expect(rest[0]?.seq).toBe(gap.seq);
		expect(rest[0]?.lost, "the sent gap kept its count").toBe(gap.lost);
		expect(rest.filter((e) => e.kind === "gap").length).toBeGreaterThanOrEqual(1);
	});

	test("the session byte cap: past it the oldest non-head events are replaced by a gap", async () => {
		const box = open({ limits: { sessionBytes: 6_000, entryBytes: 4_000 } });
		await box.ready();
		const big = (tag: string) =>
			box.append("s1", {
				kind: "events",
				body: JSON.stringify({
					events: [{ eventType: "B", category: "system_event", content: tag + "x".repeat(900) }],
				}),
				attempted: false,
			});
		for (let i = 0; i < 8; i++) expect(big(`n${i}`)).toBe("queued");
		const out = drain(box, "s1");
		expect(out[0]?.kind).toBe("events");
		expect(out.some((e) => e.kind === "gap")).toBe(true);
	});

	test("the total cap applies rule 2 to the largest session, so a small session is not the one that pays", async () => {
		const box = open({ limits: { totalBytes: 9_000, sessionBytes: 9_000, entryBytes: 4_000 } });
		await box.ready();
		const big = (id: string, tag: string) =>
			box.append(id, {
				kind: "events",
				body: JSON.stringify({
					events: [{ eventType: "B", category: "system_event", content: tag + "x".repeat(900) }],
				}),
				attempted: false,
			});
		for (let i = 0; i < 5; i++) big("large", `l${i}`);
		big("small", "s0");
		big("small", "s1");
		const smallBefore = box.head("small") as OutboxEntry;
		for (let i = 5; i < 9; i++) big("large", `l${i}`);
		const small = drain(box, "small");
		expect(small.map((e) => e.kind)).toEqual(["events", "events"]);
		expect(small[0]?.seq).toBe(smallBefore.seq);
		const large = drain(box, "large");
		expect(large[0]?.kind).toBe("events");
		expect(large.some((e) => e.kind === "gap")).toBe(true);
	});

	test("the session cap: a new session past it is lost and counted, existing ones still queue", async () => {
		const box = open({ limits: { sessions: 3 } });
		await box.ready();
		for (const id of ["a", "b", "c"]) expect(putEvents(box, id)).toBe("queued");
		expect(putEvents(box, "d", 2)).toBe("lost");
		expect(putState(box, "e")).toBe("lost");
		expect(putEvents(box, "a")).toBe("queued");
		box.beginFlush();
		box.endFlush("2026-11-01T14:00:00.000Z");
		expect(box.summary().lastFlushLost).toBe(3);
		expect(box.sessions().sort()).toEqual(["a", "b", "c"]);
	});

	test("an entry that doesn't fit even alone is lost and counted, never partly stored; the session is told with a gap", async () => {
		const box = open({ limits: { entryBytes: 2_000 } });
		await box.ready();
		const huge = JSON.stringify({
			events: [{ eventType: "H", category: "system_event", content: "x".repeat(3_000) }],
		});
		expect(box.append("s1", { kind: "events", body: huge, attempted: false })).toBe("lost");
		const head = box.head("s1") as OutboxEntry;
		expect(head.kind, "no part of the oversized event was stored").toBe("gap");
		expect(head.lost).toBe(1);
		expect(box.summary().pending).toBe(1);
		box.beginFlush();
		box.endFlush("2026-11-01T14:00:00.000Z");
		expect(box.summary().lastFlushLost).toBe(1);
	});

	test("the head is never dropped by the size rules, even when it is the only thing that could be", async () => {
		const box = open({ limits: { sessionEntries: 1 } });
		await box.ready();
		putEvents(box, "s1", 1, "head");
		expect(putEvents(box, "s1", 1, "next")).toBe("lost");
		expect((box.head("s1") as OutboxEntry).seq).toBe(1);
		expect(box.summary().pending).toBe(1);
	});
});

describe("splitting at enqueue", () => {
	test("an events batch above 500 events becomes entries of at most 500, in order, each with its own delivery id", async () => {
		const box = open();
		await box.ready();
		expect(putEvents(box, "s1", 1_200, "b")).toBe("queued");
		const out = drain(box, "s1");
		const counts = out.map((e) => JSON.parse(e.body).events.length);
		expect(counts).toEqual([500, 500, 200]);
		const contents = out.flatMap((e) =>
			JSON.parse(e.body).events.map((ev: { content: string }) => ev.content),
		);
		expect(contents).toEqual(Array.from({ length: 1_200 }, (_, i) => `b-${i}`));
		expect(new Set(out.map((e) => e.deliveryId)).size).toBe(3);
		expect(out.every((e) => e.attempted === false)).toBe(true);
	});

	test("exactly 500 events stay one entry; 501 split", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "a", 500);
		putEvents(box, "b", 501);
		expect(drain(box, "a")).toHaveLength(1);
		expect(drain(box, "b")).toHaveLength(2);
	});

	test("a batch too big in bytes is halved until each entry fits", async () => {
		const box = open({ limits: { entryBytes: 20_000 } });
		await box.ready();
		const events = Array.from({ length: 30 }, (_, i) => ({
			eventType: "Big",
			category: "system_event",
			content: `${i}-${"y".repeat(2_000)}`,
		}));
		expect(
			box.append("s1", { kind: "events", body: JSON.stringify({ events }), attempted: false }),
		).toBe("queued");
		const out = drain(box, "s1");
		expect(out.length).toBeGreaterThan(3);
		const flat = out.flatMap((e) =>
			JSON.parse(e.body).events.map((ev: { content: string }) => ev.content.split("-")[0]),
		);
		expect(flat).toEqual(events.map((_, i) => String(i)));
	});

	test("an entry already sent as one request keeps its body and delivery id, so a lost ack still dedupes", async () => {
		const box = open();
		await box.ready();
		const body = eventsBody(600, "sent");
		expect(
			box.append("s1", { kind: "events", body, attempted: true, deliveryId: "sent-id-12345678" }),
		).toBe("queued");
		const out = drain(box, "s1");
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ attempted: true, deliveryId: "sent-id-12345678", body });
	});

	test("an unattempted events entry gets a delivery id; a state entry gets none", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1");
		putState(box, "s1");
		const out = drain(box, "s1");
		expect(out[0]?.deliveryId).toMatch(/^[A-Za-z0-9-]{8,64}$/);
		expect(out[1]?.deliveryId).toBeUndefined();
	});
});

describe("attempts, failures and the poison rule", () => {
	test("markAttempted persists, survives a restart and is idempotent", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1");
		expect(box.markAttempted("s1", 1)).toBe(true);
		expect(box.markAttempted("s1", 1)).toBe(true);
		const again = open();
		await again.ready();
		expect((again.head("s1") as OutboxEntry).attempted).toBe(true);
		expect(again.markAttempted("s1", 99), "only the head can be marked").toBe(false);
	});

	test("a markAttempted write failure returns false and the entry stays unattempted", async () => {
		let failing = false;
		const { writePrivateFileAtomicNoFollow } = await import("../../shared/private-file.js");
		const box = open({
			writer: (path, text) => {
				if (failing) throw new Error("ENOSPC: no space left on device");
				writePrivateFileAtomicNoFollow(path, text);
			},
		});
		await box.ready();
		putEvents(box, "s1");
		failing = true;
		expect(box.markAttempted("s1", 1)).toBe(false);
		expect((box.head("s1") as OutboxEntry).attempted).toBe(false);
		const fresh = open();
		await fresh.ready();
		expect((fresh.head("s1") as OutboxEntry).attempted).toBe(false);
	});

	test("8 failures spread over an hour poison the head; 8 within 59 minutes do not", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1", 1, "p");
		const t = T0;
		for (let i = 0; i < 7; i++) expect(box.recordFailure("s1", 1, t + i * 8 * 60_000)).toBe("keep");
		// the 8th at 59 minutes: the count is there, the span is not
		expect(box.recordFailure("s1", 1, t + 59 * 60_000)).toBe("keep");
		expect(box.hasPending("s1")).toBe(true);
		expect(box.recordFailure("s1", 1, t + 61 * 60_000)).toBe("poisoned");
		expect(box.hasPending("s1")).toBe(false);
		box.beginFlush();
		box.endFlush("2026-11-01T15:00:00.000Z");
		expect(box.summary().lastFlushLost).toBe(1);
	});

	test("7 failures over a day never poison; the 8th does", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1");
		for (let i = 0; i < 7; i++) expect(box.recordFailure("s1", 1, T0 + i * 4 * HOUR)).toBe("keep");
		expect(box.recordFailure("s1", 1, T0 + 30 * HOUR)).toBe("poisoned");
	});

	test("failure counts survive a restart", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1");
		for (let i = 0; i < 4; i++) box.recordFailure("s1", 1, T0 + i * 1000);
		const again = open();
		await again.ready();
		const h = again.head("s1") as OutboxEntry;
		expect(h.failures).toBe(4);
		expect(h.firstFailureAt).toBe(new Date(T0).toISOString());
	});

	test("a non-counting failure (the server's own back-pressure) changes nothing and never poisons", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1");
		for (let i = 0; i < 50; i++) {
			expect(box.recordFailure("s1", 1, T0 + i * HOUR, { counts: false })).toBe("keep");
		}
		const h = box.head("s1") as OutboxEntry;
		expect(h.failures).toBeUndefined();
		expect(h.firstFailureAt).toBeUndefined();
		// and it doesn't reset a real count either
		box.recordFailure("s1", 1, T0);
		box.recordFailure("s1", 1, T0 + 1, { counts: false });
		expect((box.head("s1") as OutboxEntry).failures).toBe(1);
	});

	test("recordFailure for a seq that isn't the head does nothing", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1");
		putEvents(box, "s1");
		expect(box.recordFailure("s1", 2, T0)).toBe("keep");
		expect((box.head("s1") as OutboxEntry).failures).toBeUndefined();
	});
});

describe("writes that fail", () => {
	test("ENOSPC on an entry write: the append is lost and counted, no empty directory is left, the PTY-side caller carries on", async () => {
		const box = open({
			writer: (path, text) => {
				if (/\d{16}\.json$/.test(path))
					throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
				writeFileSync(path, text, { mode: 0o600 });
			},
		});
		await box.ready();
		expect(putEvents(box, "s1", 3)).toBe("lost");
		expect(box.hasPending("s1")).toBe(false);
		expect(existsSync(sessionDir("s1"))).toBe(false);
		box.beginFlush();
		box.endFlush("2026-11-01T15:00:00.000Z");
		expect(box.summary().lastFlushLost).toBe(3);
	});

	test("ENOSPC writing session.json loses the append without leaving a directory", async () => {
		const box = open({
			writer: () => {
				throw new Error("ENOSPC");
			},
		});
		await box.ready();
		expect(putState(box, "s1")).toBe("lost");
		expect(existsSync(sessionDir("s1"))).toBe(false);
	});
});

describe("aging", () => {
	test("a never-delivered session aged past 24 h keeps its creation: [state, gap], the loss counted", async () => {
		const box = open();
		await box.ready();
		putState(box, "s1", { status: "active", cwd: "/work" });
		putEvents(box, "s1", 1, "a");
		putEvents(box, "s1", 2, "b");
		putState(box, "s1", { status: "completed" });
		clock = T0 + 25 * HOUR;
		box.ageOut(clock);
		const out = drain(box, "s1");
		expect(out.map((e) => e.kind)).toEqual(["state", "gap"]);
		expect(JSON.parse(out[0]?.body as string)).toMatchObject({ cwd: "/work", status: "completed" });
		expect(out[1]?.lost).toBe(3);
		box.beginFlush();
		box.endFlush("2026-11-02T14:00:00.000Z");
		expect(box.summary().lastFlushLost).toBe(3);
	});

	test("only aged entries go: a fresh one behind them is kept as it is", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1", 1, "old");
		clock = T0 + 23 * HOUR;
		putEvents(box, "s1", 1, "fresh");
		clock = T0 + 25 * HOUR;
		box.ageOut(clock);
		const out = drain(box, "s1");
		expect(out.map((e) => e.kind)).toEqual(["gap", "events"]);
		expect(JSON.parse(out[1]?.body as string).events[0].content).toBe("fresh-0");
	});

	test("an aged state entry is never dropped", async () => {
		const box = open();
		await box.ready();
		putState(box, "s1", { status: "active" });
		clock = T0 + 40 * HOUR;
		box.ageOut(clock);
		const out = drain(box, "s1");
		expect(out.map((e) => e.kind)).toEqual(["state"]);
	});

	test("a clock moved back 25 h ages nothing", async () => {
		const box = open();
		await box.ready();
		putState(box, "s1");
		putEvents(box, "s1");
		clock = T0 - 25 * HOUR;
		box.ageOut(clock);
		expect(box.summary().pending).toBe(2);
		expect(drain(box, "s1").map((e) => e.kind)).toEqual(["state", "events"]);
	});

	test("exactly 24 h old is aged; a second younger is not", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "young", 1, "y");
		box.ageOut(T0 + 24 * HOUR - 1000);
		expect(box.head("young")).toMatchObject({ kind: "events" });
		box.ageOut(T0 + 24 * HOUR);
		expect(box.head("young")).toMatchObject({ kind: "gap" });
	});
});

describe("purge", () => {
	test("purge removes the session; countLost counts what it held, otherwise the loss is not counted", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "keepcount", 2);
		putEvents(box, "quiet", 2);
		box.purge("quiet");
		box.beginFlush();
		box.endFlush("2026-11-01T16:00:00.000Z");
		expect(box.summary().lastFlushLost).toBe(0);
		expect(box.hasPending("quiet")).toBe(false);
		expect(existsSync(sessionDir("quiet"))).toBe(false);

		putEvents(box, "counted", 2);
		putEvents(box, "counted", 1);
		box.purge("counted", { countLost: true });
		box.beginFlush();
		box.endFlush("2026-11-01T16:05:00.000Z");
		expect(box.summary().lastFlushLost).toBe(2);
		expect(box.hasPending("keepcount")).toBe(true);
	});

	test("purge unlinks a planted link and never follows it or recurses into a planted directory; what it can't remove is retried by name, with no path in the log", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1");
		const outside = join(home, "outside.txt");
		writeFileSync(outside, "precious");
		symlinkSync(outside, join(sessionDir("s1"), "evil.json"));
		mkdirSync(join(sessionDir("s1"), "nested"));
		writeFileSync(join(sessionDir("s1"), "nested", "f.txt"), "inner");
		box.purge("s1");
		expect(readFileSync(outside, "utf-8")).toBe("precious");
		expect(existsSync(sessionDir("s1")), "the session's own name is free again").toBe(false);
		expect(box.hasPending("s1")).toBe(false);
		// the directory could not be emptied (a planted subdirectory): it was renamed and is remembered by that name
		const [leftover] = box.unknownDirs();
		expect(leftover).toMatch(/^\.purge-[0-9a-f]{16}$/);
		expect(existsSync(join(rootDir(), leftover as string, "nested", "f.txt")), "no recursion").toBe(
			true,
		);
		expect(existsSync(join(rootDir(), leftover as string, "evil.json"))).toBe(false);
		expect(logs.filter((l) => l.includes("tried again"))).toHaveLength(1);
		expect(logs.join("\n")).not.toContain(home);
		// once the obstacle is gone, the retry (what the flush does for every unknown directory) finishes it
		rmSync(join(rootDir(), leftover as string, "nested"), { recursive: true });
		box.purgeDir(leftover as string);
		expect(existsSync(join(rootDir(), leftover as string))).toBe(false);
		expect(box.unknownDirs()).toEqual([]);
	});

	test("a purge renames the directory first: the name is free at once and a link planted in its place is not followed", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1");
		box.purge("s1");
		expect(readdirSync(rootDir()).filter((n) => n.startsWith("."))).toEqual([]);
		// a symlink under the session's name, as an attacker could swap in: removed as a link, target untouched
		const target = join(home, "victim");
		mkdirSync(target);
		writeFileSync(join(target, "keep.txt"), "x");
		symlinkSync(target, sessionDir("s1"));
		box.purgeDir(outboxDirName("s1"));
		expect(existsSync(join(target, "keep.txt"))).toBe(true);
		expect(lstatSync(sessionDir("s1"), { throwIfNoEntry: false })).toBeUndefined();
		expect(readdirSync(rootDir()).filter((n) => n.startsWith("."))).toEqual([]);
	});

	test("a half-finished purge left by an earlier run is finished at load", async () => {
		const first = open();
		await first.ready();
		putEvents(first, "keep");
		const stale = join(rootDir(), ".purge-0123456789abcdef");
		mkdirSync(stale, { mode: 0o700 });
		writeFileSync(join(stale, "0000000000000001.json"), "old");
		const box = open();
		await box.ready();
		expect(existsSync(stale)).toBe(false);
		expect(box.hasPending("keep")).toBe(true);
	});

	test("purging a session the outbox doesn't track still removes a directory left on disk", async () => {
		plant("ghost", 1, {});
		const box = open();
		// not yet loaded when purged
		box.purge("ghost");
		await box.ready();
		expect(existsSync(sessionDir("ghost"))).toBe(false);
	});
});

describe("ordering of sessions", () => {
	test("sessions() lists the one with the oldest head first", async () => {
		const box = open();
		await box.ready();
		clock = T0;
		putEvents(box, "old");
		clock = T0 + 1000;
		putEvents(box, "mid");
		clock = T0 + 2000;
		putEvents(box, "new");
		expect(box.sessions()).toEqual(["old", "mid", "new"]);
		box.remove("old", 1, "delivered");
		expect(box.sessions()).toEqual(["mid", "new"]);
	});
});

describe("an append before the listing reaches a session", () => {
	test("continues that session's numbering and keeps its older entries first", async () => {
		const first = open();
		await first.ready();
		putEvents(first, "s1", 1, "before-1");
		putEvents(first, "s1", 1, "before-2");
		const box = open();
		// no await: the asynchronous listing has not run
		expect(box.listed()).toBe(false);
		putEvents(box, "s1", 1, "during");
		await box.ready();
		const out = drain(box, "s1");
		expect(out.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(out.map((e) => JSON.parse(e.body).events[0].content)).toEqual([
			"before-1-0",
			"before-2-0",
			"during-0",
		]);
	});
});

describe("foldStateReports", () => {
	const S = (over: Partial<ManagedSessionStateInput> = {}): ManagedSessionStateInput => ({
		sessionId: "s1",
		...over,
	});

	const PAIRS: Array<{
		name: string;
		a: ManagedSessionStateInput;
		b: ManagedSessionStateInput;
		expected: ManagedSessionStateInput;
	}> = [
		{
			name: "status takes b's own value even when b has none (the server resets it to active)",
			a: S({ status: "failed" }),
			b: S(),
			expected: S(),
		},
		{
			name: "status: b wins when it has one",
			a: S({ status: "active" }),
			b: S({ status: "completed" }),
			expected: S({ status: "completed" }),
		},
		{
			name: "desiredThreadTitle takes b's own value, absent included",
			a: S({ desiredThreadTitle: "old" }),
			b: S(),
			expected: S(),
		},
		{
			name: "cwd: b only when it names one (null counts)",
			a: S({ cwd: "/a" }),
			b: S(),
			expected: S({ cwd: "/a" }),
		},
		{
			name: "cwd: an explicit null in b replaces",
			a: S({ cwd: "/a" }),
			b: S({ cwd: null }),
			expected: S({ cwd: null }),
		},
		{
			name: "model: b when defined, else a",
			a: S({ model: "m1" }),
			b: S({ model: "m2" }),
			expected: S({ model: "m2" }),
		},
		{
			name: "metadata is merged shallowly, b's keys winning",
			a: S({ metadata: { x: 1, y: { deep: 1 } } }),
			b: S({ metadata: { y: { other: 2 }, z: 3 } }),
			expected: S({ metadata: { x: 1, y: { other: 2 }, z: 3 } }),
		},
		{
			name: "metadata: one side only",
			a: S(),
			b: S({ metadata: { z: 3 } }),
			expected: S({ metadata: { z: 3 } }),
		},
		{
			name: "metadata: null in b keeps a's",
			a: S({ metadata: { x: 1 } }),
			b: S({ metadata: null }),
			expected: S({ metadata: { x: 1 } }),
		},
		{
			name: "other managed fields are b ?? a (a null in b falls back to a)",
			a: S({ providerThreadId: "t-a", providerSyncState: "pending", managedState: "headless" }),
			b: S({ providerThreadId: null, providerSyncState: "synced" }),
			expected: S({
				providerThreadId: "t-a",
				providerSyncState: "synced",
				managedState: "headless",
			}),
		},
	];

	test("the rule table has at least six pairs, among them the status-undefined member", () => {
		expect(PAIRS.length).toBeGreaterThanOrEqual(6);
		expect(PAIRS.map((p) => p.name)).toContain(
			"status takes b's own value even when b has none (the server resets it to active)",
		);
	});

	for (const pair of PAIRS) {
		test(pair.name, () => {
			const folded = foldStateReports(pair.a, pair.b);
			expect(folded).toEqual(pair.expected);
			// a key whose value is absent is absent, not undefined
			for (const key of Object.keys(folded)) {
				expect((folded as unknown as Record<string, unknown>)[key], key).not.toBeUndefined();
			}
		});
	}

	test("the status-undefined pair fails a fold that used b.status ?? a.status", () => {
		const wrong = (a: ManagedSessionStateInput, b: ManagedSessionStateInput) => ({
			...a,
			...b,
			status: b.status ?? a.status,
		});
		const pair = PAIRS[0] as (typeof PAIRS)[number];
		expect(wrong(pair.a, pair.b)).not.toEqual(pair.expected);
		expect(foldStateReports(pair.a, pair.b)).toEqual(pair.expected);
	});

	test("it is associative over every triple of a varied set", () => {
		const set = [
			S(),
			S({ status: "failed", cwd: "/a", metadata: { x: 1 } }),
			S({ model: "m", desiredThreadTitle: "t", metadata: { y: 2 } }),
			S({ cwd: null, providerThreadId: "p", metadata: null }),
			S({ status: "completed", managedState: "stopped", metadata: { x: 9, z: 1 } }),
			S({ providerSyncState: "failed", providerSyncError: "boom", model: null }),
		];
		let triples = 0;
		for (const a of set)
			for (const b of set)
				for (const c of set) {
					triples++;
					expect(foldStateReports(foldStateReports(a, b), c)).toEqual(
						foldStateReports(a, foldStateReports(b, c)),
					);
				}
		expect(triples).toBe(216);
	});
});

describe("load budget", () => {
	test("10,000 entries across 50 sessions are listed and sized in under a second without blocking the loop for 50 ms", async () => {
		for (let s = 0; s < 50; s++) {
			const id = `bulk-${s}`;
			for (let seq = 1; seq <= 200; seq++) plant(id, seq, { seq });
		}
		let maxGap = 0;
		let last = performance.now();
		const timer = setInterval(() => {
			const t = performance.now();
			maxGap = Math.max(maxGap, t - last);
			last = t;
		}, 5);
		const start = performance.now();
		const box = open();
		await box.ready();
		const took = performance.now() - start;
		clearInterval(timer);
		expect(box.sessions()).toHaveLength(50);
		expect(box.summary().pending).toBe(10_000);
		expect(box.listed()).toBe(true);
		expect(took).toBeLessThan(1_000);
		expect(maxGap).toBeLessThan(50);
	}, 30_000);
});

describe("load caps and clamps", () => {
	test("more session directories than the cap are not all examined: the surplus is purged and counted, the unknown set is held to the cap", async () => {
		const total = 1_030;
		for (let i = 0; i < total; i++) {
			const dir = join(rootDir(), `s-${i.toString(16).padStart(32, "0")}`);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			chmodSync(dir, 0o700);
			writeFileSync(join(dir, "0000000000000001.json"), "x", { mode: 0o600 });
		}
		chmodSync(join(home, ".agentpulse"), 0o700);
		chmodSync(rootDir(), 0o700);
		const box = open();
		await box.ready();
		expect(box.unknownDirs()).toHaveLength(1_024);
		const left = readdirSync(rootDir()).filter((n) => /^s-/.test(n));
		expect(left, "the six past the cap were purged").toHaveLength(1_024);
		box.beginFlush();
		box.endFlush("2026-11-01T17:00:00.000Z");
		expect(box.summary().lastFlushLost).toBe(total - 1_024);
	}, 60_000);

	test("a directory holding far more names than it may is cut back at load: the surplus entries go, counted lost, and session.json stays", async () => {
		for (let seq = 1; seq <= 40; seq++) plant("s1", seq, { seq });
		const box = open({ limits: { sessionEntries: 5 } });
		await box.ready();
		expect(box.hasPending("s1")).toBe(true);
		expect(box.summary().pending).toBe(5);
		expect(existsSync(join(sessionDir("s1"), "session.json"))).toBe(true);
		expect(readdirSync(sessionDir("s1")).filter((n) => /^\d{16}\.json$/.test(n))).toHaveLength(5);
		box.beginFlush();
		box.endFlush("2026-11-01T17:00:00.000Z");
		expect(box.summary().lastFlushLost).toBe(35);
		expect(drain(box, "s1").map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
	});

	test("lost and failures read back from disk are clamped to integers in [0, 10,000,000]", async () => {
		plant("s1", 1, { kind: "gap", lost: 1e12, failures: -5 });
		plant("s2", 1, { lost: 3.9, failures: 2.7 });
		plant("s3", 1, { lost: -1, failures: 1e30 });
		const box = open();
		await box.ready();
		const a = box.head("s1") as OutboxEntry;
		expect([a.lost, a.failures]).toEqual([10_000_000, 0]);
		const b = box.head("s2") as OutboxEntry;
		expect([b.lost, b.failures]).toEqual([3, 2]);
		const c = box.head("s3") as OutboxEntry;
		expect([c.lost, c.failures]).toEqual([0, 10_000_000]);
	});
});

describe("ageing by mtime until an entry is read", () => {
	const old = (path: string, ageMs: number) => {
		const at = new Date(clock - ageMs);
		utimesSync(path, at, at);
	};
	const stateEnvelope = (id: string, extra: Record<string, unknown> = {}) => ({
		kind: "state",
		body: JSON.stringify({ sessionId: id, status: "active", ...extra }),
		deliveryId: undefined,
	});

	test("an unread entry whose mtime is 25 h old (and whose envelope agrees) ages out after a restart: [state, gap]", async () => {
		const longAgo = new Date(T0 - 25 * HOUR).toISOString();
		plant("s1", 1, { ...stateEnvelope("s1"), queuedAt: longAgo });
		plant("s1", 2, { queuedAt: longAgo });
		plant("s1", 3, { queuedAt: longAgo });
		for (const seq of [1, 2, 3]) old(entryFile("s1", seq), 25 * HOUR);
		const box = open();
		await box.ready();
		box.ageOut(clock);
		expect(drain(box, "s1").map((e) => e.kind)).toEqual(["state", "gap"]);
	});

	test("a fresh entry and an entry with a future mtime are not aged", async () => {
		plant("fresh", 1, {});
		plant("future", 1, {});
		const ahead = new Date(clock + 30 * HOUR);
		utimesSync(entryFile("future", 1), ahead, ahead);
		const box = open();
		await box.ready();
		box.ageOut(clock + 2 * HOUR);
		expect((box.head("fresh") as OutboxEntry).kind).toBe("events");
		expect((box.head("future") as OutboxEntry).kind).toBe("events");
	});

	test("once an entry is read, its envelope queuedAt replaces the mtime: an old mtime on a recent entry does not age it", async () => {
		plant("s1", 1, { queuedAt: new Date(T0 - HOUR).toISOString() });
		old(entryFile("s1", 1), 25 * HOUR);
		const box = open();
		await box.ready();
		box.ageOut(clock);
		const head = box.head("s1") as OutboxEntry;
		expect(head.kind, "the envelope says it is an hour old").toBe("events");
		// and the other way: a recent mtime does not save an entry whose envelope says it is old, once read
		plant("s2", 1, { queuedAt: new Date(T0 - 26 * HOUR).toISOString() });
		const again = open();
		await again.ready();
		expect(again.head("s2")).toMatchObject({ kind: "events" });
		again.ageOut(clock);
		expect((again.head("s2") as OutboxEntry).kind).toBe("gap");
	});

	test("markAttempted and recordFailure rewrite the entry but keep its original queuedAt", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1");
		const original = (box.head("s1") as OutboxEntry).queuedAt;
		clock += 3 * HOUR;
		expect(box.markAttempted("s1", 1)).toBe(true);
		box.recordFailure("s1", 1, clock);
		expect(JSON.parse(readFileSync(entryFile("s1", 1), "utf-8")).queuedAt).toBe(original);
		const again = open();
		await again.ready();
		expect((again.head("s1") as OutboxEntry).queuedAt).toBe(original);
		// so the rewrite's new mtime does not make it young
		clock = T0 + 25 * HOUR;
		again.ageOut(clock);
		expect((again.head("s1") as OutboxEntry).kind).toBe("gap");
	});
});

describe("nothing is lost without being counted (conservation)", () => {
	function prng(seed: number) {
		let x = seed;
		return () => {
			x = (x * 1_664_525 + 1_013_904_223) % 4_294_967_296;
			return x / 4_294_967_296;
		};
	}

	for (const seed of [1, 7, 42, 2026]) {
		test(`events appended = delivered + still queued + counted lost, over a mixed sequence with small caps (seed ${seed})`, async () => {
			const rand = prng(seed);
			const box = open({
				limits: {
					sessionEntries: 6,
					sessionBytes: 6_000,
					totalBytes: 14_000,
					entryBytes: 3_000,
					sessions: 4,
				},
			});
			await box.ready();
			const ids = ["a", "b", "c", "d", "e", "f"];
			let appendedEvents = 0;
			let deliveredEvents = 0;
			let lostCounted = 0;
			let stateLostAppends = 0;
			let stateDelivered = 0;
			let deliveredGapLost = 0;

			const flushCounters = () => {
				box.beginFlush();
				box.endFlush(new Date(clock).toISOString());
				lostCounted += box.summary().lastFlushLost;
			};

			for (let step = 0; step < 400; step++) {
				const id = ids[Math.floor(rand() * ids.length)] as string;
				const roll = rand();
				if (roll < 0.45) {
					const n = 1 + Math.floor(rand() * 4);
					appendedEvents += n;
					box.append(id, {
						kind: "events",
						body: eventsBody(n, `x${step}`),
						attempted: rand() < 0.2,
						deliveryId: undefined,
					});
				} else if (roll < 0.6) {
					if (
						box.append(id, { kind: "state", body: stateBody(id, { step }), attempted: false }) ===
						"lost"
					)
						stateLostAppends++;
				} else if (roll < 0.85) {
					const h = box.head(id);
					if (h && h !== "held") {
						box.beginFlush();
						box.remove(id, h.seq, "delivered");
						box.endFlush(new Date(clock).toISOString());
						deliveredEvents += h.kind === "events" ? JSON.parse(h.body).events.length : 0;
						if (h.kind === "state") stateDelivered++;
						if (h.kind === "gap") deliveredGapLost += h.lost ?? 0;
						lostCounted += box.summary().lastFlushLost;
						// the summary's delivered figure matches what the caller sees (gap delivers nothing)
					}
				} else if (roll < 0.95) {
					clock += 30 * 60_000;
					box.ageOut(clock);
				} else {
					clock += 40 * HOUR;
					box.ageOut(clock);
				}
			}
			// drain everything that is left
			let queuedGapLost = 0;
			for (const id of ids) {
				for (;;) {
					const h = box.head(id);
					if (!h || h === "held") break;
					box.remove(id, h.seq, "delivered");
					deliveredEvents += h.kind === "events" ? JSON.parse(h.body).events.length : 0;
					if (h.kind === "gap") queuedGapLost += h.lost ?? 0;
				}
			}
			flushCounters();
			const lostEvents = lostCounted - stateLostAppends;
			expect(deliveredEvents + lostEvents, `seed ${seed}`).toBe(appendedEvents);
			// every event in a gap was counted lost when it became one, never twice
			expect(queuedGapLost + deliveredGapLost).toBeLessThanOrEqual(lostEvents);
			void stateDelivered;
		});
	}
});

describe("a write that fails never removes anything first", () => {
	/** A writer that fails when it would overwrite an existing file (a rewrite), while `failing` is set. */
	function flaky() {
		const state = { failing: false };
		const writer = (path: string, text: string) => {
			if (state.failing && existsSync(path)) throw new Error("ENOSPC: no space left on device");
			writePrivateFileAtomicNoFollow(path, text);
		};
		return { state, writer };
	}

	test("a fold whose rewrite fails removes no state entry; the append is lost as before; it works once writes do", async () => {
		const { state, writer } = flaky();
		const box = open({ writer, limits: { sessionEntries: 4 } });
		await box.ready();
		for (let i = 1; i <= 4; i++) putState(box, "s1", { cwd: `/c${i}` });
		state.failing = true;
		expect(putState(box, "s1", { cwd: "/c5" })).toBe("lost");
		expect(box.summary().pending).toBe(4);
		expect(readdirSync(sessionDir("s1")).filter((n) => /^\d{16}\.json$/.test(n))).toHaveLength(4);
		state.failing = false;
		expect(putState(box, "s1", { cwd: "/c5" })).toBe("queued");
		expect(box.summary().pending).toBe(4);
	});

	test("a gap whose rewrite fails removes no events entry and counts nothing lost for it", async () => {
		const { state, writer } = flaky();
		const box = open({ writer, limits: { sessionEntries: 3 } });
		await box.ready();
		putEvents(box, "s1", 1, "head");
		putEvents(box, "s1", 2, "b");
		putEvents(box, "s1", 3, "c");
		state.failing = true;
		box.beginFlush();
		expect(putEvents(box, "s1", 1, "d")).toBe("lost");
		const files = readdirSync(sessionDir("s1")).filter((n) => /^\d{16}\.json$/.test(n));
		expect(files, "all three original entries are still there").toHaveLength(3);
		expect(
			files.map((f) => JSON.parse(readFileSync(join(sessionDir("s1"), f), "utf-8")).kind),
		).toEqual(["events", "events", "events"]);
		state.failing = false;
		expect(putEvents(box, "s1", 1, "e")).toBe("queued");
	});

	test("an age-out whose rewrite fails removes nothing and tries again next pass", async () => {
		const { state, writer } = flaky();
		const box = open({ writer });
		await box.ready();
		putState(box, "s1", { status: "active" });
		putEvents(box, "s1", 2, "old");
		clock = T0 + 25 * HOUR;
		state.failing = true;
		box.ageOut(clock);
		expect(drainKinds(box)).toEqual(["state", "events"]);
		state.failing = false;
		box.ageOut(clock);
		expect(drainKinds(box)).toEqual(["state", "gap"]);

		function drainKinds(b: ReportOutbox) {
			const kinds: string[] = [];
			let at = 0;
			for (;;) {
				const head = b.head("s1");
				if (!head || head === "held") return kinds;
				kinds.push(head.kind);
				if (++at > 10) return kinds;
				// look without removing: walk by reading the files
				return readdirSync(sessionDir("s1"))
					.filter((n) => /^\d{16}\.json$/.test(n))
					.sort()
					.map((f) => JSON.parse(readFileSync(join(sessionDir("s1"), f), "utf-8")).kind);
			}
		}
	});
});

describe("what a restart does not carry", () => {
	test("losses since the last flush are not persisted: after a restart the lost count is a lower bound (the gap in the queue still says how many)", async () => {
		const a = open({ limits: { sessionEntries: 3 } });
		await a.ready();
		for (let i = 0; i < 6; i++) putEvents(a, "s1", 1, `m${i}`);
		a.beginFlush();
		a.endFlush(new Date(clock).toISOString());
		expect(a.summary().lastFlushLost, "before the restart the count is there").toBeGreaterThan(0);
		// a second overflow after that flush, and then the restart before the next one
		for (let i = 0; i < 3; i++) putEvents(a, "s1", 1, `n${i}`);
		const b = open({ limits: { sessionEntries: 3 } });
		await b.ready();
		b.beginFlush();
		b.endFlush("2026-11-01T18:00:00.000Z");
		expect(b.summary().lastFlushLost, "the restart forgot the unflushed count").toBe(0);
		// what was lost is still visible where it matters: in the queued gap
		const queuedGap = drain(b, "s1").find((e) => e.kind === "gap");
		expect(queuedGap?.lost).toBeGreaterThan(0);
	});
});

describe("a failure of the real writer", () => {
	test("a directory where the next entry belongs makes the rename fail: the append is lost and counted, no temp file is left, the head is intact", async () => {
		const box = open();
		await box.ready();
		putEvents(box, "s1", 1, "first");
		mkdirSync(entryFile("s1", 2));
		writeFileSync(join(entryFile("s1", 2), "blocker"), "x");
		expect(putEvents(box, "s1", 2, "second")).toBe("lost");
		const names = readdirSync(sessionDir("s1"));
		expect(
			names.filter((n) => n.endsWith(".tmp")),
			"the temp file was cleaned up",
		).toEqual([]);
		expect(statSync(entryFile("s1", 2)).isDirectory(), "the planted directory is untouched").toBe(
			true,
		);
		expect((box.head("s1") as OutboxEntry).seq).toBe(1);
		box.beginFlush();
		box.endFlush("2026-11-01T18:30:00.000Z");
		expect(box.summary().lastFlushLost).toBeGreaterThanOrEqual(2);
	});
});

describe("module boundaries", () => {
	test("the store is a leaf: it imports only private-store, private-file and shared types, and has no network or endpoint in it", () => {
		const source = readFileSync(join(import.meta.dir, "report-outbox.ts"), "utf-8");
		const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
		expect(imports.sort()).toEqual(
			[
				"./private-store.js",
				"../../shared/private-file.js",
				"../../shared/types.js",
				"node:crypto",
				"node:fs",
				"node:fs/promises",
				"node:path",
			].sort(),
		);
		const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		expect(code).not.toMatch(
			/\bfetch\b|\brequest\b|managed-session|managed-sessions\/|control-actions|launches\//,
		);
	});

	test("production calls writePrivateFileAtomicNoFollow with two arguments only (the test-seam guard)", () => {
		const source = readFileSync(join(import.meta.dir, "report-outbox.ts"), "utf-8");
		for (const match of source.matchAll(/writePrivateFileAtomicNoFollow\(([^)]*)\)/g)) {
			expect((match[1] ?? "").split(",").length, match[0]).toBeLessThanOrEqual(2);
		}
	});
});
