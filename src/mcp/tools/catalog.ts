/**
 * Catalog/browse read tools (AGEN-12 Phase 3, D2): get_stats (moved here
 * from server.ts for consistency — dexter's file-split rec), search,
 * list_projects (observe); list_templates/get_template, list_launches/
 * get_launch (manage-only, C1: DTOs carry env/launchSpec/claimToken).
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
				name: "list_projects",
				description: "All configured AgentPulse projects.",
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
	}

	if (flags.hasManage) {
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
