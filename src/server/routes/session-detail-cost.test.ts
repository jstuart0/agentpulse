/**
 * What the session detail costs the database. The page is opened on every
 * click into a session, so its statement count is pinned per caller. The
 * reporting key's name and owner and the instance mode ride on the session
 * read; the two service-key lists are read together, in one statement, and
 * only for a key that has no owner (the one case that needs them). An
 * observe-scoped key never sees the field and costs nothing for it.
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
	setServiceKeyList,
	setStoredMode,
} from "../test-utils/team-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { config } = await import("../config.js");
const { app } = await import("../app.js");
const { countDbCalls } = await import("../test-utils/db-call-counter.js");

beforeAll(async () => {
	await initializeDatabase();
});

async function reset() {
	await resetIdentityState();
	await clearInstanceSettings();
	await getDb().delete(sessions);
}
beforeEach(reset);
afterEach(reset);

type Mode = "solo" | "team";
type Caller = "cookie member" | "cookie admin" | "manage key" | "observe key";
type KeyState = "no key" | "owned key" | "service key";

async function seedSession(sessionId: string, ingestKeyId: string | null) {
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			metadata: {},
			ingestKeyId,
		} as never);
}

async function headersFor(caller: Caller): Promise<Headers> {
	const stranger = await seedLocalUser("cost-stranger");
	if (caller === "cookie member") return cookieHeadersFor(stranger.id);
	if (caller === "cookie admin") {
		return cookieHeadersFor((await seedLocalUser("cost-admin", "admin")).id);
	}
	const scope = caller === "manage key" ? "manage" : "observe";
	return bearerHeaders((await seedKey("cost-caller", [scope], stranger.id)).key);
}

async function reportingKeyFor(state: KeyState): Promise<string | null> {
	if (state === "no key") return null;
	if (state === "owned key") {
		return (await seedKey("cost-reporter", ["ingest"], (await seedLocalUser("cost-keyowner")).id))
			.id;
	}
	const service = await seedKey("cost-service", ["ingest"], null);
	await setServiceKeyList([service.id]);
	return service.id;
}

/** Statements one GET /sessions/:id issues for this caller, mode and recorded key. */
async function statementsFor(mode: Mode, caller: Caller, state: KeyState): Promise<number> {
	await setStoredMode(mode);
	const headers = await headersFor(caller);
	await seedSession("cost-session", await reportingKeyFor(state));
	let status = 0;
	const statements = await countDbCalls(async () => {
		const res = await app.request("/api/v1/sessions/cost-session", { headers });
		status = res.status;
		await res.json();
	});
	expect(status).toBe(200);
	return statements;
}

const MODES: Mode[] = ["solo", "team"];
const CALLERS: Caller[] = ["cookie member", "cookie admin", "manage key", "observe key"];
const STATES: KeyState[] = ["no key", "owned key", "service key"];

async function table(): Promise<Record<string, number>> {
	const cells: Record<string, number> = {};
	for (const mode of MODES) {
		for (const caller of CALLERS) {
			for (const state of STATES) {
				await reset();
				cells[`${mode} / ${caller} / ${state}`] = await statementsFor(mode, caller, state);
			}
		}
	}
	return cells;
}

describe("statements per GET /sessions/:id", () => {
	test("the count per caller, mode and recorded key", async () => {
		expect(await table()).toEqual(EXPECTED);
	});

	test("auth disabled on a solo instance: a key-less session and an owned-key one cost the same", async () => {
		const original = config.disableAuth;
		(config as Record<string, unknown>).disableAuth = true;
		try {
			await seedSession("cost-off-base", null);
			await seedSession("cost-off-owned", await reportingKeyFor("owned key"));
			const base = await getCounted("cost-off-base");
			const owned = await getCounted("cost-off-owned");
			expect({ base, owned }).toEqual({ base: DISABLED_AUTH_COST, owned: DISABLED_AUTH_COST });
		} finally {
			(config as Record<string, unknown>).disableAuth = original;
		}
	});
});

async function getCounted(sessionId: string): Promise<number> {
	return countDbCalls(async () => {
		const res = await app.request(`/api/v1/sessions/${sessionId}`);
		expect(res.status).toBe(200);
		await res.json();
	});
}

const DISABLED_AUTH_COST = 4;
/** Origin of each number: cookie 7, manage key 6, observe key 5 before the reporting key existed; a service key adds the one list read. */
const EXPECTED: Record<string, number> = {
	"solo / cookie member / no key": 7,
	"solo / cookie member / owned key": 7,
	"solo / cookie member / service key": 8,
	"solo / cookie admin / no key": 7,
	"solo / cookie admin / owned key": 7,
	"solo / cookie admin / service key": 8,
	"solo / manage key / no key": 6,
	"solo / manage key / owned key": 6,
	"solo / manage key / service key": 7,
	"solo / observe key / no key": 5,
	"solo / observe key / owned key": 5,
	"solo / observe key / service key": 5,
	"team / cookie member / no key": 7,
	"team / cookie member / owned key": 7,
	"team / cookie member / service key": 8,
	"team / cookie admin / no key": 7,
	"team / cookie admin / owned key": 7,
	"team / cookie admin / service key": 8,
	"team / manage key / no key": 6,
	"team / manage key / owned key": 6,
	"team / manage key / service key": 7,
	"team / observe key / no key": 5,
	"team / observe key / owned key": 5,
	"team / observe key / service key": 5,
};
