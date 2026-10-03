/**
 * A machine name the dashboard lists can always be selected, and selecting it
 * returns exactly the sessions the listing counted. A supervisor's host name is
 * written by the supervisor itself (any non-empty text), so the grammar the
 * filter speaks, the SQL that groups by it and the client's trim could each
 * disagree with a stored name: listed but unselectable, selectable but empty.
 * Names are cleaned the way a reported name is when a supervisor registers and
 * when a managed session copies its host, and rows stored before that are
 * cleaned once at boot.
 *
 * Also pins what the observe scope can already read of a supervisor's host.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../db/__test_db.js";
import { UNKNOWN_HOST_PARAM, parseHostParam } from "../../shared/machine-scope.js";
import { containsUnsafeHostCharacters } from "../../shared/reported-host.js";
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
const { sessions, managedSessions, supervisors } = await import("../db/schema/index.js");
const { app } = await import("../app.js");
const { normalizeStoredMachineNames } = await import("../services/effective-machine.js");
const { enrollSupervisor } = await import("../services/supervisor-registry.js");
const { eq } = await import("drizzle-orm");

beforeAll(async () => {
	await initializeDatabase();
});
async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(managedSessions);
	await getDb().delete(sessions);
	await getDb().delete(supervisors);
}
beforeEach(reset);
afterEach(reset);

const AWKWARD: Array<[string, string]> = [
	["a leading tab", "\tweird"],
	["a control character", "ctrl\u0001char"],
	["a 300-character name", "x".repeat(300)],
	["non-breaking spaces at the ends", "nb\u00a0sp\u00a0"],
	["the reserved unknown token", UNKNOWN_HOST_PARAM],
	["padding and doubled spaces", "  two  words  "],
	["a zero-width character", "zero\u200bwidth"],
	["a bidi override", "bidi\u202ename"],
	["a line separator", "line\u2028sep"],
];

let counter = 0;
async function seedManaged(
	sessionId: string,
	hostName: string | null,
	reported: string | null = null,
) {
	counter += 1;
	await getDb()
		.insert(sessions)
		.values({ sessionId, agentType: "claude_code", status: "active", reportedHost: reported });
	await getDb()
		.insert(managedSessions)
		.values({ sessionId, launchRequestId: `l-${counter}`, supervisorId: "sup-1", hostName });
}

async function viewer() {
	await setStoredMode("team");
	const user = await seedLocalUser("mn-viewer");
	return cookieHeadersFor(user.id);
}
async function get<T>(path: string, headers: Headers): Promise<{ status: number; body: T }> {
	const res = await app.request(`/api/v1${path}`, { headers });
	return { status: res.status, body: (await res.json()) as T };
}
type Groups = { groups: Array<{ host: string | null; total: number }> };
type List = { total: number; sessions: Array<{ sessionId: string; machine?: string | null }> };

describe("every machine the grouping lists can be selected, and returns its own total", () => {
	test("for names a supervisor may have stored raw, once the stored rows are cleaned", async () => {
		const headers = await viewer();
		for (const [i, [, name]] of AWKWARD.entries()) await seedManaged(`m-${i}`, name);
		await seedManaged("m-blank-only", "\u0001\u200b");
		await seedManaged("m-plain", "plain-box");
		await seedManaged("m-reported", "  ", "reported-box");
		await normalizeStoredMachineNames();

		const { body } = await get<Groups>("/sessions/stats?group_by=host", headers);
		expect(body.groups.length).toBeGreaterThan(5);
		for (const group of body.groups) {
			if (group.host === null) continue;
			const parsed = parseHostParam(group.host);
			expect({ host: group.host, expressible: parsed !== null }).toEqual({
				host: group.host,
				expressible: true,
			});
			const param = encodeURIComponent(group.host);
			const listed = await get<List>(`/sessions?host=${param}&limit=100`, headers);
			expect({ host: group.host, status: listed.status, total: listed.body.total }).toEqual({
				host: group.host,
				status: 200,
				total: group.total,
			});
			for (const row of listed.body.sessions) expect(row.machine).toBe(group.host);
		}
	});

	test("the unknown token is not a machine: a name equal to it is cleaned to something selectable, never the unknown bucket's twin", async () => {
		const headers = await viewer();
		await seedManaged("tok", UNKNOWN_HOST_PARAM);
		await normalizeStoredMachineNames();
		const { body } = await get<Groups>("/sessions/stats?group_by=host", headers);
		expect(body.groups.map((g) => g.host)).toEqual(["unknown"]);
	});

	test("cleaning is idempotent and leaves clean names and reported names alone", async () => {
		await seedManaged("clean", "build-01", "rep-box");
		await normalizeStoredMachineNames();
		await normalizeStoredMachineNames();
		const [row] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, "clean"));
		expect(row.hostName).toBe("build-01");
	});

	test("a name with nothing left after cleaning counts as none, so the reported name stands", async () => {
		await seedManaged("only-junk", "\u0001\u200b", "reported-box");
		await normalizeStoredMachineNames();
		const [row] = await getDb()
			.select()
			.from(managedSessions)
			.where(eq(managedSessions.sessionId, "only-junk"));
		expect(row.hostName).toBeNull();
	});
});

describe("registration cleans the supervisor's host name", () => {
	const input = (hostName: string) =>
		({
			hostName,
			platform: "darwin",
			arch: "arm64",
			version: "1.0.0",
			capabilities: {},
			trustedRoots: [],
		}) as never;

	test("what is stored is the cleaned name", async () => {
		for (const [, name] of AWKWARD) {
			const { supervisor } = await enrollSupervisor(input(name), null);
			const [row] = await getDb()
				.select()
				.from(supervisors)
				.where(eq(supervisors.id, supervisor.id));
			const clean =
				parseHostParam(row.hostName) !== null &&
				!containsUnsafeHostCharacters(row.hostName) &&
				row.hostName.length <= 128 &&
				row.hostName === row.hostName.trim();
			expect({ name, clean }).toEqual({ name, clean: true });
		}
	});

	test("a name that is nothing but unprintable characters is refused", async () => {
		const operator = await seedLocalUser("mn-admin");
		void operator;
		const res = await app.request("/api/v1/supervisors/register", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				hostName: "\u0001\u200b",
				platform: "darwin",
				arch: "arm64",
				version: "1",
			}),
		});
		expect(res.status).toBe(400);
	});
});

describe("what the observe scope can already read of a supervisor's host", () => {
	test("GET /sessions/:id gives an observe-scoped key managedSession.hostName today, so a machine on a row discloses nothing new", async () => {
		await setStoredMode("team");
		const key = await seedKey("mn-observe", ["observe"], null);
		await seedManaged("obs-1", "edge-02", "somewhere-else");
		const detail = await get<{
			session: { managedSession?: { hostName?: string } | null; machine?: string | null };
		}>("/sessions/obs-1", bearerHeaders(key.key));
		expect(detail.status).toBe(200);
		expect(detail.body.session.managedSession?.hostName).toBe("edge-02");
		const list = await get<List>("/sessions?limit=10", bearerHeaders(key.key));
		expect(list.body.sessions[0]?.machine).toBe("edge-02");
	});
});
