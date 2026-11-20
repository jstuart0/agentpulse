/**
 * get_update_status (AGEN-155 phase 3): the observe-scoped read of whether a newer AgentPulse exists.
 * It wraps GET /capabilities `.update`. An older server has no `update`: that is `{state: "unknown"}`,
 * never an error. There is no tool that starts or enables an update (the server has no such route).
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHttpClient } from "../client.js";
import { REQUIRES_USER_INTERACTION_META, type ToolContext } from "../server.js";
import { fakeClient } from "../test-support.js";
import type { UpdateStatus } from "../types.js";
import { registerUpdateTools } from "./update.js";

const STATUS: UpdateStatus = {
	current: "0.11.0",
	latest: "0.12.0",
	state: "available",
	stale: false,
	severity: "normal",
	checkedAt: "2026-11-19T12:00:00.000Z",
	lastResult: "ok",
	manifestIssuedAt: "2026-11-19T11:00:00.000Z",
	installKind: "local",
	track: "release",
	localApply: null,
};

function newContext(client: ReturnType<typeof fakeClient>): ToolContext {
	const server = new McpServer({ name: "agentpulse-test", version: "0.0.0-test" });
	return { server, client, registry: [] };
}

async function connect(ctx: ToolContext) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const mcpClient = new Client({ name: "test-client", version: "0.0.0" });
	await Promise.all([mcpClient.connect(clientTransport), ctx.server.connect(serverTransport)]);
	return mcpClient;
}

const textOf = (result: unknown) =>
	((result as { content: Array<{ text: string }> }).content[0] ?? { text: "" }).text;

describe("get_update_status", () => {
	test("is registered for an observe caller, read-only, with no rUI meta, and takes no arguments", async () => {
		const ctx = newContext(fakeClient({ getUpdateStatus: async () => STATUS }));
		registerUpdateTools(ctx, { hasObserve: true, hasManage: false });
		const { tools } = await (await connect(ctx)).listTools();
		const tool = tools.find((t) => t.name === "get_update_status");
		expect(tool).toBeDefined();
		expect(tool?.annotations?.readOnlyHint).toBe(true);
		expect(
			(tool?._meta as Record<string, unknown> | undefined)?.[REQUIRES_USER_INTERACTION_META],
		).toBeUndefined();
		expect(Object.keys((tool?.inputSchema as { properties?: object }).properties ?? {})).toEqual(
			[],
		);
	});

	test("is not registered without observe, and registers exactly one tool: nothing mutating", async () => {
		const none = newContext(fakeClient());
		registerUpdateTools(none, { hasObserve: false, hasManage: false });
		expect(none.registry).toHaveLength(0);
		const ctx = newContext(fakeClient());
		registerUpdateTools(ctx, { hasObserve: true, hasManage: true });
		expect(ctx.registry.map((r) => r.name)).toEqual(["get_update_status"]);
	});

	test("returns the status the client read", async () => {
		const ctx = newContext(fakeClient({ getUpdateStatus: async () => STATUS }));
		registerUpdateTools(ctx, { hasObserve: true, hasManage: false });
		const result = await (await connect(ctx)).callTool({
			name: "get_update_status",
			arguments: {},
		});
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(textOf(result))).toEqual(STATUS);
	});

	test("an older server's answer comes through as state unknown, not an error", async () => {
		const ctx = newContext(fakeClient({ getUpdateStatus: async () => ({ state: "unknown" }) }));
		registerUpdateTools(ctx, { hasObserve: true, hasManage: false });
		const result = await (await connect(ctx)).callTool({
			name: "get_update_status",
			arguments: {},
		});
		expect(result.isError).toBeFalsy();
		expect(JSON.parse(textOf(result))).toEqual({ state: "unknown" });
	});
});

describe("the client's getUpdateStatus", () => {
	function clientFor(body: unknown, status = 200) {
		const calls: Array<{ url: string; method: string }> = [];
		const client = createHttpClient({
			baseUrl: "http://localhost:3000",
			apiKey: "ap_test",
			fetchImpl: (async (url: string, init?: RequestInit) => {
				calls.push({ url: String(url), method: init?.method ?? "GET" });
				return new Response(JSON.stringify(body), {
					status,
					headers: { "Content-Type": "application/json" },
				});
			}) as unknown as typeof fetch,
		});
		return { client, calls };
	}

	test("reads GET /capabilities and returns its update", async () => {
		const { client, calls } = clientFor({ apiLevel: 1, features: {}, update: STATUS });
		expect(await client.getUpdateStatus()).toEqual(STATUS);
		expect(calls).toEqual([{ url: "http://localhost:3000/api/v1/capabilities", method: "GET" }]);
	});

	test("a server with no update field is state unknown", async () => {
		const { client } = clientFor({ apiLevel: 1, features: {} });
		expect(await client.getUpdateStatus()).toEqual({ state: "unknown" });
	});

	test("a malformed update field is state unknown too, never passed through", async () => {
		for (const bad of [null, "available", 3, [], { state: 4 }]) {
			const { client } = clientFor({ update: bad });
			expect(await client.getUpdateStatus()).toEqual({ state: "unknown" });
		}
	});

	test("a state this client doesn't know is passed through as the server said it", async () => {
		const { client } = clientFor({ update: { ...STATUS, state: "from_the_future" } });
		expect(((await client.getUpdateStatus()) as { state: string }).state).toBe("from_the_future");
	});

	test("only known fields come through: an extra key, a command or a URL is dropped", async () => {
		const { client } = clientFor({
			update: {
				...STATUS,
				command: "rm -rf /",
				url: "https://evil.example",
				localApply: { auto: true, shell: "x" },
			},
		});
		const out = (await client.getUpdateStatus()) as unknown as Record<string, unknown>;
		expect(JSON.stringify(out)).not.toMatch(/rm -rf|evil|shell/);
		expect(Object.keys(out).sort()).toEqual(
			[
				"checkedAt",
				"current",
				"installKind",
				"lastResult",
				"latest",
				"localApply",
				"manifestIssuedAt",
				"severity",
				"stale",
				"state",
				"track",
			].sort(),
		);
	});

	test("a server that leaves localApply out (a member's view) gives no localApply key", async () => {
		const { localApply: _omitted, ...withoutApply } = { ...STATUS, localApply: null };
		const out = (await clientFor({
			update: withoutApply,
		}).client.getUpdateStatus()) as unknown as Record<string, unknown>;
		expect("localApply" in out).toBe(false);
	});

	test("current and latest must be release versions: a bad current is unknown, a bad latest is null", async () => {
		for (const bad of [
			"",
			"1.2",
			"v1.2.3",
			"01.2.3",
			"1.2.3; id",
			"1.2.3\n",
			`1.2.3-${"a".repeat(60)}`,
		]) {
			expect(
				await clientFor({ update: { ...STATUS, current: bad } }).client.getUpdateStatus(),
			).toEqual({ state: "unknown" });
			expect(
				(
					(await clientFor({
						update: { ...STATUS, latest: bad },
					}).client.getUpdateStatus()) as UpdateStatus
				).latest,
			).toBeNull();
		}
	});

	test("a caller without authority gets the six public fields and nothing is invented for the rest", async () => {
		const pub = {
			current: "0.11.0",
			latest: "0.12.0",
			state: "available",
			stale: false,
			severity: "normal",
			checkedAt: STATUS.checkedAt,
		};
		const out = (await clientFor({ update: pub }).client.getUpdateStatus()) as unknown as Record<
			string,
			unknown
		>;
		expect(out).toEqual(pub);
	});

	test("not_published passes through as a check result", async () => {
		const out = (await clientFor({
			update: { ...STATUS, state: "unverified", latest: null, lastResult: "not_published" },
		}).client.getUpdateStatus()) as UpdateStatus;
		expect(out.lastResult).toBe("not_published");
	});
});
