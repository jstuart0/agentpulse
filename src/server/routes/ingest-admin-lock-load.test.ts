/**
 * Hooks over real HTTP while refused admin-locked operations run. A hook is
 * answered before its database work, so a write that fails afterwards is lost
 * silently: the only honest check is to count events stored against hooks sent.
 * Regression net for hook transactions colliding with the admin lock on SQLite.
 *
 * Runs on both backends, but the work is sized per backend: on Postgres every
 * operation queues for one of a small pool of connections behind the hook
 * workers, so an operation costs ~100x more wall time than on SQLite and a
 * slow CI runner would otherwise blow the timeout. A body that outlives its
 * timeout keeps hammering the shared database during later test files, so the
 * loop carries its own deadline and always stops the workers.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { inArray, like } from "drizzle-orm";
import { Hono } from "hono";

import { isPostgresTest } from "../test-utils/backend.js";

await import("../db/__test_db.js");

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { events, sessions, users, apiKeys } = await import("../db/schema/index.js");
const { ingest } = await import("../routes/ingest.js");
const { getInFlightCount, getRateLimitedDropped } = await import("../routes/ingest-counters.js");
const { _setRateLimitClockForTest } = await import("../middleware/hook-rate-limit.js");
const { createApiKey, SCOPE_INGEST } = await import("../auth/api-key.js");
const { setUserRole, LastAdminError } = await import("../services/user-management.js");
const { applyApiKeyPatch, KeyNotManageError } = await import("../services/service-keys.js");
const { OwnerDisabledError } = await import("../auth/owner-state.js");

const OPS = isPostgresTest ? 30 : 100;
const TEST_TIMEOUT_MS = 90000;
const LOOP_DEADLINE_MS = 60000;
const CONC = 16;
const OP_GAP_MS = 1;

let server: ReturnType<typeof Bun.serve>;
let hookKey = "";
let url = "";
const origDisable = config.disableAuth;

beforeAll(async () => {
	// The limiter's capacity is fixed at import time (and other test files may have
	// imported it first), and it drops over-limit hooks with a silent 200. A clock
	// that moves a second per call keeps every bucket full, so every 200 is a stored hook.
	let nowMs = 0;
	_setRateLimitClockForTest(() => {
		nowMs += 1000;
		return nowMs;
	});
	await initializeDatabase();
	config.disableAuth = false;
	const app = new Hono();
	app.route("/api/v1", ingest);
	server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (r) => app.fetch(r) });
	url = `http://127.0.0.1:${server.port}/api/v1/hooks`;
	hookKey = (await createApiKey("probe-hook", [SCOPE_INGEST])).key;
});
afterAll(() => {
	_setRateLimitClockForTest(null);
	config.disableAuth = origDisable;
	server.stop(true);
});

let seq = 0;
const sentIds = new Set<string>();
async function hookWorker(run: string, stop: { v: boolean }) {
	while (!stop.v) {
		const id = `tx-${run}-${seq++}`;
		try {
			const r = await fetch(url, {
				method: "POST",
				headers: { authorization: `Bearer ${hookKey}`, "content-type": "application/json" },
				body: JSON.stringify({
					session_id: id,
					hook_event_name: "UserPromptSubmit",
					prompt: "p",
					cwd: "/work/probe",
				}),
			});
			await r.text();
			if (r.status === 200) sentIds.add(id);
		} catch {
			/* not counted as sent */
		}
	}
}

async function drain() {
	let stable = 0;
	const start = Date.now();
	while (stable < 5) {
		if (getInFlightCount() === 0) stable++;
		else stable = 0;
		if (Date.now() - start > 30000) throw new Error("drain timeout");
		await new Promise((r) => setTimeout(r, 20));
	}
}

async function adminUser(label: string, extra: Record<string, unknown> = {}) {
	const [row] = await getDb()
		.insert(users)
		.values({
			username: `${label}-${crypto.randomUUID().slice(0, 8)}`,
			passwordHash: "!",
			role: "admin",
			authSource: "local",
			...extra,
		})
		.returning({ id: users.id });
	return row.id as string;
}
async function cleanup() {
	await getDb().delete(users);
	await getDb().delete(apiKeys).where(like(apiKeys.name, "probe-op-%"));
}

type Op = { name: string; run: () => Promise<void>; err: new (...a: never[]) => Error };
const ops: Op[] = [
	{
		name: "last-admin-demote",
		err: LastAdminError as never,
		run: async () => {
			const a = await adminUser("b");
			try {
				await setUserRole(a, "user", { userId: a, label: "user" } as never);
			} finally {
				await cleanup();
			}
		},
	},
	{
		name: "key-patch-refused",
		err: KeyNotManageError as never,
		run: async () => {
			const k = await createApiKey("probe-op-pk", [SCOPE_INGEST]);
			try {
				await applyApiKeyPatch(k.id, { adminService: true }, true);
			} finally {
				await cleanup();
			}
		},
	},
	{
		name: "mint-for-disabled-owner",
		err: OwnerDisabledError as never,
		run: async () => {
			const u = await adminUser("d", { role: "user", disabledAt: new Date().toISOString() });
			try {
				await createApiKey("probe-op-dk", [SCOPE_INGEST], u);
			} finally {
				await cleanup();
			}
		},
	},
];

test(
	"every hook answered 200 has its session and event stored while refused locked operations run",
	async () => {
		const run = crypto.randomUUID().slice(0, 6);
		const droppedBefore = getRateLimitedDropped();
		const stop = { v: false };
		const workers = Array.from({ length: CONC }, () => hookWorker(run, stop));
		const perOp: Record<string, { ran: number; refused: number }> = {};
		const startedAt = Date.now();
		try {
			for (let i = 0; i < OPS; i++) {
				if (Date.now() - startedAt > LOOP_DEADLINE_MS)
					throw new Error(`operation loop exceeded ${LOOP_DEADLINE_MS}ms at op ${i}/${OPS}`);
				await new Promise((r) => setTimeout(r, OP_GAP_MS));
				const op = ops[i % ops.length];
				const rec = perOp[op.name] ?? { ran: 0, refused: 0 };
				perOp[op.name] = rec;
				rec.ran++;
				try {
					await op.run();
				} catch (e) {
					if (e instanceof (op.err as never)) rec.refused++;
					else throw e;
				}
			}
		} finally {
			stop.v = true;
			await Promise.all(workers);
		}
		expect(sentIds.size).toBeGreaterThan(100);
		await drain();

		const ids = [...sentIds].filter((id) => id.startsWith(`tx-${run}-`));
		let sessionRows = 0;
		let eventSessions = 0;
		for (let i = 0; i < ids.length; i += 500) {
			const chunk = ids.slice(i, i + 500);
			const s = await getDb()
				.select({ id: sessions.sessionId })
				.from(sessions)
				.where(inArray(sessions.sessionId, chunk));
			sessionRows += s.length;
			const e = await getDb()
				.select({ id: events.sessionId })
				.from(events)
				.where(inArray(events.sessionId, chunk));
			eventSessions += new Set(e.map((r: { id: string }) => r.id)).size;
		}
		for (const [name, r] of Object.entries(perOp))
			expect(`${name}:${r.refused}`).toBe(`${name}:${r.ran}`);
		expect(getRateLimitedDropped()).toBe(droppedBefore);
		expect(sessionRows).toBe(ids.length);
		expect(eventSessions).toBe(ids.length);
	},
	TEST_TIMEOUT_MS,
);
