// Typed discriminated union for the JSON `payload` column of
// `ai_action_requests`. The table itself is a generic kind+payload+status
// row, but each `kind` has a fixed payload shape. Centralising the shapes
// here lets every read site narrow with `narrowPayload(req, "<kind>")`
// instead of casting `as unknown as <T>` (which silently produces undefined
// for renamed fields).
//
// Add a new kind in three places when extending:
//   1. Add a discriminant member here.
//   2. Add it to `KNOWN_ACTION_REQUEST_KINDS` below — the runtime gate
//      `createActionRequest` uses to reject typoed kinds.
//   3. Update the `kind` literal union on `CreateActionRequestInput` in
//      action-requests-service.ts so callers see a compile error.
//
// The union members below intentionally re-state the shape used by each
// handler's payload (e.g. `BulkSessionActionPayload`) so this file is
// self-contained — referencing the handler types creates an import cycle
// (action-requests-service ← ask handlers ← action-requests-service).

import type {
	AlertRuleType,
	LaunchMode,
	LaunchSpec,
	SessionMutationKind,
	SessionTemplateInput,
} from "../../../shared/types.js";
import type { ProjectDraftFields } from "../../db/schema.js";

export interface LaunchRequestPayload {
	kind: "launch_request";
	template: SessionTemplateInput;
	launchSpec: LaunchSpec;
	requestedLaunchMode: LaunchMode;
	validatedSupervisorId: string;
	projectId: string | null;
	projectName?: string;
	aiInitiated?: boolean;
	askThreadId?: string;
	desiredDisplayName?: string;
	// Resume metadata. Stamped by the resume handler so the inbox card can
	// distinguish a resume from a fresh launch. Executor ignores these.
	parentSessionId?: string;
	parentSessionName?: string;
}

export interface AddProjectPayload {
	kind: "add_project";
	draftFields: ProjectDraftFields;
	draftId: string;
}

interface SessionRefPayload {
	sessionId: string;
	sessionDisplayName: string | null;
}

export interface SessionStopPayload extends SessionRefPayload {
	kind: "session_stop";
}

export interface SessionArchivePayload extends SessionRefPayload {
	kind: "session_archive";
}

export interface SessionDeletePayload extends SessionRefPayload {
	kind: "session_delete";
}

export interface EditProjectPayload {
	kind: "edit_project";
	projectId: string;
	projectName: string;
	fields: Record<string, unknown>;
}

export interface DeleteProjectPayload {
	kind: "delete_project";
	projectId: string;
	projectName: string;
	affectedTemplates: number;
	affectedSessions: number;
}

export interface EditTemplatePayload {
	kind: "edit_template";
	templateId: string;
	templateName: string;
	fields: Record<string, unknown>;
}

export interface DeleteTemplatePayload {
	kind: "delete_template";
	templateId: string;
	templateName: string;
}

export interface AddChannelPayload {
	kind: "add_channel";
	// Persisted as a free-string so a typo in the Ask handler doesn't
	// silently widen the union; the executor narrows to the validKinds set.
	channelKind: string;
	label: string;
}

export interface CreateAlertRulePayload {
	kind: "create_alert_rule";
	projectId: string;
	projectName: string;
	ruleType: AlertRuleType;
	thresholdMinutes: number | null;
	channelId: string | null;
}

export interface CreateFreeformAlertRulePayload {
	kind: "create_freeform_alert_rule";
	projectId: string;
	projectName: string;
	condition: string;
	dailyTokenBudget: number;
	sampleRate: number;
	eventTypesFilter: string[];
}

export interface BulkSessionActionPayload {
	kind: "bulk_session_action";
	action: SessionMutationKind;
	sessionIds: string[];
	sessionNames: string[];
	exclusions: Array<{ sessionId: string; name: string; reason: string }>;
}

export type ActionRequestPayload =
	| LaunchRequestPayload
	| AddProjectPayload
	| SessionStopPayload
	| SessionArchivePayload
	| SessionDeletePayload
	| EditProjectPayload
	| DeleteProjectPayload
	| EditTemplatePayload
	| DeleteTemplatePayload
	| AddChannelPayload
	| CreateAlertRulePayload
	| CreateFreeformAlertRulePayload
	| BulkSessionActionPayload;

/**
 * Runtime guard. The DB column is plain JSON, and the row's `kind` column
 * is the source of truth — payload writers stamp the `kind` field too,
 * but old rows may predate that, so we accept either: a payload with
 * matching `kind`, or a payload missing `kind` whose row-level kind matches
 * the requested narrowing.
 *
 * Single source: this `as const` tuple drives both the runtime allowlist
 * and the `ActionRequestKind` type derivation. The exhaustiveness check
 * below fails to compile if the tuple drifts from the discriminated union.
 */
export const KNOWN_ACTION_REQUEST_KINDS = [
	"launch_request",
	"add_project",
	"session_stop",
	"session_archive",
	"session_delete",
	"edit_project",
	"delete_project",
	"edit_template",
	"delete_template",
	"add_channel",
	"create_alert_rule",
	"create_freeform_alert_rule",
	"bulk_session_action",
] as const;

export type ActionRequestKind = (typeof KNOWN_ACTION_REQUEST_KINDS)[number];

// Compile-time exhaustiveness: if a new payload kind is added to
// ActionRequestPayload without a matching entry in the tuple above (or
// vice-versa), this type collapses to `never` and the `_check` const
// errors out.
type _MissingActionRequestKind =
	| Exclude<ActionRequestPayload["kind"], ActionRequestKind>
	| Exclude<ActionRequestKind, ActionRequestPayload["kind"]>;
const _checkActionRequestKindCoverage: [_MissingActionRequestKind] extends [never] ? true : never =
	true;
// Reference once so biome/tsc don't flag the const as unused.
void _checkActionRequestKindCoverage;
