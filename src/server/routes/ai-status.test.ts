/**
 * PUT /ai/status: strict booleans, unknown keys refused, the Origin check, the
 * human-only un-pausing, the audit line, and the fail-closed flag reads.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../services/ai/__test_db.js";
import { resetIdentityState } from "../test-utils/identity-reset.js";
import {
	bearerHeaders,
	cookieHeadersFor,
	jsonRequest,
	seedKey,
	seedLocalUser,
	setStoredMode,
} from "../test-utils/team-fixtures.js";
import {
	captureAuditLines,
	clearSetting,
	enableAiRuntime,
	setSetting,
} from "../test-utils/watcher-fixtures.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { config } = await import("../config.js");
const { app } = await import("../app.js");
const { settings } = await import("../db/schema/index.js");
const feature = await import("../services/ai/feature.js");

const originalDisableAuth = config.disableAuth;

beforeAll(() => initializeDatabase());

async function reset() {
	(config as Record<string, unknown>).disableAuth = originalDisableAuth;
	await resetIdentityState();
	for (const key of [
		feature.AI_CLASSIFIER_ENABLED_KEY,
		feature.AI_KILL_SWITCH_KEY,
		feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY,
		feature.AI_WATCHER_DEFAULTS_KEY,
	]) {
		await clearSetting(key);
	}
}
beforeEach(reset);
afterEach(reset);

const URL_STATUS = "/api/v1/ai/status";

async function callers() {
	const admin = await seedLocalUser("st-admin", "admin");
	const member = await seedLocalUser("st-member", "user");
	const adminKey = await seedKey("st-admin-key", ["manage"], admin.id);
	return {
		adminCookie: await cookieHeadersFor(admin.id),
		memberCookie: await cookieHeadersFor(member.id),
		adminKey: bearerHeaders(adminKey.key),
	};
}

async function put(body: unknown, headers: Headers) {
	return app.request(URL_STATUS, jsonRequest("PUT", body, headers));
}

describe("GET /ai/status", () => {
	test("returns the watcher defaults and the pause flag, with their shipped values", async () => {
		const c = await callers();
		const res = await app.request(URL_STATUS, { headers: c.adminCookie });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.watcherDefaults).toEqual({ notify: true, continue: false });
		expect(body.watcherAutoSendPaused).toBe(true);
	});
});

describe("authorization", () => {
	test("team mode: a member's PUT of the watcher defaults is 403 and an admin's is 200", async () => {
		await setStoredMode("team");
		const c = await callers();
		const member = await put(
			{ watcherDefaults: { notify: false, continue: true } },
			c.memberCookie,
		);
		expect(member.status).toBe(403);
		const admin = await put({ watcherDefaults: { notify: false, continue: true } }, c.adminCookie);
		expect(admin.status).toBe(200);
		expect(((await admin.json()) as { watcherDefaults: unknown }).watcherDefaults).toEqual({
			notify: false,
			continue: true,
		});
	});

	test("un-pausing automatic sending needs a person: an admin API key gets human_required, the admin's cookie session succeeds", async () => {
		const c = await callers();
		const byKey = await put({ watcherAutoSendPaused: false }, c.adminKey);
		expect(byKey.status).toBe(403);
		expect(((await byKey.json()) as { error: string }).error).toBe("human_required");
		expect(await feature.isWatcherAutoSendPaused()).toBe(true);

		const byCookie = await put({ watcherAutoSendPaused: false }, c.adminCookie);
		expect(byCookie.status).toBe(200);
		expect(await feature.isWatcherAutoSendPaused()).toBe(false);
	});

	test("pausing is open to any caller the route admits", async () => {
		const c = await callers();
		await put({ watcherAutoSendPaused: false }, c.adminCookie);
		const res = await put({ watcherAutoSendPaused: true }, c.adminKey);
		expect(res.status).toBe(200);
		expect(await feature.isWatcherAutoSendPaused()).toBe(true);
	});

	test("clearing the kill switch needs a person; setting it does not", async () => {
		const c = await callers();
		expect((await put({ killSwitch: true }, c.adminKey)).status).toBe(200);
		expect(await feature.isKillSwitchActive()).toBe(true);
		const refused = await put({ killSwitch: false }, c.adminKey);
		expect(refused.status).toBe(403);
		expect(await feature.isKillSwitchActive()).toBe(true);
		expect((await put({ killSwitch: false }, c.adminCookie)).status).toBe(200);
		expect(await feature.isKillSwitchActive()).toBe(false);
	});

	test("a request with a hostile Origin is 403 bad_origin; with no Origin it passes", async () => {
		const c = await callers();
		const evil = new Headers(c.adminCookie);
		evil.set("Origin", "https://evil.example");
		const refused = await put({ classifierEnabled: false }, evil);
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { error: string }).error).toBe("bad_origin");
		const ok = await put({ classifierEnabled: false }, c.adminCookie);
		expect(ok.status).toBe(200);
	});
});

describe("validation", () => {
	test("a non-boolean killSwitch is 400 and nothing is written", async () => {
		const c = await callers();
		const res = await put({ killSwitch: "false" }, c.adminCookie);
		expect(res.status).toBe(400);
		const rows = await getDb()
			.select()
			.from(settings)
			.where(eq(settings.key, feature.AI_KILL_SWITCH_KEY));
		expect(rows).toEqual([]);
	});

	test("one bad field in a request writes none of the others", async () => {
		const c = await callers();
		const res = await put({ classifierEnabled: false, killSwitch: "yes" }, c.adminCookie);
		expect(res.status).toBe(400);
		expect(await feature.isClassifierEnabled()).toBe(true);
	});

	test("unknown keys are 400 unknown_field", async () => {
		const c = await callers();
		const res = await put({ nope: true }, c.adminCookie);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "unknown_field", field: "nope" });
	});

	test("watcherDefaults must be exactly two booleans", async () => {
		const c = await callers();
		for (const bad of [
			{ notify: true },
			{ notify: true, continue: "no" },
			{ notify: true, continue: false, extra: 1 },
			[true, false],
			"x",
		]) {
			const res = await put({ watcherDefaults: bad }, c.adminCookie);
			expect(res.status, JSON.stringify(bad)).toBe(400);
		}
	});
});

describe("audit", () => {
	test("each accepted change logs one ai_config_changed line with before and after", async () => {
		const c = await callers();
		const capture = captureAuditLines();
		try {
			await put(
				{ classifierEnabled: false, watcherDefaults: { notify: false, continue: true } },
				c.adminCookie,
			);
			await put({ classifierEnabled: false }, c.adminCookie); // no change: no line
		} finally {
			capture.restore();
		}
		const lines = capture.lines("ai_config_changed");
		expect(lines.map((l) => l.key).sort()).toEqual([
			feature.AI_CLASSIFIER_ENABLED_KEY,
			feature.AI_WATCHER_DEFAULTS_KEY,
		]);
		const classifier = lines.find((l) => l.key === feature.AI_CLASSIFIER_ENABLED_KEY);
		expect([classifier?.before, classifier?.after]).toEqual([true, false]);
		const defaults = lines.find((l) => l.key === feature.AI_WATCHER_DEFAULTS_KEY);
		expect(defaults?.before).toEqual({ notify: true, continue: false });
		expect(defaults?.after).toEqual({ notify: false, continue: true });
	});
});

describe("fail-closed flags", () => {
	test("auto-send reads paused when the setting is unset", async () => {
		expect(await feature.isWatcherAutoSendPaused()).toBe(true);
		await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, false);
		expect(await feature.isWatcherAutoSendPaused()).toBe(false);
	});

	test("a non-boolean kill switch or pause value reads as killed and paused", async () => {
		await setSetting(feature.AI_KILL_SWITCH_KEY, "yes");
		expect(await feature.isKillSwitchActive()).toBe(true);
		await setSetting(feature.AI_WATCHER_AUTO_SEND_PAUSED_KEY, "no");
		expect(await feature.isWatcherAutoSendPaused()).toBe(true);
	});

	test("an absent kill switch row is not killed (today's default)", async () => {
		expect(await feature.isKillSwitchActive()).toBe(false);
	});

	test("with the settings read throwing, both read closed", async () => {
		feature.invalidateAiFlagsCache();
		const db = getDb();
		const failing = spyOn(db, "select").mockImplementation((() => {
			throw new Error("settings unreadable");
		}) as unknown as typeof db.select);
		try {
			expect(await feature.isKillSwitchActive()).toBe(true);
			expect(await feature.isWatcherAutoSendPaused()).toBe(true);
		} finally {
			failing.mockRestore();
		}
		feature.invalidateAiFlagsCache();
	});

	test("readAiFlagUncached bypasses the cache and reports an unreadable value", async () => {
		await enableAiRuntime();
		await feature.isKillSwitchActive(); // warm the cache with "not killed"
		const now = new Date().toISOString();
		await getDb()
			.insert(settings)
			.values({ key: feature.AI_KILL_SWITCH_KEY, value: true, updatedAt: now })
			.onConflictDoUpdate({ target: settings.key, set: { value: true, updatedAt: now } });
		// The cache still says "not killed"; the direct read sees the write.
		expect(await feature.isKillSwitchActive()).toBe(false);
		const direct = await feature.readAiFlagUncached(getDb(), feature.AI_KILL_SWITCH_KEY);
		expect(direct).toEqual({ ok: true, value: true });
		expect(feature.interpretKillSwitch(direct.ok ? direct.value : undefined)).toBe(true);

		const broken = await feature.readAiFlagUncached(
			{
				select: () => {
					throw new Error("down");
				},
			},
			feature.AI_KILL_SWITCH_KEY,
		);
		expect(broken).toEqual({ ok: false });
	});
});
