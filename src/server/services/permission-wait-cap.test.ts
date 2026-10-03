/**
 * A session's stored permission-wait ids are bounded. A hook stream can open
 * requests faster than anything closes them (or never close them), and each id
 * is kept in the session's metadata, which every stats poll reads. The newest
 * 256 ids are kept; older ones fold into the anonymous count, so the session
 * still reads as waiting for as many requests as were opened.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { events, sessions } = await import("../db/schema/index.js");
const { applyPermissionWaitTransition } = await import("./event-processor.js");
const { eq } = await import("drizzle-orm");

import type { HookEventPayload } from "../../shared/types.js";

const MAX_STORED_IDS = 256;

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(events).execute();
	await getDb().delete(sessions).execute();
	await getDb()
		.insert(sessions)
		.values({
			sessionId: "cap-1",
			displayName: "cap-1",
			agentType: "claude_code",
			status: "active",
			metadata: {},
			lastActivityAt: new Date().toISOString(),
		} as never)
		.execute();
});

const payload = (name: HookEventPayload["hook_event_name"], id?: string): HookEventPayload => ({
	session_id: "cap-1",
	hook_event_name: name,
	...(id ? { tool_use_id: id } : {}),
});

async function wait() {
	const [row] = await getDb().select().from(sessions).where(eq(sessions.sessionId, "cap-1"));
	return {
		semanticStatus: row?.semanticStatus,
		wait: (row?.metadata as { permissionWait?: { ids: string[]; anon: number } }).permissionWait,
	};
}

describe("stored permission-wait ids", () => {
	test("the newest 256 are kept and the older ones fold into the anonymous count", async () => {
		for (let i = 0; i < MAX_STORED_IDS + 44; i++) {
			await applyPermissionWaitTransition("cap-1", payload("PermissionRequest", `id-${i}`));
		}
		const { semanticStatus, wait: stored } = await wait();
		expect(semanticStatus).toBe("waiting");
		expect(stored?.ids).toHaveLength(MAX_STORED_IDS);
		expect(stored?.ids[0]).toBe("id-44");
		expect(stored?.ids.at(-1)).toBe(`id-${MAX_STORED_IDS + 43}`);
		expect(stored?.anon).toBe(44);
	});

	test("under the bound nothing changes", async () => {
		for (let i = 0; i < 5; i++) {
			await applyPermissionWaitTransition("cap-1", payload("PermissionRequest", `id-${i}`));
		}
		expect((await wait()).wait).toMatchObject({
			ids: ["id-0", "id-1", "id-2", "id-3", "id-4"],
			anon: 0,
		});
	});

	test("a kept id still clears, the folded ones keep the session waiting, and a new prompt clears them all", async () => {
		for (let i = 0; i < MAX_STORED_IDS + 3; i++) {
			await applyPermissionWaitTransition("cap-1", payload("PermissionRequest", `id-${i}`));
		}
		await applyPermissionWaitTransition(
			"cap-1",
			payload("PostToolUse", `id-${MAX_STORED_IDS + 2}`),
		);
		let state = await wait();
		expect(state.wait?.ids).toHaveLength(MAX_STORED_IDS - 1);
		expect(state.wait?.anon).toBe(3);
		expect(state.semanticStatus).toBe("waiting");

		await applyPermissionWaitTransition("cap-1", payload("UserPromptSubmit"));
		state = await wait();
		expect(state.wait).toBeUndefined();
	});

	for (const order of ["oldest first", "newest first"] as const) {
		test(`300 open requests all answered, ${order}, leave the session not waiting`, async () => {
			const open = 300;
			await getDb().update(sessions).set({ semanticStatus: "working" }).execute();
			for (let i = 0; i < open; i++) {
				await applyPermissionWaitTransition("cap-1", payload("PermissionRequest", `id-${i}`));
			}
			const answers = Array.from({ length: open }, (_, i) => `id-${i}`);
			if (order === "newest first") answers.reverse();
			for (const id of answers) {
				await applyPermissionWaitTransition("cap-1", payload("PostToolUse", id));
			}
			const state = await wait();
			expect(state.wait).toBeUndefined();
			expect(state.semanticStatus).toBe("working");
		});
	}

	test("an answer for an id nobody opened does nothing while no folded request is outstanding", async () => {
		await applyPermissionWaitTransition("cap-1", payload("PermissionRequest", "id-a"));
		await applyPermissionWaitTransition("cap-1", payload("PostToolUse", "unrelated"));
		expect((await wait()).wait).toMatchObject({ ids: ["id-a"], anon: 0 });
	});
});
