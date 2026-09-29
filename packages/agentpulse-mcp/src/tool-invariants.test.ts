/**
 * Drift guard (AGEN-12 Phase 4, plan Pattern B / D2 / test-contract
 * assertions 16-21).
 *
 * BINDING CORRECTION (tessa, Phase 2 mid-build reconciliation, Finding
 * H-1): every assertion here walks a LIVE tools/list (and, for the
 * converse check, tools/call) over a real InMemoryTransport + SDK Client
 * connected to buildMcpServer(...) — never ctx.registry, which is the
 * wrapper's own bookkeeping and would only prove the wrapper agrees with
 * itself, not that the protocol surface is correct.
 *
 * Assertion 17's converse check (M-3, Phase 3 mid-build reconciliation)
 * uses REAL HTTP-verb instrumentation: a real createHttpClient() with an
 * instrumented fetchImpl recording init.method per call — not a name-only
 * check against AgentPulseClient's interface (which would be vacuously
 * true for any tool that compiles). D2 documents two tools
 * (recommend_launch, preview_template) as a DELIBERATE exception: they
 * carry readOnlyHint:true (side-effect-free, advisory) while wrapping a
 * POST endpoint — the converse check therefore uses an explicit allowlist
 * (ADVISORY_POST_TOOLS) rather than a blanket "every RO tool must issue
 * only GET" rule, per M-3's suggested remediation option (b): "a static
 * check correlating each tool's known wrapped endpoint against its
 * annotation."
 *
 * Tool-count note (assertion 20): the test-contract's literal text ("28
 * tools total ... 16 for observe") is stale — verified against the actual
 * Phase 3 ground truth in server.test.ts, observe is 11 (not 16; 16 was
 * Phase 3's MANAGE total) and the "12 mutating" figure in the test-contract
 * doesn't include list_hosts, which the plan's own Phase 4 section lists as
 * a SEPARATE bullet (step 2) from the "12 mutating/advisory tools" (step
 * 1). The corrected, verified counts used below (as of Phase 4): observe=11,
 * manage=29 (11 observe + 5 Phase-3 manage-only reads + 13 Phase-4
 * additions: 12 from D2's mutating-tool table + list_hosts).
 *
 * F23 correction (codex r2, post-Phase-5 reconcile): list_projects moved
 * from observe to manage-only — mapProject() returns arbitrary
 * notes/metadata and a githubRepoUrl that can carry userinfo credentials,
 * the same DTO-leak class as the C1 exclusions. observe is now 10 (not
 * 11); manage's total of 29 is unchanged (list_projects still counts once,
 * just via PHASE3_MANAGE_ONLY_READ_NAMES instead of OBSERVE_TOOL_NAMES).
 *
 * AIMR-214 Phase A correction: list_projects_summary is a NEW observe-scoped
 * tool (a narrower sibling DTO, GET /projects/summary — id/name/defaults +
 * redacted githubRepoUrl) — not a reversal of the F23 move above, which
 * still governs list_projects. observe is now 11 (10 + list_projects_summary);
 * manage's total is now 30 (11 observe + 6 Phase-3 manage-only reads + 13
 * Phase-4 additions); the manage-vs-observe delta (assertion 21) is
 * unchanged at 19 names since list_projects_summary is counted once, via
 * OBSERVE_TOOL_NAMES.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHttpClient } from "./client.js";
import { REQUIRES_USER_INTERACTION_META, buildMcpServer } from "./server.js";
import { fakeClient } from "./test-support.js";

async function connectServer(scopes: string[], client = fakeClient()) {
	const { server, registry } = buildMcpServer({ client, scopes });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const mcpClient = new Client({ name: "drift-guard", version: "0.0.0" });
	await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);
	return { mcpClient, registry };
}

const OBSERVE_TOOL_NAMES = [
	"get_stats",
	"list_sessions",
	"get_session",
	"get_session_timeline",
	"get_event_context",
	"get_session_claude_md",
	"search",
	"get_session_intelligence",
	"get_digest",
	"get_ai_status",
	// AIMR-214 Phase A — the observe-safe project summary DTO.
	"list_projects_summary",
];

// F23: list_projects lives here, not OBSERVE_TOOL_NAMES — see file docstring.
const PHASE3_MANAGE_ONLY_READ_NAMES = [
	"list_projects",
	"list_templates",
	"get_template",
	"list_launches",
	"get_launch",
	"get_inbox",
];

const PHASE4_RO_NAMES = ["recommend_launch", "preview_template", "list_hosts"];

const PHASE4_MUTATING_NAMES = [
	"launch_agent",
	"prompt_session",
	"stop_session",
	"retry_launch",
	"update_session",
	"create_template",
	"update_template",
	"delete_template",
	"decide_hitl",
	"decide_action_request",
];

const MANAGE_TOTAL = [
	...OBSERVE_TOOL_NAMES,
	...PHASE3_MANAGE_ONLY_READ_NAMES,
	...PHASE4_RO_NAMES,
	...PHASE4_MUTATING_NAMES,
];

const EXCLUSION_DENYLIST = [
	"delete_session",
	"update_settings",
	"create_api_key",
	"revoke_api_key",
	"enroll_supervisor",
	"rotate_supervisor",
	"revoke_supervisor",
	"batch_decline",
	"ask",
	"fork_session",
	"resume_session",
];

describe("drift guard: every non-RO tool carries rUI (assertion 16)", () => {
	test("every tools/list entry lacking readOnlyHint:true carries the rUI meta", async () => {
		const { mcpClient } = await connectServer(["observe", "manage"]);
		const { tools } = await mcpClient.listTools();
		expect(tools.length).toBe(MANAGE_TOTAL.length);
		for (const tool of tools) {
			if (tool.annotations?.readOnlyHint === true) continue;
			expect(
				(tool._meta as Record<string, unknown> | undefined)?.[REQUIRES_USER_INTERACTION_META],
				`${tool.name} lacks readOnlyHint:true but is missing rUI meta`,
			).toBe(true);
		}
	});

	test("every RO tool carries no rUI meta (converse of the above)", async () => {
		const { mcpClient } = await connectServer(["observe", "manage"]);
		const { tools } = await mcpClient.listTools();
		for (const tool of tools) {
			if (tool.annotations?.readOnlyHint !== true) continue;
			expect(
				(tool._meta as Record<string, unknown> | undefined)?.[REQUIRES_USER_INTERACTION_META],
				`${tool.name} is readOnlyHint:true but carries rUI meta`,
			).toBeUndefined();
		}
	});
});

/**
 * tessa L (Phase 4 mid-build review): walks the destructiveHint population
 * explicitly (not just a per-tool test scoped to delete_template in
 * templates.test.ts) so the NEXT destructive tool a future phase adds is
 * forced through a conscious update here too — matching the same
 * intentionally-brittle philosophy as the tool-count assertion (20) below.
 */
describe("drift guard: destructiveHint population (tessa L)", () => {
	test("delete_template is the only currently-registered destructiveHint tool; every destructiveHint tool also carries rUI", async () => {
		const { mcpClient } = await connectServer(["observe", "manage"]);
		const { tools } = await mcpClient.listTools();
		const destructive = tools
			.filter((t) => t.annotations?.destructiveHint === true)
			.map((t) => t.name);
		// Update this list — deliberately, not silently — the day a second
		// destructive tool is registered.
		expect(destructive).toEqual(["delete_template"]);
		for (const name of destructive) {
			const tool = tools.find((t) => t.name === name);
			expect(
				(tool?._meta as Record<string, unknown> | undefined)?.[REQUIRES_USER_INTERACTION_META],
				`${name} carries destructiveHint but not rUI`,
			).toBe(true);
		}
	});
});

describe("drift guard: exclusion denylist (assertion 18)", () => {
	test("no registered tool name matches an excluded name", async () => {
		const { mcpClient } = await connectServer(["observe", "manage"]);
		const { tools } = await mcpClient.listTools();
		const names = new Set(tools.map((t) => t.name));
		for (const excluded of EXCLUSION_DENYLIST) {
			expect(names.has(excluded), `${excluded} must never be registered`).toBe(false);
		}
	});
});

describe("drift guard: no root anyOf/oneOf/allOf on any tool's input schema (assertion 19)", () => {
	test("every registered tool's inputSchema is flat at the root", async () => {
		const { mcpClient } = await connectServer(["observe", "manage"]);
		const { tools } = await mcpClient.listTools();
		expect(tools.length).toBeGreaterThan(0);
		for (const tool of tools) {
			const schema = tool.inputSchema as Record<string, unknown>;
			expect(schema.anyOf, `${tool.name} schema must not have root anyOf`).toBeUndefined();
			expect(schema.oneOf, `${tool.name} schema must not have root oneOf`).toBeUndefined();
			expect(schema.allOf, `${tool.name} schema must not have root allOf`).toBeUndefined();
		}
	});
});

describe("drift guard: tool count sanity (assertion 20, corrected counts — see file docstring)", () => {
	test("manage-scoped server registers exactly 30 tools (11 observe + 6 Phase-3 manage-only reads + 13 Phase-4 additions, post-AIMR-214-A)", async () => {
		const { mcpClient, registry } = await connectServer(["manage"]);
		const { tools } = await mcpClient.listTools();
		expect(tools.length).toBe(30);
		expect(registry.length).toBe(30);
		expect(new Set(tools.map((t) => t.name))).toEqual(new Set(MANAGE_TOTAL));
	});

	test("observe-scoped server registers exactly 11 tools (AIMR-214-A: list_projects_summary added)", async () => {
		const { mcpClient } = await connectServer(["observe"]);
		const { tools } = await mcpClient.listTools();
		expect(tools.length).toBe(11);
		expect(new Set(tools.map((t) => t.name))).toEqual(new Set(OBSERVE_TOOL_NAMES));
	});
});

describe("tools/list diff observe vs manage (assertion 21, corrected — see file docstring)", () => {
	test("manage set is a strict superset of observe; the delta is exactly the 19 manage-only names (6 Phase-3 + 13 Phase-4, post-F23/AIMR-214-A)", async () => {
		const { mcpClient: observeClient } = await connectServer(["observe"]);
		const { mcpClient: manageClient } = await connectServer(["manage"]);
		const observeNames = new Set((await observeClient.listTools()).tools.map((t) => t.name));
		const manageNames = new Set((await manageClient.listTools()).tools.map((t) => t.name));

		for (const name of observeNames) {
			expect(manageNames.has(name), `${name} in observe must also be in manage`).toBe(true);
		}

		const delta = [...manageNames].filter((n) => !observeNames.has(n));
		const expectedDelta = new Set([
			...PHASE3_MANAGE_ONLY_READ_NAMES,
			...PHASE4_RO_NAMES,
			...PHASE4_MUTATING_NAMES,
		]);
		expect(new Set(delta)).toEqual(expectedDelta);
		expect(delta.length).toBe(19);
		// No Phase-4 mutating tool leaked into observe scope — the specific
		// regression this test guards against.
		for (const mutating of PHASE4_MUTATING_NAMES) {
			expect(observeNames.has(mutating)).toBe(false);
		}
	});
});

/**
 * Converse check (assertion 17, M-3's binding correction): real HTTP-verb
 * instrumentation via a real createHttpClient, not a client-double
 * method-name check. Every RO tool must issue only GET/HEAD, EXCEPT the two
 * documented advisory exceptions (recommend_launch, preview_template),
 * which must issue exactly POST (their wire verb) — asserted explicitly,
 * not silently excluded, so a regression that makes them GET (or some
 * other unexpected verb) still fails loudly.
 */
describe("drift guard: converse read-only check with real HTTP-verb instrumentation (assertion 17)", () => {
	const ADVISORY_POST_TOOLS = new Set(["recommend_launch", "preview_template"]);

	// Minimal valid arguments per RO tool — required fields only.
	const ARGS_FOR: Record<string, Record<string, unknown>> = {
		get_stats: {},
		list_sessions: {},
		get_session: { session_id: "s1" },
		get_session_timeline: { session_id: "s1" },
		get_event_context: { session_id: "s1", event_id: 1 },
		get_session_claude_md: { session_id: "s1" },
		search: { q: "x" },
		list_projects: {},
		list_projects_summary: {},
		get_session_intelligence: { session_id: "s1" },
		get_digest: {},
		get_ai_status: {},
		list_templates: {},
		get_template: { template_id: "t1" },
		list_launches: {},
		get_launch: { launch_id: "l1" },
		get_inbox: {},
		recommend_launch: { template: { name: "t", agentType: "codex_cli", cwd: "/repo" } },
		preview_template: {},
		list_hosts: {},
	};

	function instrumentedClient() {
		const methods: string[] = [];
		const fetchImpl = (async (_url: string, init?: RequestInit) => {
			methods.push((init?.method ?? "GET").toUpperCase());
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;
		const client = createHttpClient({ baseUrl: "http://localhost:3000", apiKey: "k", fetchImpl });
		return { client, methods };
	}

	test("every RO tool that is NOT a documented advisory exception issues only GET/HEAD", async () => {
		const { client, methods } = instrumentedClient();
		const { server, registry } = buildMcpServer({ client, scopes: ["observe", "manage"] });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "drift-guard-http", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

		const roTools = registry.filter((r) => r.readOnly && !ADVISORY_POST_TOOLS.has(r.name));
		expect(roTools.length).toBeGreaterThan(0);
		for (const entry of roTools) {
			const args = ARGS_FOR[entry.name];
			expect(args, `no ARGS_FOR entry for ${entry.name} — add one`).toBeDefined();
			methods.length = 0;
			await mcpClient.callTool({ name: entry.name, arguments: args });
			for (const method of methods) {
				expect(method, `${entry.name} (readOnlyHint:true) issued a non-GET/HEAD request`).toMatch(
					/^(GET|HEAD)$/,
				);
			}
		}
	});

	test("the two documented advisory exceptions (recommend_launch, preview_template) issue exactly POST", async () => {
		const { client, methods } = instrumentedClient();
		const { server } = buildMcpServer({ client, scopes: ["observe", "manage"] });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const mcpClient = new Client({ name: "drift-guard-http-advisory", version: "0.0.0" });
		await Promise.all([mcpClient.connect(clientTransport), server.connect(serverTransport)]);

		for (const name of ADVISORY_POST_TOOLS) {
			methods.length = 0;
			await mcpClient.callTool({ name, arguments: ARGS_FOR[name] });
			expect(methods.length, `${name} should issue exactly one HTTP call`).toBe(1);
			expect(methods[0], `${name} should be POST (documented RO-but-POST exception, D2)`).toBe(
				"POST",
			);
		}
	});

	test("every mutating tool is excluded from this converse check (it legitimately mutates)", async () => {
		const { registry } = buildMcpServer({ client: fakeClient(), scopes: ["observe", "manage"] });
		const mutatingNames = new Set(registry.filter((r) => !r.readOnly).map((r) => r.name));
		expect(mutatingNames).toEqual(new Set(PHASE4_MUTATING_NAMES));
	});
});
