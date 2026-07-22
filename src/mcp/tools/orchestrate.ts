/**
 * Orchestration tools (AGEN-12 Phase 4, D2's mutating-tool table): the two
 * side-effect-free advisory tools (recommend_launch, preview_template),
 * launch_agent (H1 contract), the three session-control tools
 * (prompt_session/stop_session/retry_launch, managed-sessions-only [L2]),
 * update_session (per-field fan-out with partial-failure reporting [L4]),
 * and list_hosts (manage-only read, explicit RO [L3]).
 *
 * All manage-scoped (D2): every tool here either mutates state or exposes
 * env/launchSpec-bearing data, so none is registered under observe-only.
 */
import { z } from "zod";
import type { AgentType, ApprovalPolicy, LaunchSpec, SandboxMode } from "../../shared/types.js";
import { ApiError } from "../client.js";
import {
	APPROVAL_POLICY_ENUM,
	LAUNCH_MODE_ENUM,
	ROUTING_POLICY_ENUM,
	SANDBOX_MODE_ENUM,
} from "../enums.js";
import { registerMutatingTool, registerReadTool } from "../server.js";
import type { ScopeFlags, ToolContext } from "../server.js";

/**
 * Mirrors SessionTemplateInput (src/shared/types.ts) verbatim, camelCase —
 * deliberately NOT translated to the tool-surface's usual snake_case
 * top-level convention (contrast create_template/update_template in
 * templates.ts, which DO snake_case). This is a nested pass-through field,
 * not a tool's own top-level params: recommend_launch/preview_template
 * return shapes (RecommendedLaunch, TemplatePreview.normalizedTemplate)
 * that are already camelCase-shaped SessionTemplateInput objects, and
 * launch_agent's whole point is to accept preview_template's own output
 * back with zero translation. Snake-casing this nested object would force
 * every caller through a manual field-rename round-trip for exactly the
 * two-call workflow the tool descriptions recommend.
 */
const SESSION_TEMPLATE_INPUT_SHAPE = {
	name: z.string(),
	description: z.string().nullable().optional(),
	agentType: z.enum(["claude_code", "codex_cli"]),
	cwd: z.string(),
	baseInstructions: z.string().optional(),
	taskPrompt: z.string().optional(),
	model: z.string().nullable().optional(),
	approvalPolicy: APPROVAL_POLICY_ENUM.nullable().optional(),
	sandboxMode: SANDBOX_MODE_ENUM.nullable().optional(),
	env: z.record(z.string(), z.string()).optional(),
	tags: z.array(z.string()).optional(),
	isFavorite: z.boolean().optional(),
};
const SESSION_TEMPLATE_INPUT_OBJECT = z.object(SESSION_TEMPLATE_INPUT_SHAPE);

/** Mirrors LaunchSpec (src/shared/types.ts) verbatim — see the template-shape comment above; same round-trip rationale. */
const LAUNCH_SPEC_OBJECT = z.object({
	version: z.literal(1),
	launchCorrelationId: z.string(),
	managedMode: z.literal("unmanaged_preview"),
	agentType: z.enum(["claude_code", "codex_cli"]),
	launchMode: LAUNCH_MODE_ENUM.optional(),
	cwd: z.string(),
	model: z.string().nullable(),
	approvalPolicy: APPROVAL_POLICY_ENUM.nullable(),
	sandboxMode: SANDBOX_MODE_ENUM.nullable(),
	baseInstructions: z.string(),
	taskPrompt: z.string(),
	env: z.record(z.string(), z.string()),
	providerConfig: z.object({
		command: z.string(),
		cliArgs: z.array(z.string()),
		instructionsFile: z.enum(["CLAUDE.md", "AGENTS.md"]),
	}),
	// Rarely populated by an MCP caller — the server-built preview never sets
	// it today (template-preview.ts's buildTemplatePreview). Kept loose
	// rather than modeling PrelaunchAction's discriminated union here, since
	// this is a nested (non-root) field — M7's flat-schema requirement is
	// root-level only.
	prelaunchActions: z.array(z.record(z.string(), z.unknown())).optional(),
});

type SessionTemplateInputLike = {
	name: string;
	description?: string | null;
	agentType: AgentType;
	cwd: string;
	baseInstructions?: string;
	taskPrompt?: string;
	model?: string | null;
	approvalPolicy?: ApprovalPolicy | null;
	sandboxMode?: SandboxMode | null;
	env?: Record<string, string>;
	tags?: string[];
	isFavorite?: boolean;
};

// Cast-throughs, not transforms — the zod shapes' keys already match
// SessionTemplateInput/its Partial verbatim (see the shape comment above).
// Two variants (rather than one generic) so each call site's required-vs-
// partial contract stays visible in the type, instead of every caller
// re-widening/re-narrowing at the call site.
function toSessionTemplateInput(
	t: z.infer<typeof SESSION_TEMPLATE_INPUT_OBJECT>,
): SessionTemplateInputLike {
	return t as unknown as SessionTemplateInputLike;
}

function toPartialSessionTemplateInput(
	t: Partial<z.infer<typeof SESSION_TEMPLATE_INPUT_OBJECT>>,
): Partial<SessionTemplateInputLike> {
	return t as unknown as Partial<SessionTemplateInputLike>;
}

function toLaunchSpec(spec: z.infer<typeof LAUNCH_SPEC_OBJECT>): LaunchSpec {
	return spec as unknown as LaunchSpec;
}

/** Per-field error text for update_session's partial-failure report — richer than a bare Error.message for an ApiError (which stringifies to just "AgentPulse API error: <status>"). */
function describeFieldError(err: unknown): string {
	if (err instanceof ApiError) {
		const bodyText = typeof err.body === "string" ? err.body : JSON.stringify(err.body);
		return `AgentPulse returned ${err.status}: ${bodyText}`;
	}
	return err instanceof Error ? err.message : String(err);
}

const MANAGED_ONLY_NOTE =
	'Managed sessions only — AgentPulse rejects this for sessions it isn\'t managing the process for ("Session is not managed.").';

export function registerOrchestrateTools(ctx: ToolContext, flags: ScopeFlags): void {
	if (!flags.hasManage) return;

	registerReadTool(
		ctx,
		{
			name: "recommend_launch",
			description:
				"Advisory launch recommendation (agent type/model/launch mode/host) for a draft template. Side-effect-free — never creates a launch. Call this (or preview_template) before launch_agent to get a suggested configuration; the recommendation is not authoritative and can be overridden.",
			inputSchema: {
				template: SESSION_TEMPLATE_INPUT_OBJECT,
				preferred_supervisor_id: z.string().optional(),
			},
		},
		async (args, client) =>
			client.recommendLaunch({
				template: toSessionTemplateInput(args.template),
				preferredSupervisorId: args.preferred_supervisor_id ?? null,
			}),
	);

	registerReadTool(
		ctx,
		{
			name: "preview_template",
			description:
				"Simulate resolving a (possibly partial) template into a launch spec: normalized fields, per-host compatibility, and provider guidance. Side-effect-free — never creates a launch. This is also the exact operation launch_agent performs internally for its template_id path; call it directly first to inspect what launch_agent would do.",
			inputSchema: {
				template: SESSION_TEMPLATE_INPUT_OBJECT.partial().optional(),
				launch_mode: LAUNCH_MODE_ENUM.optional(),
				requested_supervisor_id: z.string().optional(),
				routing_policy: ROUTING_POLICY_ENUM.optional(),
			},
		},
		async (args, client) =>
			client.previewTemplate({
				...(args.template ? toPartialSessionTemplateInput(args.template) : {}),
				launchMode: args.launch_mode,
				requestedSupervisorId: args.requested_supervisor_id ?? null,
				routingPolicy: args.routing_policy ?? null,
			}),
	);

	registerMutatingTool(
		ctx,
		{
			name: "launch_agent",
			title: "Launch agent",
			description:
				"Launch a real AI coding agent (Claude Code or Codex CLI) on a connected host. Spawns an actual process — requires human confirmation. Call recommend_launch and/or preview_template first to see what will happen before committing. Exactly one launch mode: EITHER template_id alone (launches a saved template — the server re-resolves it fresh) OR template+launch_spec together (a fully-specified direct launch, typically preview_template's own output passed straight through). Supplying both, or neither, is rejected.",
			annotations: { openWorldHint: true },
			inputSchema: {
				template_id: z.string().optional(),
				template: SESSION_TEMPLATE_INPUT_OBJECT.optional(),
				launch_spec: LAUNCH_SPEC_OBJECT.optional(),
				requested_supervisor_id: z.string().optional(),
				requested_launch_mode: LAUNCH_MODE_ENUM.optional(),
				routing_policy: ROUTING_POLICY_ENUM.optional(),
				desired_display_name: z.string().optional(),
			},
		},
		async (args, client) => {
			const hasTemplateId = args.template_id !== undefined;
			const hasDirect = args.template !== undefined && args.launch_spec !== undefined;

			// Exactly one mode (H1). Both supplied or neither supplied are both
			// rejected client-side, before any HTTP call — this is deliberately
			// handler-level (not schema-level) since the root schema must stay
			// flat (no anyOf/oneOf, M7).
			if (hasTemplateId === hasDirect) {
				throw new Error(
					"launch_agent: provide exactly one of template_id | template+launch_spec (both or neither were supplied).",
				);
			}

			if (hasTemplateId) {
				const templateId = args.template_id as string;
				const { template } = await client.getTemplate(templateId);
				// Step 2 of the H1 three-call sequence: resolve the template into
				// a launchSpec via the same endpoint the dashboard's own preview
				// uses — never build a launchSpec by hand here.
				const preview = await client.previewTemplate({
					name: template.name,
					description: template.description,
					agentType: template.agentType,
					cwd: template.cwd,
					baseInstructions: template.baseInstructions,
					taskPrompt: template.taskPrompt,
					model: template.model,
					approvalPolicy: template.approvalPolicy,
					sandboxMode: template.sandboxMode,
					env: template.env,
					tags: template.tags,
					isFavorite: template.isFavorite,
					launchMode: args.requested_launch_mode,
					requestedSupervisorId: args.requested_supervisor_id ?? null,
					routingPolicy: args.routing_policy ?? null,
				});
				// Step 3: post templateId + the resolved template + the resolved
				// launchSpec together — NEVER `{templateId}` alone (the validator
				// dereferences launchSpec.launchMode unconditionally,
				// launch-validator.ts:150) so the server still re-resolves
				// project-linked overrides (launches.ts:55-61).
				return client.createLaunch({
					templateId,
					template: preview.normalizedTemplate,
					launchSpec: preview.launchSpec,
					requestedSupervisorId: args.requested_supervisor_id ?? null,
					requestedLaunchMode: args.requested_launch_mode,
					routingPolicy: args.routing_policy ?? null,
					desiredDisplayName: args.desired_display_name ?? null,
				});
			}

			return client.createLaunch({
				// hasDirect (above) already proved both are defined here — TS
				// can't narrow through the boolean, so a direct non-null
				// assertion documents that check rather than re-deriving it.
				template: toSessionTemplateInput(
					args.template as z.infer<typeof SESSION_TEMPLATE_INPUT_OBJECT>,
				),
				launchSpec: toLaunchSpec(args.launch_spec as z.infer<typeof LAUNCH_SPEC_OBJECT>),
				requestedSupervisorId: args.requested_supervisor_id ?? null,
				requestedLaunchMode: args.requested_launch_mode,
				routingPolicy: args.routing_policy ?? null,
				desiredDisplayName: args.desired_display_name ?? null,
			});
		},
	);

	registerMutatingTool(
		ctx,
		{
			name: "prompt_session",
			description: `Inject a prompt into a LIVE agent session, as if typed into its terminal. ${MANAGED_ONLY_NOTE}`,
			inputSchema: { session_id: z.string(), prompt: z.string() },
		},
		async (args, client) => client.promptSession(args.session_id, args.prompt),
	);

	registerMutatingTool(
		ctx,
		{
			name: "stop_session",
			description: `Stop a live agent session's process. ${MANAGED_ONLY_NOTE}`,
			inputSchema: { session_id: z.string() },
		},
		async (args, client) => client.stopSession(args.session_id),
	);

	registerMutatingTool(
		ctx,
		{
			name: "retry_launch",
			description: `Re-launch a session's original launch request as a new one (same template/spec, fresh correlation id). ${MANAGED_ONLY_NOTE}`,
			inputSchema: { session_id: z.string() },
		},
		async (args, client) => client.retryLaunch(args.session_id),
	);

	registerMutatingTool(
		ctx,
		{
			name: "update_session",
			description:
				"Update one or more session fields (notes, display name, pinned, archived) in a single call. Each provided field is applied independently — a failure on one field doesn't block the others. The result reports which fields applied and which failed; call fails (isError) only if every requested field failed.",
			inputSchema: {
				session_id: z.string(),
				notes: z.string().optional(),
				display_name: z.string().optional(),
				pinned: z.boolean().optional(),
				archived: z.boolean().optional(),
			},
		},
		async (args, client) => {
			const applied: string[] = [];
			const failed: Array<{ field: string; error: string }> = [];

			async function attempt(field: string, fn: () => Promise<unknown>) {
				try {
					await fn();
					applied.push(field);
				} catch (err) {
					failed.push({ field, error: describeFieldError(err) });
				}
			}

			if (args.notes !== undefined) {
				await attempt("notes", () =>
					client.updateSessionNotes(args.session_id, args.notes as string),
				);
			}
			if (args.display_name !== undefined) {
				await attempt("display_name", () =>
					client.renameSession(args.session_id, args.display_name as string, "user"),
				);
			}
			if (args.pinned !== undefined) {
				await attempt("pinned", () => client.pinSession(args.session_id, args.pinned as boolean));
			}
			if (args.archived !== undefined) {
				await attempt("archived", () =>
					client.archiveSession(args.session_id, args.archived as boolean),
				);
			}

			// L4: isError only when every requested field failed. Zero fields
			// requested is a legal no-op (empty applied/failed), not an error.
			if (failed.length > 0 && applied.length === 0) {
				throw new Error(
					`update_session: all ${failed.length} requested field(s) failed: ${failed
						.map((f) => `${f.field} (${f.error})`)
						.join("; ")}`,
				);
			}

			return { applied, failed };
		},
	);

	registerReadTool(
		ctx,
		{
			name: "list_hosts",
			description:
				"Connected/enrolled AgentPulse supervisor hosts, for choosing requested_supervisor_id on launch_agent. Manage-scoped (admin router).",
			inputSchema: {},
		},
		async (_args, client) => client.listHosts(),
	);
}
