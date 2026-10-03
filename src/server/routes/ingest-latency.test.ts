import { beforeAll, describe, expect, test } from "bun:test";
/**
 * Ingest latency (A-H1: <50ms budget, ingest.ts's "Return 200 IMMEDIATELY
 * before any DB work" comment): attribution must add zero synchronous DB
 * statements before POST /hooks returns its 200. buildHookDeliveryContext
 * (header reads + the already-resolved authUser) is synchronous/no-I/O; all
 * persistence — including the attribution writes — happens inside
 * enqueueHookProcessing's async queue, after the response has already gone
 * out.
 *
 * A naive "wrap countDbCalls around the whole app.request() call" measurement
 * was tried and rejected at first: in this single-process test runner, with
 * nothing else competing for the event loop, the detached
 * enqueueHookProcessing microtask chain can run several ticks (sometimes to
 * completion) before the outer `await app.request(...)` itself resolves —
 * the two are racing in the same microtask queue, and the background
 * chain's first tick was scheduled earlier in program order. That produced
 * a non-zero, non-stable count that measured the race, not the contract.
 *
 * The fix isn't to give up on the behavioral measurement — it's to remove
 * the race: ingest.ts exposes a test-only override
 * (_setEnqueueHookProcessingOverrideForTest) that swaps the background
 * work for a double blocked on a latch, so it provably can't touch the DB
 * during the measurement window regardless of scheduling. The "behavioral"
 * describe block below is the PRIMARY proof of the A-H1 guarantee; the
 * "buildHookDeliveryContext does no DB I/O" and "nothing between the 200
 * and enqueueHookProcessing" (source-text) checks after it are secondary —
 * cheap, fast, and still worth keeping as an early signal, but a structural
 * read of the source can't catch a bug the behavioral test would (e.g. an
 * await accidentally inserted inside buildHookDeliveryContext's callers
 * that the regex doesn't parse as "DB work").
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import "../db/__test_db.js";

const { buildHookDeliveryContext } = await import("./ingest.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { launchRequests } = await import("../db/schema/index.js");
const { processHookEvent } = await import("../services/event-processor.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

beforeAll(async () => {
	await initializeDatabase();
});

describe("buildHookDeliveryContext is synchronous and does no DB I/O", () => {
	test("attribution is read straight off the already-resolved authUser — no query, no await", () => {
		const headers = new Headers({ Authorization: "Bearer irrelevant" });
		const req = new Request("http://localhost/api/v1/hooks", { headers });
		const c = {
			get: () => undefined,
			req: { header: (name: string) => req.headers.get(name), raw: req },
		} as unknown as Parameters<typeof buildHookDeliveryContext>[0];

		const ctx = buildHookDeliveryContext(c);
		expect(ctx.attribution).toEqual({ ownerUserId: null, ingestKeyId: null });
	});
});

describe("behavioral: DB statements during the request equal the auth-alone baseline", () => {
	// A-H1's real guarantee, proven by behavior rather than reading the
	// source: swap enqueueHookProcessing for a double that blocks on a
	// latch before doing anything, so the detached background chain this
	// file's intro comment describes (the reason a naive countDbCalls-
	// around-app.request() measurement was rejected) genuinely cannot touch
	// the DB during the measurement window, however the microtask queue
	// happens to interleave. Count DB statements during the whole
	// app.request() call and assert it equals what resolving the same
	// Bearer key costs in isolation (the auth check) — not "low", exactly
	// equal, so any future statement added anywhere before the 200 fails
	// this test specifically instead of only showing up as a fuzzy latency
	// regression.
	test("a held-latch background task proves the request makes no DB call beyond auth", async () => {
		const { app } = await import("../app.js");
		const { createApiKey } = await import("../auth/api-key.js");
		const { getAuthUserFromHeaders } = await import("../auth/middleware.js");
		const { _setEnqueueHookProcessingOverrideForTest } = await import("./ingest.js");

		const { key } = await createApiKey(`ingest-latency-behavioral-${crypto.randomUUID()}`);
		const headers = new Headers({
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		});

		// Baseline: resolving this exact Bearer key, measured independently
		// of the route.
		const authBaseline = await countDbCalls(async () => {
			await getAuthUserFromHeaders(headers);
		});

		let releaseLatch: () => void = () => {};
		const latch = new Promise<void>((resolve) => {
			releaseLatch = resolve;
		});
		let overrideInvoked = false;
		_setEnqueueHookProcessingOverrideForTest(async () => {
			overrideInvoked = true;
			await latch;
		});

		try {
			const sessionId = `latency-behavioral-${crypto.randomUUID()}`;
			const callsDuringRequest = await countDbCalls(async () => {
				const res = await app.request("/api/v1/hooks", {
					method: "POST",
					headers,
					body: JSON.stringify({ session_id: sessionId, hook_event_name: "SessionStart" }),
				});
				expect(res.status).toBe(200);
			});

			// Sanity: the override actually ran — a routing mistake that left
			// the real enqueueHookProcessing in place would otherwise still
			// pass this assertion vacuously if its real work happened to also
			// cost zero extra statements by coincidence.
			expect(overrideInvoked).toBe(true);
			expect(callsDuringRequest).toBe(authBaseline);
		} finally {
			releaseLatch();
			_setEnqueueHookProcessingOverrideForTest(null);
		}
	});
});

describe("the 200 is constructed and returned with nothing between it and enqueueHookProcessing", () => {
	test("both POST /hooks response paths (normal and oversize-stub) call c.json, then enqueueHookProcessing, then return — no DB-touching statement in between", async () => {
		const source = await readFile(join(import.meta.dir, "ingest.ts"), "utf-8");

		// Every "const response = c.json(" site in this file must be followed,
		// with only enqueueHookProcessing's own call line in between, by
		// "return response" — never an await, a DB call, or any other
		// statement. This is the literal source-level guarantee the A-H1
		// comment documents.
		const allMatches = [...source.matchAll(/const response = c\.json\([^;]*\);\n([\s\S]*?)\n\}/g)];
		// Scoped to the two POST /hooks response paths specifically — the
		// file has a third, unrelated c.json(...) site on /hooks/status that
		// this test isn't about.
		const siteMatches = allMatches.filter((m) => m[1].includes("enqueueHookProcessing"));
		expect(siteMatches.length).toBe(2);

		for (const match of siteMatches) {
			const between = match[1];
			const lines = between
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0);
			// Accept only: enqueueHookProcessing(...) and return response;
			// (plus a trailing });  for the route registration, filtered above
			// by the outer \n\} boundary already).
			for (const line of lines) {
				const isAllowed =
					/^enqueueHookProcessing\(/.test(line) || line === "return response;" || line === "});";
				expect(isAllowed).toBe(true);
			}
			expect(between).not.toMatch(/\bawait\b/);
		}
	});
});

describe("per-event DB cost (measured inside processHookEvent, not racing a detached background task)", () => {
	test("pins the new-session and existing-session statement counts", async () => {
		const sessionId = `latency-cost-${crypto.randomUUID()}`;
		const ctx = {
			keyId: "key-cost-test",
			deliveryId: null,
			origin: "native" as const,
			attribution: { ownerUserId: "user-cost-test", ingestKeyId: "key-cost-test" },
		};

		const newSessionCalls = await countDbCalls(async () => {
			await processHookEvent(
				{ session_id: sessionId, hook_event_name: "SessionStart" },
				"claude_code",
				ctx,
			);
		});
		console.log(`[ingest-latency] new-session event: ${newSessionCalls} statements`);

		const existingSessionCalls = await countDbCalls(async () => {
			await processHookEvent(
				{ session_id: sessionId, hook_event_name: "PostToolUse" },
				"claude_code",
				ctx,
			);
		});
		console.log(`[ingest-latency] existing-session event: ${existingSessionCalls} statements`);

		// Pinned as measured, not derived: these are processHookEvent's full
		// statement counts for each case (insert-vs-update, latch metadata,
		// permission-wait tracking, and project-id resolution all differ
		// between a new and an existing row for reasons unrelated to
		// attribution) — not just attribution's own marginal share. The part
		// that's actually attribution's own cost: resolveObservedSessionCorrelation
		// is the one extra select on the new-session path only; the
		// existing-session path's fill/mismatch check reads no extra row (it
		// reuses the row already fetched for the isNew check) and writes an
		// extra statement only when the row was still both-null, which it
		// isn't here (this fixture's second event targets an already-owned
		// row). A regression that changes either total should fail this test.
		// The same count on both dialects (measured on SQLite and on Postgres):
		// statements issued on a Postgres transaction handle, such as the
		// permission-wait read-modify-write the existing-session case runs inside
		// withTransaction, are counted by countDbCalls too, so there is no
		// per-dialect number to pin.
		expect(newSessionCalls).toBe(10);
		expect(existingSessionCalls).toBe(8);
	});

	// The event-processor.ts comment at the correlation-resolver call site
	// used to say "one extra read-only select" for any new session — wrong
	// even before this branch: resolveObservedSessionCorrelation's own cost
	// varies with whether a pending launch actually matches. This pins the
	// matched case specifically (a pending launch whose launchCorrelationId
	// equals the new session's id) alongside the plain new/existing pins
	// above, so the comment's "up to 3 selects on this path" claim has a
	// real number backing it, not just an inspection of the source.
	test("pins the new-session-with-a-matching-pending-launch statement count", async () => {
		const sessionId = `latency-cost-launch-${crypto.randomUUID()}`;
		await getDb().insert(launchRequests).values({
			launchCorrelationId: sessionId,
			agentType: "claude_code",
			cwd: "/tmp/ingest-latency-launch-fixture",
			status: "validated",
		});

		const ctx = {
			keyId: "key-cost-test-launch",
			deliveryId: null,
			origin: "native" as const,
			attribution: { ownerUserId: "user-cost-test-launch", ingestKeyId: "key-cost-test-launch" },
		};

		const newSessionWithLaunchCalls = await countDbCalls(async () => {
			await processHookEvent(
				{ session_id: sessionId, hook_event_name: "SessionStart" },
				"claude_code",
				ctx,
			);
		});
		console.log(
			`[ingest-latency] new-session-with-matching-pending-launch event: ${newSessionWithLaunchCalls} statements`,
		);

		// Pinned as measured. Well above the plain new-session count: a
		// matched launch doesn't just cost resolveObservedSessionCorrelation's
		// own extra selects (the managed-row conflict check and the
		// pre-existing-session squat check) — isNew also triggers
		// associateObservedSession later in the same call, which does the
		// real attach + managed-row + running-transition writes. Not
		// re-derived from first principles, to match this file's existing
		// pinning style.
		// One more than before the key check: a real key that isn't the launch
		// requester's costs the mode read (team mode then judges it further).
		// The same count on both dialects (measured on SQLite and on Postgres).
		expect(newSessionWithLaunchCalls).toBe(19);
	});
});
