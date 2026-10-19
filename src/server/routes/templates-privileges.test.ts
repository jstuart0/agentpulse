/**
 * Templates that carry a value the supervisor now refuses are never rewritten: reads carry
 * `privilegesUnsupported` with the change to offer, saving them unchanged is refused, and the
 * explicit change (a PUT with the suggested value) works.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import "../services/ai/__test_db.js";

const { config } = await import("../config.js");
const { initializeDatabase, getDb } = await import("../db/client.js");
const { sessionTemplates } = await import("../db/schema/index.js");
const { templatesRouter } = await import("./templates.js");

const originalDisableAuth = config.disableAuth;
const app = new Hono();
app.route("/api/v1", templatesRouter);

beforeAll(async () => {
	await initializeDatabase();
	config.disableAuth = true;
});
afterAll(() => {
	config.disableAuth = originalDisableAuth;
});
beforeEach(async () => {
	await getDb().delete(sessionTemplates).execute();
});

async function seed(over: Partial<typeof sessionTemplates.$inferInsert>) {
	const id = crypto.randomUUID();
	await getDb()
		.insert(sessionTemplates)
		.values({ id, name: `t-${id}`, agentType: "claude_code", cwd: "/tmp/tp", ...over });
	return id;
}

type Tpl = {
	id: string;
	approvalPolicy: string | null;
	sandboxMode: string | null;
	privilegesUnsupported: {
		issues: Array<{ setting: string; value: string; suggested: string | null }>;
	} | null;
	effectivePrivileges: { enforcedArgs: string[] } | null;
};

async function list(): Promise<Tpl[]> {
	const res = await app.request("/api/v1/templates");
	expect(res.status).toBe(200);
	return ((await res.json()) as { templates: Tpl[] }).templates;
}

describe("templates carry privilegesUnsupported on read", () => {
	test("auto and on-failure get a suggestion of manual; the stored row is untouched", async () => {
		const a = await seed({ approvalPolicy: "auto" });
		const b = await seed({ approvalPolicy: "on-failure", agentType: "codex_cli" });
		const c = await seed({ approvalPolicy: "manual" });
		const byId = Object.fromEntries((await list()).map((t) => [t.id, t]));
		for (const id of [a, b]) {
			expect(byId[id].privilegesUnsupported?.issues[0]).toMatchObject({
				setting: "approvalPolicy",
				suggested: "manual",
			});
			expect(byId[id].effectivePrivileges).toBeNull();
		}
		expect(byId[a].approvalPolicy).toBe("auto");
		expect(byId[c].privilegesUnsupported).toBeNull();
		expect(byId[c].effectivePrivileges?.enforcedArgs).toEqual(["--permission-mode", "default"]);
	});

	test("a Claude template's read-only sandbox is flagged with a clear-it suggestion; Codex's is fine", async () => {
		const claude = await seed({ sandboxMode: "read-only" });
		const codex = await seed({ sandboxMode: "read-only", agentType: "codex_cli" });
		const byId = Object.fromEntries((await list()).map((t) => [t.id, t]));
		expect(byId[claude].privilegesUnsupported?.issues[0]).toMatchObject({
			setting: "sandboxMode",
			suggested: null,
		});
		expect(byId[codex].privilegesUnsupported).toBeNull();
	});
});

describe("the explicit change", () => {
	function body(approvalPolicy: string | null) {
		return JSON.stringify({
			name: "fixed",
			agentType: "claude_code",
			cwd: "/tmp/tp",
			taskPrompt: "go",
			approvalPolicy,
		});
	}
	const put = (id: string, payload: string) =>
		app.request(`/api/v1/templates/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: payload,
		});

	test("saving the unsupported value again is refused; saving the suggestion clears the flag", async () => {
		const id = await seed({ approvalPolicy: "auto" });
		const refused = await put(id, body("auto"));
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as { error: string }).error).toContain("Approval policy 'auto'");
		const ok = await put(id, body("manual"));
		expect(ok.status).toBe(200);
		const tpl = (await list()).find((t) => t.id === id);
		expect(tpl?.approvalPolicy).toBe("manual");
		expect(tpl?.privilegesUnsupported).toBeNull();
	});
});
