/**
 * The name-only read of a session: `GET /sessions/:id?fields=displayName`.
 * The status line asks for it on every render, so it has to be small and fast
 * however long the session is. It touches the sessions row and nothing else (no
 * events, no timeline, no managed-session or key lookups), answers "found" and
 * "unknown" exactly as the full detail does, and reads nothing an observe-scoped
 * key can't already read from the detail. The shape is a strict subset of the
 * detail's, so a client that asks this of a server that predates it (which
 * ignores the parameter and answers with the whole detail) still reads the name.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	clearInstanceSettings,
	cookieHeadersFor,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions, events } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

beforeAll(async () => {
	await initializeDatabase();
});
async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(events);
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

const LIGHT = "?fields=displayName";

async function seedSession(sessionId: string, displayName: string | null, eventCount = 0) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName,
			agentType: "claude_code",
			status: "active",
			metadata: {},
		} as never);
	const rows = Array.from({ length: eventCount }, (_, i) => ({
		sessionId,
		eventType: "PostToolUse",
		toolName: "Bash",
		toolInput: JSON.stringify({ command: `echo ${i} ${"x".repeat(400)}` }),
		toolResponse: JSON.stringify({ stdout: "y".repeat(400) }),
		rawPayload: JSON.stringify({ i, blob: "z".repeat(400) }),
	}));
	for (let i = 0; i < rows.length; i += 100) {
		await getDb()
			.insert(events)
			.values(rows.slice(i, i + 100) as never);
	}
}
/** A signed-in member of a team instance: the default caller, unless a test names one (an empty Headers is "no credential"). */
let member: Headers;
beforeEach(async () => {
	await setStoredMode("team");
	member = await cookieHeadersFor((await seedLocalUser("nl-default")).id);
});
const get = (path: string, headers?: Headers) =>
	app.request(`/api/v1${path}`, { headers: headers ?? member });

describe("the name-only read", () => {
	test("answers { session: { sessionId, displayName } } and nothing else", async () => {
		await seedSession("n-1", "brave-falcon", 5);
		const res = await get(`/sessions/n-1${LIGHT}`);
		expect(res.status).toBe(200);
		// If the route returned the whole detail this would also carry events, controlActions and the rest.
		expect(await res.json()).toEqual({
			session: { sessionId: "n-1", displayName: "brave-falcon" },
		});
	});

	test("the name is the one the full detail reports (it can't show a different name than the dashboard)", async () => {
		await seedSession("n-2", "calm-otter", 2);
		const light = (await (await get(`/sessions/n-2${LIGHT}`)).json()) as {
			session: { displayName: string };
		};
		const full = (await (await get("/sessions/n-2")).json()) as {
			session: { displayName: string };
		};
		expect(light.session.displayName).toBe(full.session.displayName);
	});

	test("a session with no name yet reads as null, not as an error", async () => {
		await seedSession("n-3", null);
		const res = await get(`/sessions/n-3${LIGHT}`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ session: { sessionId: "n-3", displayName: null } });
	});

	test("its size doesn't depend on how many events the session has (the full detail's does)", async () => {
		await seedSession("short", "same-name", 3);
		await seedSession("long-", "same-name", 700);
		const size = async (path: string) => (await (await get(path)).text()).length;
		const lightShort = await size(`/sessions/short${LIGHT}`);
		const lightLong = await size(`/sessions/long-${LIGHT}`);
		// the ids differ by one character of equal length; the body is otherwise the same
		expect(lightLong).toBe(lightShort);
		expect(lightLong).toBeLessThan(200);
		// the control: the full detail grows with the events and is far bigger
		const fullShort = await size("/sessions/short");
		const fullLong = await size("/sessions/long-");
		expect(fullLong).toBeGreaterThan(fullShort * 10);
		expect(fullLong).toBeGreaterThan(lightLong * 1000);
	});

	test("exactly one statement of its own, whatever the session holds: the auth lookups plus the one select, with no events, managed-session, key or control-action read", async () => {
		await seedSession("c-short", "a", 1);
		await seedSession("c-long", "b", 600);
		const statements = (path: string) => countDbCalls(async () => void (await get(path)));
		// a request refused before any read costs only the caller's own auth lookups
		const auth = await statements("/sessions/c-short?fields=events");
		const short = await statements(`/sessions/c-short${LIGHT}`);
		const long = await statements(`/sessions/c-long${LIGHT}`);
		const unknown = await statements(`/sessions/c-nope${LIGHT}`);
		// If a second statement (an events read, say) crept in, these would be auth + 2.
		expect({ short, long, unknown }).toEqual({
			short: auth + 1,
			long: auth + 1,
			unknown: auth + 1,
		});
		// the control: the full detail costs more statements than the small read
		expect(await statements("/sessions/c-long")).toBeGreaterThan(auth + 2);
	});

	test("an unknown session is the same 404 the detail gives, so a client tells found from unknown as before", async () => {
		const light = await get(`/sessions/nope${LIGHT}`);
		const full = await get("/sessions/nope");
		expect(light.status).toBe(404);
		expect(await light.json()).toEqual(await full.json());
	});

	test("a field it doesn't serve, an empty list, or a mix is a 400 naming the value, never a silent full detail", async () => {
		await seedSession("f-1", "x", 1);
		for (const q of [
			"?fields=events",
			"?fields=",
			"?fields=displayName,events",
			"?fields=%20",
			"?fields=displayname",
		]) {
			const res = await get(`/sessions/f-1${q}`);
			expect({ q, status: res.status }).toEqual({ q, status: 400 });
			expect(((await res.json()) as { error: string }).error).toBe("invalid_field");
		}
		// a repeated, padded name is still the one field
		expect((await get("/sessions/f-1?fields=%20displayName%20,displayName")).status).toBe(200);
	});

	test("every value of fields counts: a repeated parameter can't smuggle a second field past the check", async () => {
		await seedSession("rep-1", "x", 2);
		for (const q of [
			"?fields=displayName&fields=events",
			"?fields=events&fields=displayName",
			"?fields=displayName&fields=",
		]) {
			const res = await get(`/sessions/rep-1${q}`);
			expect({ q, status: res.status }).toEqual({ q, status: 400 });
			expect(((await res.json()) as { error: string }).error).toBe("invalid_field");
		}
		// the same supported field twice is still the one projection
		expect((await get("/sessions/rep-1?fields=displayName&fields=displayName")).status).toBe(200);
	});

	test("without fields the detail is exactly what it was (events included)", async () => {
		await seedSession("d-1", "x", 4);
		const body = (await (await get("/sessions/d-1")).json()) as {
			events: unknown[];
			session: { sessionId: string };
		};
		expect(body.events).toHaveLength(4);
	});
});

describe("who may ask: the same scopes as the session detail", () => {
	test("an observe-scoped key and a manage key read it; an ingest-only key and no credential don't", async () => {
		await setStoredMode("team");
		await seedSession("auth-1", "scoped-name", 2);
		const observe = await seedKey("nl-observe", ["observe"], null);
		const manage = await seedKey("nl-manage", ["manage"], null);
		const ingest = await seedKey("nl-ingest", ["ingest"], null);
		const [o, m, i, none] = await Promise.all([
			get(`/sessions/auth-1${LIGHT}`, bearerHeaders(observe.key)),
			get(`/sessions/auth-1${LIGHT}`, bearerHeaders(manage.key)),
			get(`/sessions/auth-1${LIGHT}`, bearerHeaders(ingest.key)),
			get(`/sessions/auth-1${LIGHT}`, new Headers()),
		]);
		expect({ observe: o.status, manage: m.status, none: none.status }).toEqual({
			observe: 200,
			manage: 200,
			none: 401,
		});
		// an ingest-only key can't read the detail either, so the light read must not be a way around that
		const ingestDetail = await get("/sessions/auth-1", bearerHeaders(ingest.key));
		expect(i.status).toBe(ingestDetail.status);
		expect(i.status).toBe(403);
	});

	test("an observe key gets nothing from it that the detail doesn't hand the same key", async () => {
		await setStoredMode("team");
		await seedSession("sub-1", "subset-name", 3);
		const observe = await seedKey("nl-observe2", ["observe"], null);
		const light = (await (
			await get(`/sessions/sub-1${LIGHT}`, bearerHeaders(observe.key))
		).json()) as { session: Record<string, unknown> };
		const full = (await (await get("/sessions/sub-1", bearerHeaders(observe.key))).json()) as {
			session: Record<string, unknown>;
		};
		for (const [key, value] of Object.entries(light.session))
			expect(full.session[key]).toEqual(value);
	});

	test("a signed-in member reads it in team mode, as they read the detail", async () => {
		await setStoredMode("team");
		await seedSession("m-1", "member-name");
		const res = await get(
			`/sessions/m-1${LIGHT}`,
			await cookieHeadersFor((await seedLocalUser("nl-member")).id),
		);
		expect(res.status).toBe(200);
	});
});
