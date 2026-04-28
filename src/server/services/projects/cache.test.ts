import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "../ai/__test_db.js";

// Defer DB-touching imports so the __test_db side-effect can configure
// SQLITE_PATH before the client module binds to it.
const { db, initializeDatabase } = await import("../../db/client.js");
const { projects, sessions } = await import("../../db/schema.js");
const { getCachedProjects, loadEager } = await import("./cache.js");
const { createProject, deleteProject, updateProject } = await import("./projects-service.js");

beforeAll(() => {
	initializeDatabase();
});

beforeEach(async () => {
	await db.delete(sessions).execute();
	await db.delete(projects).execute();
	// Force the cache to reflect the empty table — earlier tests in the
	// same `bun test` run may have left this module's `cached` array
	// populated, since cache state is module-scoped not test-scoped.
	await loadEager();
});

describe("projects cache contract", () => {
	// Every mutation in projects-service must call `bumpVersionAndReload`
	// or the in-memory cache silently drifts. These tests exercise the
	// service entry points and assert the cache reflects each change on
	// the next read.
	test("createProject populates the cache on next read", async () => {
		expect(getCachedProjects()).toHaveLength(0);
		const result = await createProject({ name: "alpha", cwd: "/tmp/ap-alpha" });
		expect(result.project).toBeTruthy();

		const cached = getCachedProjects();
		expect(cached).toHaveLength(1);
		expect(cached[0]?.name).toBe("alpha");
		expect(cached[0]?.cwd).toBe("/tmp/ap-alpha");
	});

	test("updateProject reflects new name and cwd in the cache", async () => {
		const created = await createProject({ name: "before", cwd: "/tmp/ap-before" });
		const id = created.project?.id;
		expect(id).toBeTruthy();
		if (!id) throw new Error("project id missing");

		const updated = await updateProject(id, { name: "after", cwd: "/tmp/ap-after" });
		expect(updated.project).toBeTruthy();

		const cached = getCachedProjects();
		expect(cached).toHaveLength(1);
		expect(cached[0]?.name).toBe("after");
		expect(cached[0]?.cwd).toBe("/tmp/ap-after");
	});

	test("deleteProject removes the entry from the cache", async () => {
		const a = await createProject({ name: "keep", cwd: "/tmp/ap-keep" });
		const b = await createProject({ name: "drop", cwd: "/tmp/ap-drop" });
		expect(getCachedProjects()).toHaveLength(2);

		const dropId = b.project?.id;
		if (!dropId) throw new Error("project id missing");
		const ok = await deleteProject(dropId);
		expect(ok).toBe(true);

		const cached = getCachedProjects();
		expect(cached).toHaveLength(1);
		expect(cached[0]?.name).toBe("keep");
		const aId = a.project?.id;
		if (!aId) throw new Error("project a id missing");
		expect(cached[0]?.id).toBe(aId);
	});

	test("deleteProject of unknown id leaves the cache untouched", async () => {
		await createProject({ name: "solo", cwd: "/tmp/ap-solo" });
		const before = getCachedProjects().slice();
		const ok = await deleteProject("nonexistent-id");
		expect(ok).toBe(false);
		expect(getCachedProjects()).toEqual(before);
	});
});
