import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { processHookEvent, applyPermissionWaitTransition } = await import("./event-processor.js");
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

	test("a tool_use_id not present in ids does not accidentally decrement anon", async () => {
		await mkSession("perm-1", {
			semanticStatus: "waiting",
			metadata: { permissionWait: { ids: [], anon: 1, prevStatus: "planning" } },
		});

		await applyPermissionWaitTransition(
			"perm-1",
			hookPayload({ hook_event_name: "PostToolUse", tool_use_id: "unrelated" }),
		);

		const row = await getSession("perm-1");
		expect(row?.semanticStatus).toBe("waiting");
		expect(row?.metadata).toEqual({
			permissionWait: { ids: [], anon: 1, prevStatus: "planning" },
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
