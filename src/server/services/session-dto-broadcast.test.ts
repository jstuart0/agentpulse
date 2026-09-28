/**
 * Phase 2 (D14/F48): mapSessionDto is the single choke point every
 * WebSocket session broadcast passes through (notifier.ts's
 * notifySessionCreated/notifySessionUpdated), so a raw DB row never reaches
 * useWebSocket.ts. Also proves GET /sessions and GET /sessions/:id carry
 * the same derived fields via REST.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { sessionBus, notifySessionCreated, notifySessionUpdated } = await import("./notifier.js");

const originalDisableAuth = config.disableAuth;

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});

afterAll(() => {
	config.disableAuth = originalDisableAuth;
});

beforeEach(async () => {
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
			...overrides,
		})
		.execute();
}

describe("GET /sessions and GET /sessions/:id carry nameSource/nativeName (REST)", () => {
	test("GET /sessions rows carry nameSource/nativeName", async () => {
		await mkSession("list-1", { metadata: { renameSource: "user" } });
		const res = await app.request("/api/v1/sessions");
		const body = await res.json();
		const row = body.sessions.find((s: { sessionId: string }) => s.sessionId === "list-1");
		expect(row.nameSource).toBe("user");
		expect(row.nativeName ?? null).toBeNull();
	});

	test("GET /sessions/:id carries nameSource/nativeName", async () => {
		await mkSession("detail-1", { metadata: { nativeName: "codex-thread-name" } });
		const res = await app.request("/api/v1/sessions/detail-1");
		const body = await res.json();
		expect(body.session.nameSource).toBe("generated");
		expect(body.session.nativeName).toBe("codex-thread-name");
	});
});

describe("notifier.ts — the WebSocket broadcast choke point maps every raw row (F48)", () => {
	test("notifySessionUpdated emits a mapped payload carrying nameSource/nativeName", async () => {
		const received = new Promise<{ nameSource: string; nativeName: string | null }>((resolve) => {
			sessionBus.once("session_updated", (session) => resolve(session as never));
		});
		notifySessionUpdated({
			id: "1",
			sessionId: "raw-1",
			displayName: "human-chosen-name",
			metadata: { renameSource: "user", nativeName: "claude-native-name" },
		});
		const emitted = await received;
		expect(emitted.nameSource).toBe("user");
		expect(emitted.nativeName).toBe("claude-native-name");
	});

	test("notifySessionCreated also maps its payload (same choke point)", async () => {
		const received = new Promise<{ nameSource: string }>((resolve) => {
			sessionBus.once("session_created", (session) => resolve(session as never));
		});
		notifySessionCreated({
			id: "2",
			sessionId: "raw-2",
			displayName: "brave-falcon",
			metadata: {},
		});
		const emitted = await received;
		expect(emitted.nameSource).toBe("generated");
	});

	test("the supervisor path (a raw managed-session-state row, e.g. supervisors.ts:237) goes through the same choke point", async () => {
		const received = new Promise<{ nameSource: string; nativeName: string | null }>((resolve) => {
			sessionBus.once("session_updated", (session) => resolve(session as never));
		});
		// Shape mirrors what supervisors.ts's notifySessionUpdated(result.session)
		// / notifySessionUpdated(session) call sites pass — a raw sessions row.
		notifySessionUpdated({
			id: "3",
			sessionId: "supervisor-raw-1",
			displayName: "codex-thread-name",
			metadata: { lastAppliedNativeName: "codex-thread-name", nativeName: "codex-thread-name" },
		});
		const emitted = await received;
		expect(emitted.nameSource).toBe("native");
		expect(emitted.nativeName).toBe("codex-thread-name");
	});
});
