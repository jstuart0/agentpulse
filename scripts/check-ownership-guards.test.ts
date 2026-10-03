import { describe, expect, test } from "bun:test";
import {
	OWNER_WRITERS_ALLOWED,
	SESSION_DELETE_ALLOWED,
	checkOwnershipGuards,
	findHandleUseInAdminLockBodies,
	findSessionDeletes,
	findSessionOwnerWrites,
} from "./lib/ownership-guards.js";
import { loadTsFiles } from "./lib/test-seam-utils.js";

const ROOT = new URL("..", import.meta.url).pathname;

async function productionFiles() {
	const all = await loadTsFiles(ROOT, [`${ROOT}src/server`]);
	return all.filter(
		(file) => !/\.(test|fixture)\.ts$/.test(file.rel) && !/(^|\/)test-utils\//.test(file.rel),
	);
}

describe("findSessionOwnerWrites", () => {
	test("finds an update, an insert and raw SQL that set the owner of a session", () => {
		expect(
			findSessionOwnerWrites("await tx.update(sessions).set({ ownerUserId: id }).where(x);"),
		).toEqual([1]);
		expect(
			findSessionOwnerWrites(
				[
					"await getDb()",
					"\t.insert(sessions)",
					"\t.values({",
					"\t\tsessionId,",
					"\t\townerUserId: o,",
					"\t});",
				].join("\n"),
			),
		).toEqual([2]);
		expect(findSessionOwnerWrites("sql`UPDATE sessions SET owner_user_id = ${id}`")).toEqual([1]);
	});

	test("ignores the other tables' owner columns, reads, other session columns and comments", () => {
		for (const source of [
			"await tx.update(apiKeys).set({ ownerUserId: id }).where(x);",
			"const rows = await db.select({ ownerUserId: sessions.ownerUserId }).from(sessions);",
			'await tx.update(sessions).set({ status: "active" }).where(x);',
			"// await tx.update(sessions).set({ ownerUserId: id })",
			'const note = "update(sessions).set({ ownerUserId: x })";',
		]) {
			expect(findSessionOwnerWrites(source), source).toEqual([]);
		}
	});
});

describe("findSessionDeletes", () => {
	test("finds a delete from sessions, in the builder and in raw SQL", () => {
		expect(findSessionDeletes("await tx.delete(sessions).where(x);")).toEqual([1]);
		expect(findSessionDeletes("sql`DELETE FROM sessions WHERE id = ${id}`")).toEqual([1]);
	});

	test("ignores other tables and comments", () => {
		expect(findSessionDeletes("await tx.delete(apiKeys).where(x);")).toEqual([]);
		expect(findSessionDeletes("// tx.delete(sessions)")).toEqual([]);
	});
});

describe("findHandleUseInAdminLockBodies", () => {
	test("flags an ordinary handle used inside a locked body, with its line", () => {
		const source = [
			"await withAdminLock(async (tx) => {",
			"\tawait tx.select().from(users);",
			"\tawait getDb().update(users).set({});",
			"});",
		].join("\n");
		expect(findHandleUseInAdminLockBodies(source)).toEqual({ bodies: 1, lines: [3] });
	});

	test("a body that uses only its own handle, and a getDb call outside any body, are fine", () => {
		const source = [
			"const a = getDb();",
			"await withAdminLock(async (tx) => {",
			"\tawait tx.update(users).set({ note: 'getDb()' });",
			"\treturn { done: true };",
			"});",
			"await getDb().select();",
		].join("\n");
		expect(findHandleUseInAdminLockBodies(source)).toEqual({ bodies: 1, lines: [] });
	});

	test("counts each body, and sees through nested braces", () => {
		const source = [
			"withAdminLock(async (tx) => { if (x) { for (const y of z) { await tx.a(y); } } });",
			"withAdminLock(async (tx) => { await tx.b(); });",
		].join("\n");
		expect(findHandleUseInAdminLockBodies(source).bodies).toBe(2);
	});
});

describe("the real tree", () => {
	test("positive control: the scan sees the writers, deleters and locked bodies that exist", async () => {
		const report = checkOwnershipGuards(await productionFiles());
		for (const named of [
			"src/server/services/event-processor.ts",
			"src/server/services/session-owner-admin.ts",
			"src/server/services/launch-dispatch.ts",
			"src/server/services/managed-session-state.ts",
			"src/server/services/service-keys.ts",
		]) {
			expect(report.ownerWriters, named).toContain(named);
		}
		expect(report.sessionDeleters).toContain("src/server/routes/sessions.ts");
		expect(report.adminLockBodies).toBeGreaterThanOrEqual(15);
	});

	test("every owner writer and session deleter is named and explained, and nothing else is", async () => {
		const report = checkOwnershipGuards(await productionFiles());
		expect(report.violations).toEqual([]);
		expect([...report.ownerWriters].sort()).toEqual(Object.keys(OWNER_WRITERS_ALLOWED).sort());
	});

	test("a new file that writes the owner column, or deletes sessions unchecked, is reported by name", () => {
		const report = checkOwnershipGuards([
			{
				rel: "src/server/services/new-thing.ts",
				content: "await tx.update(sessions).set({ ownerUserId: id });\nawait tx.delete(sessions);",
			},
			{
				rel: "src/server/services/locked.ts",
				content: "withAdminLock(async (tx) => {\n await getDb().select();\n});",
			},
		]);
		expect(report.violations.join("\n")).toContain("src/server/services/new-thing.ts");
		expect(report.violations.join("\n")).toContain("src/server/services/locked.ts");
		expect(report.violations).toHaveLength(3);
	});

	test("session deletes allowed without the authorization module are all named and explained", () => {
		expect(Object.keys(SESSION_DELETE_ALLOWED)).toEqual(["src/server/services/control-actions.ts"]);
	});
});
