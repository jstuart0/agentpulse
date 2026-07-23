/**
 * MCP server assembly: registration wrappers + buildMcpServer (AGEN-12
 * Phase 2, D3 seam 2, H5).
 *
 * All tool registration flows through registerReadTool/registerMutatingTool
 * — never through McpServer.registerTool directly (Pattern B in the plan;
 * enforced by the Phase 4 drift guard walking ctx.registry). The wrappers
 * make three things structural rather than per-handler discipline:
 *  1. output.ts caps applied to every handler result, even if the handler
 *     forgot to cap it itself.
 *  2. thrown/rejected errors mapped through errors.ts to {isError:true} —
 *     a domain failure never becomes a thrown MCP protocol error.
 *  3. rUI meta (_meta["anthropic/requiresUserInteraction"]) stamped on every
 *     mutating tool by the wrapper itself, and readOnlyHint:true stamped on
 *     every read tool — "forgot to cap" and "forgot rUI" become
 *     impossible-by-construction.
 * Every registration is recorded in ctx.registry so a later drift guard
 * (Phase 4) can walk the full population.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import type { AgentPulseClient } from "./client.js";
import { mapError } from "./errors.js";
import { capToolResult } from "./output.js";
import { registerResources } from "./resources.js";
import { SCOPE_MANAGE, SCOPE_OBSERVE } from "./scope-constants.js";
import { registerAiTools } from "./tools/ai.js";
import { registerCatalogTools } from "./tools/catalog.js";
import { registerDecideTools } from "./tools/decide.js";
import { registerOrchestrateTools } from "./tools/orchestrate.js";
import { registerSessionActionTools } from "./tools/session-actions.js";
import { registerSessionsTools } from "./tools/sessions.js";
import { registerTemplateMutationTools } from "./tools/templates.js";
import { VERSION } from "./version.js";

export const REQUIRES_USER_INTERACTION_META = "anthropic/requiresUserInteraction";

export interface ToolRegistryEntry {
	name: string;
	readOnly: boolean;
	annotations?: ToolAnnotations;
	meta?: Record<string, unknown>;
}

/**
 * Tool-surface field-naming convention (dexter L, Phase 4 mid-build —
 * promoted here from two scattered file-header comments in tools/*.ts,
 * canonical location going forward): a tool's own TOP-LEVEL input fields
 * use snake_case (session_id, template_id, agent_type, ...), matching every
 * Phase 1-3 read tool. The one deliberate exception is a NESTED
 * pass-through object that mirrors a shared/types.ts shape verbatim in
 * camelCase — currently orchestrate.ts's launch_agent/recommend_launch/
 * preview_template `template`/`launch_spec` fields, which exist so a caller
 * can round-trip preview_template's own camelCase output straight into
 * launch_agent with zero translation. Every other tool (including
 * templates.ts's create_template/update_template, whose fields ARE a
 * tool's own top-level params, not a pass-through blob) snake_cases and
 * translates server-side.
 */
export interface ToolContext {
	readonly server: McpServer;
	readonly client: AgentPulseClient;
	readonly registry: ToolRegistryEntry[];
}

/** Zero-argument tools pass `{}` as their inputSchema (a flat, empty ZodRawShape). */
type EmptyShape = Record<string, never>;

export interface ReadToolConfig<Shape extends z.ZodRawShape = EmptyShape> {
	name: string;
	title?: string;
	description: string;
	inputSchema?: Shape;
	/** readOnlyHint is always forced true by the wrapper — omit it here, it cannot be overridden. */
	annotations?: Omit<ToolAnnotations, "readOnlyHint">;
}

export interface MutatingToolConfig<Shape extends z.ZodRawShape = EmptyShape> {
	name: string;
	title?: string;
	description: string;
	inputSchema?: Shape;
	/**
	 * readOnlyHint is never set by this wrapper. A side-effect-free advisory
	 * POST (recommend_launch, preview_template) that needs readOnlyHint:true
	 * must be registered via registerReadTool instead (D2) — registering it
	 * here and trying to force readOnlyHint would misrepresent it as
	 * non-mutating while still carrying rUI, which is incoherent.
	 */
	annotations?: Omit<ToolAnnotations, "readOnlyHint">;
}

type ArgsOf<Shape extends z.ZodRawShape> = { [K in keyof Shape]: z.infer<Shape[K]> };

type ToolHandler<Shape extends z.ZodRawShape> = (
	args: ArgsOf<Shape>,
	client: AgentPulseClient,
) => Promise<unknown>;

function toCallToolResult(result: unknown): CallToolResult {
	const capped = capToolResult(result);
	return { content: [{ type: "text", text: JSON.stringify(capped, null, 2) }] };
}

function wrapHandler<Shape extends z.ZodRawShape>(ctx: ToolContext, handler: ToolHandler<Shape>) {
	return async (args: unknown): Promise<CallToolResult> => {
		try {
			const result = await handler(args as ArgsOf<Shape>, ctx.client);
			return toCallToolResult(result);
		} catch (err) {
			return mapError(err, ctx.client.baseUrl);
		}
	};
}

export function registerReadTool<Shape extends z.ZodRawShape = EmptyShape>(
	ctx: ToolContext,
	config: ReadToolConfig<Shape>,
	handler: ToolHandler<Shape>,
): void {
	const annotations: ToolAnnotations = { ...config.annotations, readOnlyHint: true };
	ctx.registry.push({ name: config.name, readOnly: true, annotations });

	ctx.server.registerTool(
		config.name,
		{
			title: config.title,
			description: config.description,
			inputSchema: config.inputSchema,
			annotations,
		},
		// The SDK's registerTool callback type is a deeply conditional type
		// keyed on the exact literal inputSchema shape (BaseToolCallback<Args>)
		// that TS cannot resolve through this wrapper's generic Shape
		// parameter. The runtime contract is verified by the in-memory
		// protocol tests (server.test.ts — tools/call round-trips through
		// the real SDK Client/Server pair), not by static typing here.
		wrapHandler(ctx, handler) as unknown as ToolCallback<Shape>,
	);
}

export function registerMutatingTool<Shape extends z.ZodRawShape = EmptyShape>(
	ctx: ToolContext,
	config: MutatingToolConfig<Shape>,
	handler: ToolHandler<Shape>,
): void {
	const annotations: ToolAnnotations = { ...config.annotations };
	const meta = { [REQUIRES_USER_INTERACTION_META]: true };
	ctx.registry.push({ name: config.name, readOnly: false, annotations, meta });

	ctx.server.registerTool(
		config.name,
		{
			title: config.title,
			description: config.description,
			inputSchema: config.inputSchema,
			annotations,
			_meta: meta,
		},
		wrapHandler(ctx, handler) as unknown as ToolCallback<Shape>,
	);
}

export interface BuildMcpServerOptions {
	client: AgentPulseClient;
	scopes: string[];
}

export interface BuildMcpServerResult {
	server: McpServer;
	registry: ToolRegistryEntry[];
}

/**
 * Precomputed scope gates, passed down to each per-domain tool-registration
 * function so `buildMcpServer` stays the single source of truth for "what
 * does this scope set unlock" (D5: manage implies observe-satisfied) rather
 * than every tool file re-deriving it from the raw `scopes` array.
 */
export interface ScopeFlags {
	hasObserve: boolean;
	hasManage: boolean;
}

/**
 * Assembles a fully-registered McpServer for the given client and scope
 * set. Pure (no transport, no I/O beyond what the client does when a tool
 * is invoked) — the same instance is reusable across stdio (Phase 2) and a
 * future streamable-HTTP transport (explicitly out of scope, D5/plan).
 *
 * Registration is delegated to per-domain files under tools/ (each
 * exporting a `registerXTools(ctx, flags)` function) plus resources.ts —
 * kept as a flat list of calls here (Pattern B) rather than growing this
 * file into a god-module as the tool population expands through Phase 4.
 */
export function buildMcpServer({ client, scopes }: BuildMcpServerOptions): BuildMcpServerResult {
	const server = new McpServer({ name: "agentpulse", version: VERSION });
	const registry: ToolRegistryEntry[] = [];
	const ctx: ToolContext = { server, client, registry };

	const hasManage = scopes.includes(SCOPE_MANAGE);
	const hasObserve = scopes.includes(SCOPE_OBSERVE) || hasManage;
	const flags: ScopeFlags = { hasObserve, hasManage };

	registerSessionsTools(ctx, flags);
	registerCatalogTools(ctx, flags);
	registerAiTools(ctx, flags);
	registerOrchestrateTools(ctx, flags);
	registerSessionActionTools(ctx, flags);
	registerTemplateMutationTools(ctx, flags);
	registerDecideTools(ctx, flags);
	if (flags.hasObserve) registerResources(server, client);

	return { server, registry };
}
