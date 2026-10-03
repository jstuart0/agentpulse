/**
 * "Today" in the stats is the server's local calendar day. Sessions that start
 * a millisecond before local midnight belong to yesterday, at midnight and a
 * millisecond after to today. The boundary check runs under whatever time zone
 * the process has, and again in child processes under zones far from UTC (where
 * local midnight is not a UTC date boundary): a zone can't be switched inside a
 * running process, so the child is started with TZ set and proves it took.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./ai/__test_db.js";

const { getDb, initializeDatabase } = await import("../db/client.js");
const { sessions } = await import("../db/schema/index.js");
const { getStats } = await import("./session-tracker.js");

const CHILD_FLAG = "AGENTPULSE_DAY_BOUNDARY_CHILD";
const inChild = process.env[CHILD_FLAG] === "1";
const FAR_ZONES = ["Pacific/Kiritimati", "Pacific/Pago_Pago", "America/Los_Angeles"];

beforeAll(() => initializeDatabase());
beforeEach(async () => {
	await getDb().delete(sessions).execute();
});

function localMidnightMs(): number {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

describe("the day boundary in this process's time zone", () => {
	test("-1 ms is yesterday, 0 and +1 ms are today", async () => {
		if (inChild) {
			// The child exists to run under a specific zone; prove the zone applied.
			expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(process.env.TZ as string);
		}
		const midnight = localMidnightMs();
		const rows = [
			{ id: "before", offset: -1, tools: 100 },
			{ id: "at", offset: 0, tools: 10 },
			{ id: "after", offset: 1, tools: 1 },
		].map(({ id, offset, tools }) => ({
			sessionId: `day-${id}`,
			displayName: id,
			agentType: "claude_code",
			status: "active",
			metadata: {},
			totalToolUses: tools,
			startedAt: new Date(midnight + offset).toISOString(),
			lastActivityAt: new Date(midnight + offset).toISOString(),
		}));
		await getDb()
			.insert(sessions)
			.values(rows as never)
			.execute();
		const stats = await getStats();
		expect({ today: stats.totalSessionsToday, tools: stats.totalToolUsesToday }).toEqual({
			today: 2,
			tools: 11,
		});
		expect(stats.activeSessions).toBe(3);
	});
});

describe.skipIf(inChild)("the same boundary under zones far from UTC", () => {
	for (const zone of FAR_ZONES) {
		test(zone, async () => {
			const child = Bun.spawn([process.execPath, "test", import.meta.path], {
				cwd: process.cwd(),
				env: { ...process.env, TZ: zone, [CHILD_FLAG]: "1" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ zone, code, output: code === 0 ? "" : `${out}\n${err}` }).toEqual({
				zone,
				code: 0,
				output: "",
			});
		}, 60_000);
	}
});
