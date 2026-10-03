/**
 * WebSocket identity: the upgrade resolves who is connecting, the open
 * handler records it, and the server can close one user's sockets (on
 * disable) without touching anyone else's. Drives the real upgrade path
 * against a real Bun.serve and a real WebSocket client, plus a directly
 * callable heartbeat sweep for the "another replica disabled the user" case.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { config } = await import("../config.js");
const { users, apiKeys } = await import("../db/schema/index.js");
const { createUser, issueSession, SESSION_COOKIE_NAME } = await import(
	"../services/local-auth-service.js"
);
const { createApiKey } = await import("../auth/api-key.js");
const {
	handleWsOpen,
	handleWsMessage,
	handleWsClose,
	closeSocketsForUser,
	heartbeatTick,
	initWsBroadcaster,
	broadcast,
	getConnectionCount,
} = await import("./handler.js");
const { handleWsUpgradeRequest } = await import("./ws-auth.js");

const originalDisableAuth = config.disableAuth;
const ORIGIN = config.allowedOrigins[0] as string;

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";
const openedSockets: WebSocket[] = [];

beforeAll(async () => {
	await initializeDatabase();
	(config as Record<string, unknown>).disableAuth = false;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req, srv) {
			return handleWsUpgradeRequest(req, srv as Parameters<typeof handleWsUpgradeRequest>[1]);
		},
		websocket: { open: handleWsOpen, message: handleWsMessage, close: handleWsClose },
	});
	baseUrl = `127.0.0.1:${server.port}`;
});

afterEach(async () => {
	for (const ws of openedSockets.splice(0)) {
		try {
			ws.close();
		} catch {
			// already closed
		}
	}
	await resetIdentityState();
});

afterAll(() => {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	server.stop(true);
});

interface TestSocket {
	ws: WebSocket;
	messages: Array<{ type: string; data: unknown }>;
	closed: Promise<{ code: number; reason: string }>;
}

async function connect(headers: Record<string, string>): Promise<TestSocket> {
	const ws = new WebSocket(`ws://${baseUrl}/api/v1/ws`, {
		headers: { Origin: ORIGIN, ...headers },
	} as unknown as string[]);
	openedSockets.push(ws);
	const messages: TestSocket["messages"] = [];
	ws.addEventListener("message", (e) => {
		const parsed = JSON.parse(String(e.data)) as { type: string; data: unknown };
		if (parsed.type !== "heartbeat") messages.push(parsed);
	});
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }));
	});
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("socket did not open")));
	});
	// Let the server-side open handler register the client before the test acts.
	await Bun.sleep(20);
	return { ws, messages, closed };
}

/** What the real upgrade path answers a request with, without opening a socket. */
async function upgradeStatus(headers: Record<string, string>): Promise<Response> {
	return fetch(`http://${baseUrl}/api/v1/ws`, { headers: { Origin: ORIGIN, ...headers } });
}

function uniqueName(label: string): string {
	return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

async function localUserWithCookie(label: string) {
	const user = await createUser({
		username: uniqueName(label),
		password: "a-very-long-password-123",
		role: "user",
	});
	const { token } = await issueSession({ userId: user.id });
	return { user, cookie: { Cookie: `${SESSION_COOKIE_NAME}=${token}` } };
}

/** The close frame the socket received, or a sentinel if it stayed open — keeps a missing close an assertion failure, not a timeout. */
async function waitClosed(socket: TestSocket): Promise<{ code: number; reason: string }> {
	return Promise.race([
		socket.closed,
		Bun.sleep(750).then(() => ({ code: -1, reason: "still open" })),
	]);
}

async function isStillOpen(socket: TestSocket): Promise<boolean> {
	const before = socket.messages.length;
	broadcast("session_updated", { probe: crypto.randomUUID() });
	await Bun.sleep(50);
	return socket.messages.length > before;
}

describe("a socket records who opened it", () => {
	test("closeSocketsForUser closes the cookie user's socket and leaves everyone else's open", async () => {
		const a = await localUserWithCookie("ws-a");
		const b = await localUserWithCookie("ws-b");
		const socketA = await connect(a.cookie);
		const socketB = await connect(b.cookie);

		closeSocketsForUser(a.user.id);

		const closedA = await waitClosed(socketA);
		expect(closedA.code).toBe(4001);
		expect(closedA.reason).toBe("account_disabled");
		expect(await isStillOpen(socketB)).toBe(true);
		expect(await isStillOpen(socketA)).toBe(false);
	});

	test("a socket opened with a user-owned key carries that user's id", async () => {
		const owner = await createUser({
			username: uniqueName("ws-key-owner"),
			password: "a-very-long-password-123",
			role: "user",
		});
		const { key } = await createApiKey(uniqueName("ws-owned-key"), ["manage"], owner.id);
		const socket = await connect({ Authorization: `Bearer ${key}` });

		closeSocketsForUser(owner.id);

		expect((await waitClosed(socket)).code).toBe(4001);
	});

	test("a service key's socket has no user id: closing any user's sockets never closes it", async () => {
		const someone = await localUserWithCookie("ws-someone");
		const { key } = await createApiKey(uniqueName("ws-service-key"), ["manage"]);
		const serviceSocket = await connect({ Authorization: `Bearer ${key}` });

		closeSocketsForUser(someone.user.id);

		expect(await isStillOpen(serviceSocket)).toBe(true);
	});

	test("a session update from the bus reaches a socket opened with an identity", async () => {
		const a = await localUserWithCookie("ws-bus");
		const socket = await connect(a.cookie);
		const bus = new EventEmitter();
		initWsBroadcaster(bus as unknown as Parameters<typeof initWsBroadcaster>[0]);

		bus.emit("session_updated", { id: "s1", sessionId: "s1" });
		await Bun.sleep(50);

		expect(socket.messages.some((m) => m.type === "session_updated")).toBe(true);
	});
});

describe("the upgrade refuses a user who may not hold a socket", () => {
	test("a disabled user's cookie is refused", async () => {
		const a = await localUserWithCookie("ws-disabled");
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, a.user.id));

		const res = await upgradeStatus(a.cookie);

		expect(res.status).toBe(401);
	});

	test("a user flagged must-change-password is refused with password_change_required", async () => {
		const a = await localUserWithCookie("ws-flagged");
		await getDb().update(users).set({ mustChangePassword: true }).where(eq(users.id, a.user.id));

		const res = await upgradeStatus(a.cookie);

		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toBe("password_change_required");
	});

	test("a key owned by a flagged user is refused", async () => {
		const owner = await createUser({
			username: uniqueName("ws-flagged-owner"),
			password: "a-very-long-password-123",
			role: "user",
		});
		const { key } = await createApiKey(uniqueName("ws-flagged-key"), ["manage"], owner.id);
		await getDb().update(users).set({ mustChangePassword: true }).where(eq(users.id, owner.id));

		const res = await upgradeStatus({ Authorization: `Bearer ${key}` });

		expect(res.status).toBe(403);
	});

	test("a key owned by a disabled user is refused", async () => {
		const owner = await createUser({
			username: uniqueName("ws-disabled-owner"),
			password: "a-very-long-password-123",
			role: "user",
		});
		const { key } = await createApiKey(uniqueName("ws-disabled-key"), ["manage"], owner.id);
		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, owner.id));

		const res = await upgradeStatus({ Authorization: `Bearer ${key}` });

		expect(res.status).toBe(401);
	});
});

describe("the heartbeat re-check closes sockets without any local call", () => {
	test("a user disabled directly in the database loses their socket on the next sweep; others keep theirs", async () => {
		const a = await localUserWithCookie("hb-a");
		const b = await localUserWithCookie("hb-b");
		const socketA = await connect(a.cookie);
		const socketB = await connect(b.cookie);

		await getDb()
			.update(users)
			.set({ disabledAt: new Date().toISOString() })
			.where(eq(users.id, a.user.id));
		await heartbeatTick();

		const closedA = await waitClosed(socketA);
		expect(closedA.code).toBe(4001);
		expect(closedA.reason).toBe("account_disabled");
		expect(await isStillOpen(socketB)).toBe(true);
	});

	test("a user flagged must-change-password loses their socket on the next sweep", async () => {
		const a = await localUserWithCookie("hb-flag");
		const socketA = await connect(a.cookie);

		await getDb().update(users).set({ mustChangePassword: true }).where(eq(users.id, a.user.id));
		await heartbeatTick();

		expect((await waitClosed(socketA)).reason).toBe("password_change_required");
	});

	test("a key socket closes when its key goes inactive, and not before", async () => {
		const { key, id } = await createApiKey(uniqueName("hb-service-key"), ["manage"]);
		const socket = await connect({ Authorization: `Bearer ${key}` });

		await heartbeatTick();
		expect(await isStillOpen(socket)).toBe(true);

		await getDb().update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, id));
		await heartbeatTick();

		const closed = await waitClosed(socket);
		expect(closed.code).toBe(4001);
		expect(closed.reason).toBe("api_key_revoked");
	});

	test("a database error during a sweep neither rejects nor closes anyone; the failure is logged", async () => {
		const a = await localUserWithCookie("hb-error");
		const socketA = await connect(a.cookie);
		const logged: string[] = [];
		const errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
		const selectSpy = spyOn(getDb(), "select").mockImplementation(() => {
			throw new Error("simulated database blip");
		});
		try {
			await expect(heartbeatTick()).resolves.toBeUndefined();
		} finally {
			selectSpy.mockRestore();
			errorSpy.mockRestore();
		}

		expect(logged.some((line) => line.includes("ws_heartbeat_failed"))).toBe(true);
		expect(await isStillOpen(socketA)).toBe(true);
		expect(getConnectionCount()).toBeGreaterThan(0);
	});
});
