import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api } from "./api.js";

/**
 * The Setup page asks whether Codex has reported yet. In solo that is the
 * whole instance (a named exception to the dashboard's scope); in team mode it
 * is the viewer's own sessions, so one person's check doesn't pass on
 * someone else's machine.
 */
const realFetch = globalThis.fetch;
let urls: string[] = [];

beforeEach(() => {
	urls = [];
	globalThis.fetch = ((input: RequestInfo | URL) => {
		urls.push(String(input));
		return Promise.resolve(
			new Response(JSON.stringify({ sessions: [], total: 0 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("getCodexProbeSessions", () => {
	test("team mode asks for the viewer's own Codex sessions", async () => {
		await api.getCodexProbeSessions(true);
		const query = new URL(urls[0], "http://x").searchParams;
		expect(query.get("agent_type")).toBe("codex_cli");
		expect(query.get("limit")).toBe("1");
		expect(query.get("owner")).toBe("me");
	});

	test("solo asks about the whole instance, as it always did", async () => {
		await api.getCodexProbeSessions(false);
		const query = new URL(urls[0], "http://x").searchParams;
		expect(query.get("agent_type")).toBe("codex_cli");
		expect(query.has("owner")).toBe(false);
	});
});

describe("the Setup page passes the viewer's mode", () => {
	test("it asks with the ownership flag, not with a fixed answer", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const page = readFileSync(join(import.meta.dir, "..", "pages", "SetupPage.tsx"), "utf8");
		expect(page).toContain("getCodexProbeSessions(ownership.showScope)");
	});
});
