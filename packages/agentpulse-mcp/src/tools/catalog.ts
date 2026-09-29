/**
 * Catalog/browse read tools (AGEN-12 Phase 3, D2): get_stats, search
 * (observe); list_projects, list_templates/get_template, list_launches/
 * get_launch (manage-only). list_projects moved here from the observe set
 * in the F23 reconcile (codex r2): mapProject() returns arbitrary
 * notes/metadata and a githubRepoUrl that can carry userinfo credentials —
 * the same DTO-leak class as the C1 launches/templates exclusion.
 *
 * AIMR-214 Phase A adds list_projects_summary back to the observe set: a
 * narrower sibling DTO (id/name/defaults + a redacted githubRepoUrl,
 * dropping notes/metadata/cwd) backed by GET /projects/summary — not a
 * reversal of the F23 reconcile above, which still governs list_projects.
 */
import { z } from "zod";
import { AGENT_TYPE_ENUM } from "../enums.js";
import { capList, capText } from "../output.js";
import { registerReadTool } from "../server.js";
import type { ScopeFlags, ToolContext } from "../server.js";

export function registerCatalogTools(ctx: ToolContext, flags: ScopeFlags): void {
	if (flags.hasObserve) {
		registerReadTool(
			ctx,
			{
				name: "get_stats",
				description:
					"Dashboard KPI stats: active session count, sessions started today, tool uses today, and a breakdown by agent type.",
				inputSchema: {},
			},
			async (_args, client) => client.getStats(),
		);

		registerReadTool(
			ctx,
			{
				name: "search",
				description:
					"Full-text search across session metadata and event content (FTS5/ILIKE-backed).",
				inputSchema: {
					q: z.string().min(1),
					kinds: z.array(z.enum(["session", "event"])).optional(),
					limit: z.number().int().min(1).max(100).optional(),
					offset: z.number().int().min(0).optional(),
				},
			},
			async (args, client) => {
				const offset = args.offset ?? 0;
				const result = await client.search({
					q: args.q,
					kinds: args.kinds,
					limit: args.limit ?? 20,
					offset,
				});
				const hits = result.hits.map((h) => ({ ...h, snippet: capText(h.snippet) }));
				const capped = capList(hits, { offset });
				return {
					hits: capped.items,
					total: result.total,
					backend: result.backend,
					...(capped.hint ? { truncated: capped.hint } : {}),
				};
			},
		);

		registerReadTool(
			ctx,
			{
				name: "list_projects_summary",
				description:
					"The observe-safe project summary: id/name/defaults only, with githubRepoUrl reduced to origin+pathname (userinfo, query, and fragment stripped). Full project detail — arbitrary operator-set notes/metadata and the unredacted githubRepoUrl — remains available only via the manage-scoped list_projects tool.",
				inputSchema: {},
			},
			async (_args, client) => {
				const { projects } = await client.listProjectsSummary();
				const capped = capList(projects);
				return {
					projects: capped.items,
					total: projects.length,
					...(capped.hint ? { truncated: capped.hint } : {}),
				};
			},
		);
	}

	if (flags.hasManage) {
		registerReadTool(
			ctx,
			{
				name: "list_projects",
				description:
					"All configured AgentPulse projects. Manage-scoped (F23): project DTOs carry arbitrary operator-set `notes`/`metadata` and a `githubRepoUrl` that may embed userinfo credentials.",
				inputSchema: {},
			},
			async (_args, client) => {
				const { projects, total } = await client.listProjects();
				const capped = capList(projects);
				return {
					projects: capped.items,
					total,
					...(capped.hint ? { truncated: capped.hint } : {}),
				};
			},
		);

		registerReadTool(
			ctx,
			{
				name: "list_templates",
				description:
					"Session launch templates. Manage-scoped: template DTOs carry `env` (may include credentials).",
				inputSchema: { agent_type: AGENT_TYPE_ENUM.optional() },
			},
			async (args, client) => {
				const { templates, total } = await client.listTemplates({ agentType: args.agent_type });
				const capped = capList(templates);
				return {
					templates: capped.items,
					total,
					...(capped.hint ? { truncated: capped.hint } : {}),
				};
			},
		);

		registerReadTool(
			ctx,
			{
				name: "get_template",
				description:
					"Detail for one session launch template, including its resolved project. Manage-scoped: carries `env`.",
				inputSchema: { template_id: z.string() },
			},
			async (args, client) => client.getTemplate(args.template_id),
		);

		registerReadTool(
			ctx,
			{
				name: "list_launches",
				description:
					"Launch requests (queued/launching/running/completed/...). Manage-scoped: DTOs carry env/launchSpec/claimToken.",
				inputSchema: {},
			},
			async (_args, client) => {
				const { launches, total } = await client.listLaunches();
				const capped = capList(launches);
				return {
					launches: capped.items,
					total,
					...(capped.hint ? { truncated: capped.hint } : {}),
				};
			},
		);

		registerReadTool(
			ctx,
			{
				name: "get_launch",
				description:
					"Detail for one launch request, including the session it produced (if any). Manage-scoped: carries env/launchSpec/claimToken.",
				inputSchema: { launch_id: z.string() },
			},
			async (args, client) => client.getLaunch(args.launch_id),
		);
	}
}
