/**
 * Launch-orchestration tools (AGEN-12 Phase 4, D2's mutating-tool table):
 * the two side-effect-free advisory tools (recommend_launch,
 * preview_template), launch_agent (H1 contract), and list_hosts
 * (manage-only read, explicit RO [L3]).
 *
 * Session-control writes (prompt_session/stop_session/retry_launch/
 * update_session) live in session-actions.ts — split out (dexter M,
 * mid-build review) to keep one domain per file as the tool population
 * grows through Phase 5.
 *
 * All manage-scoped (D2): every tool here either mutates state or exposes
 * env/launchSpec-bearing data, so none is registered under observe-only.
 *
 * Field-naming convention: see the canonical note near ToolContext in
 * server.ts. The short version — this file's `template`/`launch_spec`
 * nested fields are a deliberate exception (camelCase, mirroring
 * SessionTemplateInput/LaunchSpec verbatim) for round-trip fidelity with
 * preview_template's own output; every top-level scalar param here still
 * snake_cases like the rest of the tool surface.
 */
import { z } from "zod";
import type { LaunchSpec, SessionTemplateInput } from "../../shared/types.js";
import {
	AGENT_TYPE_ENUM,
	APPROVAL_POLICY_ENUM,
	LAUNCH_MODE_ENUM,
	ROUTING_POLICY_ENUM,
	SANDBOX_MODE_ENUM,
} from "../enums.js";
import { registerMutatingTool, registerReadTool } from "../server.js";
import type { ScopeFlags, ToolContext } from "../server.js";

const SESSION_TEMPLATE_INPUT_SHAPE = {
	name: z.string(),
	description: z.string().nullable().optional(),
	agentType: AGENT_TYPE_ENUM,
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

const LAUNCH_SPEC_OBJECT = z.object({
	version: z.literal(1),
	launchCorrelationId: z.string(),
	managedMode: z.literal("unmanaged_preview"),
	agentType: AGENT_TYPE_ENUM,
	launchMode: LAUNCH_MODE_ENUM.optional(),
	cwd: z.string(),
	model: z.string().nullable(),
	approvalPolicy: APPROVAL_POLICY_ENUM.nullable(),
	sandboxMode: SANDBOX_MODE_ENUM.nullable(),
	baseInstructions: z.string(),
	taskPrompt: z.string(),
	env: z.record(z.string(), z.string()),
	// xander L1 (mid-build security review): the supervisor derives its own
	// executable/args server-side today and IGNORES these client-supplied
	// command/cliArgs — this field is passthrough-only, never executed
	// directly from a client-supplied value. If a future "managed" launch
	// mode ever trusts providerConfig.command/cliArgs as-supplied instead of
	// deriving them supervisor-side, that becomes a command-injection
	// primitive gated only by `manage` scope. Keep deriving them
	// server/supervisor-side — never execute a client-supplied command.
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

// Cast-throughs, not transforms — the zod shapes' keys already match
// SessionTemplateInput/LaunchSpec verbatim (see the file header). Two
// SessionTemplateInput variants (rather than one generic) so each call
// site's required-vs-partial contract stays visible in the type, instead of
// every caller re-widening/re-narrowing at the call site.
function toSessionTemplateInput(
	t: z.infer<typeof SESSION_TEMPLATE_INPUT_OBJECT>,
): SessionTemplateInput {
	return t as unknown as SessionTemplateInput;
}

function toPartialSessionTemplateInput(
	t: Partial<z.infer<typeof SESSION_TEMPLATE_INPUT_OBJECT>>,
): Partial<SessionTemplateInput> {
	return t as unknown as Partial<SessionTemplateInput>;
}

function toLaunchSpec(spec: z.infer<typeof LAUNCH_SPEC_OBJECT>): LaunchSpec {
	return spec as unknown as LaunchSpec;
}

/**
 * xander H1/e (mid-build security review): every mutating tool ships this
 * caveat — see session-actions.ts for the identical constant (each file
 * owns its own copy rather than a shared cross-file import, since the two
 * files' tool populations are otherwise independent).
 */
const CONFIRMATION_PORTABILITY_NOTE =
	"This is a state-changing action. The requires-confirmation hint is honored only by MCP hosts that implement it (e.g. Claude Code's UI); other clients (scripted, or hosts without the gate) will execute it without prompting.";

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
			description: `Launch a real AI coding agent (Claude Code or Codex CLI) on a connected host. Spawns an actual process — requires human confirmation. Call recommend_launch and/or preview_template first to see what will happen before committing. Exactly one launch mode: EITHER template_id alone (launches a saved template — the server re-resolves it fresh) OR template+launch_spec together (a fully-specified direct launch, typically preview_template's own output passed straight through). Supplying both, or neither, is rejected — including partial combinations like template_id together with only one of template/launch_spec. ${CONFIRMATION_PORTABILITY_NOTE}`,
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
			const hasTemplate = args.template !== undefined;
			const hasLaunchSpec = args.launch_spec !== undefined;
			// Exactly one mode (H1): template_id ALONE, or template+launch_spec
			// TOGETHER with no template_id. dexter High: a naive
			// `hasTemplateId === (hasTemplate && hasLaunchSpec)` check passes the
			// two partial-combo cases below (template_id+template alone,
			// template_id+launch_spec alone) straight into the template_id path,
			// silently discarding the caller's override — this must be an
			// explicit membership check against the two valid states, not an XOR
			// over a derived "both" flag. Deliberately handler-level (not
			// schema-level) since the root schema must stay flat (no
			// anyOf/oneOf, M7).
			const isTemplateIdMode = hasTemplateId && !hasTemplate && !hasLaunchSpec;
			const isDirectMode = !hasTemplateId && hasTemplate && hasLaunchSpec;

			if (!isTemplateIdMode && !isDirectMode) {
				throw new Error(
					"launch_agent: provide exactly one of template_id | template+launch_spec — no partial combinations (e.g. template_id together with template or launch_spec) are accepted.",
				);
			}

			if (isTemplateIdMode) {
				const templateId = args.template_id;
				if (!templateId) {
					throw new Error(
						"launch_agent: internal error — template_id mode reached without template_id.",
					);
				}
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

			// isDirectMode (above) already proved both are defined — re-check via
			// real narrowing (destructure + guard) rather than an `as` cast, so
			// a future edit to the mode logic can't silently reintroduce an
			// unchecked assertion here.
			const { template: directTemplate, launch_spec: directLaunchSpec } = args;
			if (!directTemplate || !directLaunchSpec) {
				throw new Error(
					"launch_agent: internal error — direct mode reached without template+launch_spec.",
				);
			}
			return client.createLaunch({
				template: toSessionTemplateInput(directTemplate),
				launchSpec: toLaunchSpec(directLaunchSpec),
				requestedSupervisorId: args.requested_supervisor_id ?? null,
				requestedLaunchMode: args.requested_launch_mode,
				routingPolicy: args.routing_policy ?? null,
				desiredDisplayName: args.desired_display_name ?? null,
			});
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
