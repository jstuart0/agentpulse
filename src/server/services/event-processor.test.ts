import { afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { processHookEvent, applyPermissionWaitTransition, detectAgentType } = await import(
	"./event-processor.js"
);
const { eq } = await import("drizzle-orm");

import type { HookEventPayload, SemanticStatus } from "../../shared/types.js";

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
});

async function mkSession(sessionId: string, overrides: Record<string, unknown> = {}) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			isWorking: false,
			lastActivityAt: new Date().toISOString(),
			metadata: {},
			...overrides,
		})
		.execute();
}

async function getSession(sessionId: string) {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, sessionId));
	return row;
}

function hookPayload(overrides: Partial<HookEventPayload>): HookEventPayload {
	return {
		session_id: "perm-1",
		hook_event_name: "PermissionRequest",
		...overrides,
	};
}

describe("processHookEvent — permission-wait baseline (Decision 10)", () => {
	test("PermissionRequest flips semanticStatus to waiting, captures prevStatus on 0→1, leaves isWorking untouched", async () => {
		await mkSession("perm-1", { semanticStatus: "implementing", isWorking: false });

		await processHookEvent(
			hookPayload({ hook_event_name: "PermissionRequest", tool_use_id: "a" }),
			"claude_code",
		);

		const row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("waiting");
		expect(row?.metadata).toEqual({
			permissionWait: { ids: ["a"], anon: 0, prevStatus: "implementing" },
		});
		expect(row?.isWorking).toBe(false);
	});
});

describe("processHookEvent — matching clear restores and deletes", () => {
	test("PermissionDenied with matching tool_use_id restores prevStatus and deletes permissionWait", async () => {
		await mkSession("perm-1", {
			semanticStatus: "waiting",
			metadata: { permissionWait: { ids: ["a"], anon: 0, prevStatus: "implementing" } },
		});

		await processHookEvent(
			hookPayload({ hook_event_name: "PermissionDenied", tool_use_id: "a" }),
			"claude_code",
		);

		const row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("implementing");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
	});

	test("PostToolUse with matching tool_use_id restores prevStatus and deletes permissionWait", async () => {
		await mkSession("perm-1", {
			semanticStatus: "waiting",
			metadata: { permissionWait: { ids: ["a"], anon: 0, prevStatus: "implementing" } },
		});

		await processHookEvent(
			hookPayload({ hook_event_name: "PostToolUse", tool_use_id: "a", tool_name: "Bash" }),
			"claude_code",
		);

		const row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("implementing");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
	});

	test("a PermissionRequest followed by PostToolUseFailure on the same tool_use_id clears the wait and restores status", async () => {
		await mkSession("perm-1", { semanticStatus: "implementing" });

		await processHookEvent(
			hookPayload({ hook_event_name: "PermissionRequest", tool_use_id: "a", tool_name: "Bash" }),
			"claude_code",
		);
		let row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("waiting");
		expect(row?.metadata).toMatchObject({
			permissionWait: { ids: ["a"], anon: 0, prevStatus: "implementing" },
		});

		// The tool resolved, just unsuccessfully — the wait must clear exactly
		// like a successful PostToolUse would.
		await processHookEvent(
			hookPayload({ hook_event_name: "PostToolUseFailure", tool_use_id: "a", tool_name: "Bash" }),
			"claude_code",
		);
		row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("implementing");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
	});
});

describe("applyPermissionWaitTransition — no-op on unmatched tool_use_id", () => {
	test("PostToolUse with an id not in the pending set is a byte-for-byte no-op", async () => {
		await mkSession("perm-1", {
			semanticStatus: "waiting",
			metadata: { permissionWait: { ids: ["a"], anon: 0, prevStatus: "implementing" } },
		});

		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PostToolUse", tool_use_id: "z" }),
		);

		const row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("waiting");
		expect(row?.metadata).toEqual({
			permissionWait: { ids: ["a"], anon: 0, prevStatus: "implementing" },
		});
	});
});

describe("applyPermissionWaitTransition — concurrent/nested prompts", () => {
	test("prevStatus captured exactly once at the 0→1 transition, never overwritten as waiting", async () => {
		await mkSession("perm-1", { semanticStatus: "implementing" });

		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PermissionRequest", tool_use_id: "a" }),
		);
		let row = await getSession("perm-1");
		expect(row?.metadata).toMatchObject({
			permissionWait: { ids: ["a"], anon: 0, prevStatus: "implementing" },
		});

		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PermissionRequest", tool_use_id: "b" }),
		);
		row = await getSession("perm-1");
		expect(row?.metadata).toMatchObject({
			permissionWait: { ids: ["a", "b"], anon: 0, prevStatus: "implementing" },
		});
		expect(row?.semanticStatus).toBe("waiting");

		// Clear A — pending drops to 1, restore must not fire yet.
		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PermissionDenied", tool_use_id: "a" }),
		);
		row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("waiting");
		expect(row?.metadata).toMatchObject({
			permissionWait: { ids: ["b"], anon: 0, prevStatus: "implementing" },
		});

		// Clear B — pending reaches 0, restore fires.
		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PermissionDenied", tool_use_id: "b" }),
		);
		row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("implementing");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
	});
});

describe("applyPermissionWaitTransition — owned-status guard (order-independent by construction)", () => {
	// codex r2 finding: the restore must be an atomic conditional write (WHERE
	// semantic_status = 'waiting' at UPDATE time), not a decision made from an
	// early read inside the same transaction — processStatusUpdate writes
	// semanticStatus in its own background task, outside this helper's
	// transaction/queue, and can land between the read and the write. There's
	// no honest seam to inject a write literally between this helper's
	// internal SELECT and UPDATE from a test, so this pins the conditional
	// write's observable contract instead: seed a status change that landed
	// after the wait was recorded, then run the clear, and assert the newer
	// status survives AND permissionWait is still removed. A regression to
	// deciding the restore from a stale early read rather than the live
	// row state would only be caught by an interleaving this test can't
	// literally construct — the WHERE-predicate implementation is what
	// closes that gap (see the implementation comment at the restore site).
	test("a fresher agent-reported status is never clobbered by a stale prevStatus restore", async () => {
		await mkSession("perm-1", { semanticStatus: "implementing" });

		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PermissionRequest", tool_use_id: "a" }),
		);
		let row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("waiting");

		// Simulate processStatusUpdate landing mid-wait — sets a fresher status
		// directly, independent of the permission path.
		await getDb()
			.update(sessions)
			.set({ semanticStatus: "reviewing" satisfies SemanticStatus })
			.where(eq(sessions.sessionId, "perm-1"));

		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PostToolUse", tool_use_id: "a" }),
		);
		row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("reviewing");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
	});
});

describe("applyPermissionWaitTransition — sequential merge-preservation across chained calls", () => {
	// NOTE: applyPermissionWaitTransition serializes same-session calls through
	// an internal per-process FIFO queue (see the queue comment in
	// event-processor.ts), so this Promise.all is deterministically resolved
	// in call order by that queue — it does NOT exercise true transaction-level
	// interleaving on the DB connection. What it does prove: the late
	// read-modify-write correctly preserves unrelated metadata keys and never
	// drives the pending count negative across a chain of calls issued
	// concurrently from the caller's perspective. Real cross-connection races
	// (e.g. multi-replica Postgres, once the single-replica constraint is
	// lifted) are out of scope for this test and would need dedicated coverage
	// at that point — the in-process queue provides no cross-process protection.
	test("chained requests + a clear preserve unrelated metadata and never go negative", async () => {
		await mkSession("perm-1", {
			semanticStatus: "implementing",
			metadata: { launchProvenance: "test-marker" },
		});

		await Promise.all([
			applyPermissionWaitTransition(
				"perm-1",
				hookPayload({ hook_event_name: "PermissionRequest", tool_use_id: "a" }),
			),
			applyPermissionWaitTransition(
				"perm-1",
				hookPayload({ hook_event_name: "PermissionRequest", tool_use_id: "b" }),
			),
			applyPermissionWaitTransition(
				"perm-1",
				hookPayload({ hook_event_name: "PermissionDenied", tool_use_id: "a" }),
			),
		]);

		const row = await getSession("perm-1");
		const metadata = row?.metadata as Record<string, unknown>;
		expect(metadata.launchProvenance).toBe("test-marker");

		const wait = metadata.permissionWait as
			| { ids: string[]; anon: number; prevStatus: string | null }
			| undefined;
		if (wait) {
			expect(wait.prevStatus).not.toBe("waiting");
			expect(wait.ids.length + wait.anon).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("applyPermissionWaitTransition — self-healing after adverse reordering", () => {
	test("(i) a delayed prior-turn boundary clear drops a real wait; the eventual matching clear no-ops harmlessly", async () => {
		await mkSession("perm-1", { semanticStatus: "implementing" });

		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PermissionRequest", tool_use_id: "a" }),
		);
		let row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("waiting");

		// Delayed prior-turn boundary clear commits late.
		await applyPermissionWaitTransition("perm-1", hookPayload({ hook_event_name: "Stop" }));
		row = await getSession("perm-1");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
		expect(row?.semanticStatus).toBe("implementing");

		// The eventual matching clear for "a" arrives — no-ops harmlessly.
		await expect(
			applyPermissionWaitTransition(
				"perm-1",
				hookPayload({ hook_event_name: "PermissionDenied", tool_use_id: "a" }),
			),
		).resolves.toBeUndefined();
		row = await getSession("perm-1");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
		expect(row?.semanticStatus).toBe("implementing");
	});

	test("(ii) a delayed old-turn PermissionRequest resurrects waiting after its boundary clear already ran — healed by the next boundary event", async () => {
		await mkSession("perm-1", { semanticStatus: "implementing" });

		// Boundary clear runs first — no-op (nothing to clear).
		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "UserPromptSubmit" }),
		);
		let row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("implementing");
		expect(row?.metadata).not.toHaveProperty("permissionWait");

		// Delayed old-turn PermissionRequest commits late — resurrects "waiting".
		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PermissionRequest", tool_use_id: "stale" }),
		);
		row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("waiting");

		// The next boundary event converges the session back to no-pending.
		await applyPermissionWaitTransition("perm-1", hookPayload({ hook_event_name: "Stop" }));
		row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("implementing");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
	});
});

describe("applyPermissionWaitTransition — boundary full clear", () => {
	test("UserPromptSubmit clears all pending waits in one shot and restores over owned waiting", async () => {
		await mkSession("perm-1", {
			semanticStatus: "waiting",
			metadata: { permissionWait: { ids: ["a", "b"], anon: 1, prevStatus: "implementing" } },
		});

		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "UserPromptSubmit" }),
		);

		const row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("implementing");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
	});

	test("Stop clears all pending waits in one shot and restores over owned waiting", async () => {
		await mkSession("perm-1", {
			semanticStatus: "waiting",
			metadata: { permissionWait: { ids: ["a", "b"], anon: 1, prevStatus: "implementing" } },
		});

		await applyPermissionWaitTransition("perm-1", hookPayload({ hook_event_name: "Stop" }));

		const row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("implementing");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
	});

	test("boundary clear deletes permissionWait but does not restore over a fresher status", async () => {
		await mkSession("perm-1", {
			semanticStatus: "reviewing",
			metadata: { permissionWait: { ids: ["a"], anon: 0, prevStatus: "implementing" } },
		});

		await applyPermissionWaitTransition("perm-1", hookPayload({ hook_event_name: "Stop" }));

		const row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("reviewing");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
	});

	// D21 (post-merge E4): SessionEnd and Interrupt are terminal boundaries
	// too — a session that ends or is interrupted while "waiting" must have
	// its waits dropped and semanticStatus restored, the same as a fresh
	// prompt or a completed turn.
	test("SessionEnd clears all pending waits in one shot and restores over owned waiting", async () => {
		await mkSession("perm-1", {
			semanticStatus: "waiting",
			metadata: { permissionWait: { ids: ["a", "b"], anon: 1, prevStatus: "implementing" } },
		});

		await applyPermissionWaitTransition("perm-1", hookPayload({ hook_event_name: "SessionEnd" }));

		const row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("implementing");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
	});

	test("Interrupt clears all pending waits in one shot and restores over owned waiting", async () => {
		await mkSession("perm-1", {
			semanticStatus: "waiting",
			metadata: { permissionWait: { ids: ["a", "b"], anon: 1, prevStatus: "implementing" } },
		});

		await applyPermissionWaitTransition("perm-1", hookPayload({ hook_event_name: "Interrupt" }));

		const row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("implementing");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
	});
});

describe("applyPermissionWaitTransition — SessionStart crash-recovery boundary clear", () => {
	test("a persisted wait from a crashed process clears on SessionStart with owned-status restore", async () => {
		await mkSession("perm-1", {
			semanticStatus: "waiting",
			metadata: { permissionWait: { ids: ["a"], anon: 0, prevStatus: "implementing" } },
		});

		await applyPermissionWaitTransition("perm-1", hookPayload({ hook_event_name: "SessionStart" }));

		const row = await getSession("perm-1");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
		expect(row?.semanticStatus).toBe("implementing");
	});
});

describe("applyPermissionWaitTransition — anonymous fallback", () => {
	test("PermissionRequest/PermissionDenied without tool_use_id use the anon counter", async () => {
		await mkSession("perm-1", { semanticStatus: "planning" });

		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PermissionRequest" }),
		);
		let row = await getSession("perm-1");
		expect(row?.metadata).toEqual({
			permissionWait: { ids: [], anon: 1, prevStatus: "planning" },
		});
		expect(row?.semanticStatus).toBe("waiting");

		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PermissionDenied" }),
		);
		row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("planning");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
	});

	test("a tool_use_id not present in ids answers one anonymous request, which may be a folded id", async () => {
		await mkSession("perm-1", {
			semanticStatus: "waiting",
			metadata: { permissionWait: { ids: ["kept"], anon: 2, prevStatus: "planning" } },
		});

		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PostToolUse", tool_use_id: "folded" }),
		);

		const row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("waiting");
		expect(row?.metadata).toEqual({
			permissionWait: { ids: ["kept"], anon: 1, prevStatus: "planning" },
		});
	});
});

describe("applyPermissionWaitTransition — no-op cheapness, unconditional invocation", () => {
	const clearCapableEvents: HookEventPayload["hook_event_name"][] = [
		"PermissionDenied",
		"PostToolUse",
		"PostToolUseFailure",
		"UserPromptSubmit",
		"Stop",
		"SessionStart",
	];

	for (const eventName of clearCapableEvents) {
		test(`${eventName} on a session with no permissionWait is a true no-op`, async () => {
			await mkSession("perm-1", { semanticStatus: "reviewing", metadata: { untouched: true } });

			await applyPermissionWaitTransition("perm-1", hookPayload({ hook_event_name: eventName }));

			const row = await getSession("perm-1");
			expect(row?.semanticStatus).toBe("reviewing");
			expect(row?.metadata).toEqual({ untouched: true });
		});
	}
});

describe("detectAgentType — header-only detection (F8, Decision 7)", () => {
	test("X-Agent-Type: claude_code header wins regardless of payload shape", () => {
		expect(detectAgentType("claude_code", hookPayload({}))).toBe("claude_code");
	});

	test("X-Agent-Type: codex_cli header wins regardless of payload shape", () => {
		expect(detectAgentType("codex_cli", hookPayload({}))).toBe("codex_cli");
	});

	test("missing header defaults to claude_code, with no payload-shape fallback", () => {
		expect(detectAgentType(undefined, hookPayload({}))).toBe("claude_code");
	});

	test("missing header defaults to claude_code even with an unrecognized header value", () => {
		expect(detectAgentType("something_else", hookPayload({}))).toBe("claude_code");
	});

	test("empty string header defaults to claude_code (D5 Pattern A' set-membership rewrite)", () => {
		expect(detectAgentType("", hookPayload({}))).toBe("claude_code");
	});
});

describe("applyPermissionWaitTransition — prior status null/unset at the 0→1 transition", () => {
	test("null prevStatus is recorded faithfully and restored as null, not coerced", async () => {
		await mkSession("perm-1", { semanticStatus: null });

		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PermissionRequest", tool_use_id: "a" }),
		);
		let row = await getSession("perm-1");
		expect(row?.metadata).toEqual({
			permissionWait: { ids: ["a"], anon: 0, prevStatus: null },
		});

		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PermissionDenied", tool_use_id: "a" }),
		);
		row = await getSession("perm-1");
		expect(row?.semanticStatus).toBeNull();
		expect(row?.metadata).not.toHaveProperty("permissionWait");
	});
});

// ── D21: delivery-order tolerance for detached Codex hooks ─────────────────
//
// Every timing case in this block uses one fake clock (bun:test's
// setSystemTime, reset in afterEach) — processHookEvent reads new Date()
// internally, so this is the seam. See the plan's Decision 21 for the exact
// boundary semantics.
describe("processHookEvent — D21 out-of-order tolerance (terminal latch, closed turns)", () => {
	const T0 = Date.parse("2026-09-29T12:00:00.000Z");

	afterEach(() => setSystemTime());

	async function eventCount(sessionId: string) {
		const rows = await getDb().select().from(events).where(eq(events.sessionId, sessionId));
		return rows.length;
	}

	test("terminal latch: a late Stop and PostToolUse at +10s don't reanimate a SessionEnd'd session, but are stored", async () => {
		setSystemTime(T0);
		await processHookEvent({ session_id: "codex-1", hook_event_name: "SessionEnd" }, "codex_cli");
		let row = await getSession("codex-1");
		expect(row?.status).toBe("completed");
		expect(row?.isWorking).toBe(false);

		setSystemTime(T0 + 10_000);
		await processHookEvent({ session_id: "codex-1", hook_event_name: "Stop" }, "codex_cli");
		await processHookEvent(
			{ session_id: "codex-1", hook_event_name: "PostToolUse", tool_name: "Bash" },
			"codex_cli",
		);

		row = await getSession("codex-1");
		expect(row?.status).toBe("completed");
		expect(row?.isWorking).toBe(false);
		expect(await eventCount("codex-1")).toBe(3);
	});

	test("exact boundary: 29.999s still latched, 30.000s and 30.001s reanimate", async () => {
		setSystemTime(T0);
		await processHookEvent({ session_id: "codex-2", hook_event_name: "SessionEnd" }, "codex_cli");

		setSystemTime(T0 + 29_999);
		await processHookEvent({ session_id: "codex-2", hook_event_name: "PostToolUse" }, "codex_cli");
		expect((await getSession("codex-2"))?.status).toBe("completed");

		setSystemTime(T0 + 30_000);
		await processHookEvent({ session_id: "codex-2", hook_event_name: "PostToolUse" }, "codex_cli");
		expect((await getSession("codex-2"))?.status).toBe("active");

		// Re-latch for the 30.001s case.
		setSystemTime(T0);
		await processHookEvent({ session_id: "codex-3", hook_event_name: "SessionEnd" }, "codex_cli");
		setSystemTime(T0 + 30_001);
		await processHookEvent({ session_id: "codex-3", hook_event_name: "PostToolUse" }, "codex_cli");
		expect((await getSession("codex-3"))?.status).toBe("active");
	});

	test("SessionEnd then UserPromptSubmit at +5s reanimates (a real resume)", async () => {
		setSystemTime(T0);
		await processHookEvent({ session_id: "codex-4", hook_event_name: "SessionEnd" }, "codex_cli");

		setSystemTime(T0 + 5_000);
		await processHookEvent(
			{ session_id: "codex-4", hook_event_name: "UserPromptSubmit", prompt: "go" },
			"codex_cli",
		);
		const row = await getSession("codex-4");
		expect(row?.status).toBe("active");
		expect(row?.isWorking).toBe(true);
	});

	test("closed turns: a late PreToolUse for an Interrupt'd turn_id doesn't reopen isWorking; a new turn_id does", async () => {
		setSystemTime(T0);
		await processHookEvent(
			{ session_id: "codex-5", hook_event_name: "Interrupt", turn_id: "t1" },
			"codex_cli",
		);
		expect((await getSession("codex-5"))?.isWorking).toBe(false);

		await processHookEvent(
			{ session_id: "codex-5", hook_event_name: "PreToolUse", turn_id: "t1", tool_name: "Bash" },
			"codex_cli",
		);
		expect((await getSession("codex-5"))?.isWorking).toBe(false);

		await processHookEvent(
			{ session_id: "codex-5", hook_event_name: "PreToolUse", turn_id: "t2", tool_name: "Bash" },
			"codex_cli",
		);
		expect((await getSession("codex-5"))?.isWorking).toBe(true);
	});

	test("permission-wait x latch: a PermissionRequest inside the latch opens no wait; outside it, it does", async () => {
		setSystemTime(T0);
		await processHookEvent({ session_id: "codex-6", hook_event_name: "SessionEnd" }, "codex_cli");

		setSystemTime(T0 + 5_000);
		await processHookEvent(
			{ session_id: "codex-6", hook_event_name: "PermissionRequest", tool_use_id: "a" },
			"codex_cli",
		);
		let row = await getSession("codex-6");
		expect(row?.semanticStatus).not.toBe("waiting");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
		expect(row?.status).toBe("completed");
		expect(await eventCount("codex-6")).toBe(2);

		setSystemTime(T0 + 30_001);
		await processHookEvent(
			{ session_id: "codex-6", hook_event_name: "PermissionRequest", tool_use_id: "b" },
			"codex_cli",
		);
		row = await getSession("codex-6");
		expect(row?.semanticStatus).toBe("waiting");
		expect(row?.status).toBe("active");
	});

	test("permission-wait x closed turn: a PermissionRequest on a closed turn_id opens no wait; a new turn_id does", async () => {
		setSystemTime(T0);
		await processHookEvent(
			{ session_id: "codex-7", hook_event_name: "Interrupt", turn_id: "t1" },
			"codex_cli",
		);

		await processHookEvent(
			{
				session_id: "codex-7",
				hook_event_name: "PermissionRequest",
				turn_id: "t1",
				tool_use_id: "b",
			},
			"codex_cli",
		);
		let row = await getSession("codex-7");
		expect(row?.metadata).not.toHaveProperty("permissionWait");

		await processHookEvent(
			{
				session_id: "codex-7",
				hook_event_name: "PermissionRequest",
				turn_id: "t2",
				tool_use_id: "c",
			},
			"codex_cli",
		);
		row = await getSession("codex-7");
		expect(row?.semanticStatus).toBe("waiting");
	});

	test("terminal boundary clears an outstanding wait: SessionEnd restores semanticStatus and the wait doesn't resurface", async () => {
		await mkSession("codex-8", {
			agentType: "codex_cli",
			semanticStatus: "waiting",
			metadata: { permissionWait: { ids: ["c"], anon: 0, prevStatus: "implementing" } },
		});

		setSystemTime(T0);
		await processHookEvent({ session_id: "codex-8", hook_event_name: "SessionEnd" }, "codex_cli");
		let row = await getSession("codex-8");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
		expect(row?.semanticStatus).toBe("implementing");
		expect(row?.status).toBe("completed");

		setSystemTime(T0 + 3_000);
		await processHookEvent(
			{ session_id: "codex-8", hook_event_name: "PostToolUse", tool_use_id: "c" },
			"codex_cli",
		);
		row = await getSession("codex-8");
		expect(row?.semanticStatus).toBe("implementing");
		expect(row?.status).toBe("completed");
	});

	test("terminal boundary clears an outstanding wait: Interrupt also restores semanticStatus", async () => {
		await mkSession("codex-9", {
			agentType: "codex_cli",
			semanticStatus: "waiting",
			metadata: { permissionWait: { ids: ["d"], anon: 0, prevStatus: "researching" } },
		});

		setSystemTime(T0);
		await processHookEvent({ session_id: "codex-9", hook_event_name: "Interrupt" }, "codex_cli");
		const row = await getSession("codex-9");
		expect(row?.metadata).not.toHaveProperty("permissionWait");
		expect(row?.semanticStatus).toBe("researching");
		expect(row?.isWorking).toBe(false);
	});

	test("Codex SessionEnd completes the session the same as Claude's existing SessionEnd path", async () => {
		setSystemTime(T0);
		await processHookEvent({ session_id: "codex-10", hook_event_name: "SessionEnd" }, "codex_cli");
		const row = await getSession("codex-10");
		expect(row?.status).toBe("completed");
		expect(row?.isWorking).toBe(false);
		expect(row?.endedAt).not.toBeNull();
	});

	test("Interrupt sets isWorking=false the same as Stop", async () => {
		await mkSession("codex-11", { agentType: "codex_cli", isWorking: true });
		await processHookEvent({ session_id: "codex-11", hook_event_name: "Interrupt" }, "codex_cli");
		expect((await getSession("codex-11"))?.isWorking).toBe(false);
	});
});
