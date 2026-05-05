/**
 * Postgres schema barrel. Re-exports every table in its Postgres form.
 *
 * drizzle-kit Postgres config will point here unconditionally (Decision 18).
 * The runtime barrel (index.ts) selects this file when config.dialect === "postgres".
 *
 * Phase 2a: all 29 tables exported (eventEmbeddings is SQLite-only — Decision 3).
 * eventEmbeddings is NOT re-exported here; callers on the Postgres path must
 * gate on config.dialect === "sqlite" before accessing it.
 */

// ── types (dialect-agnostic orphan interfaces) ───────────────────────────────
export type {
	ProjectDraftFields,
	NextQuestion,
	ProjectChoiceSnapshot,
	PendingWorkspaceScaffold,
	PendingWorkspaceClone,
	LaunchDisambiguationDraftFields,
} from "./types.js";

// ── core/ ─────────────────────────────────────────────────────────────────────
export { sessionsPg as sessions } from "./core/sessions.js";
export { eventsPg as events } from "./core/events.js";
export { usersPg as users } from "./core/users.js";
export { authSessionsPg as authSessions } from "./core/auth-sessions.js";
export { apiKeysPg as apiKeys } from "./core/api-keys.js";
export { settingsPg as settings } from "./core/settings.js";
export { sessionTemplatesPg as sessionTemplates } from "./core/session-templates.js";
export { supervisorsPg as supervisors } from "./core/supervisors.js";
export { supervisorEnrollmentTokensPg as supervisorEnrollmentTokens } from "./core/supervisor-enrollment-tokens.js";
export { supervisorCredentialsPg as supervisorCredentials } from "./core/supervisor-credentials.js";
export { launchRequestsPg as launchRequests } from "./core/launch-requests.js";
export { managedSessionsPg as managedSessions } from "./core/managed-sessions.js";
export { controlActionsPg as controlActions } from "./core/control-actions.js";

// ── ai/ ───────────────────────────────────────────────────────────────────────
export { llmProvidersPg as llmProviders } from "./ai/llm-providers.js";
export { watcherConfigsPg as watcherConfigs } from "./ai/watcher-configs.js";
export { aiDailySpendPg as aiDailySpend } from "./ai/ai-daily-spend.js";
export { watcherProposalsPg as watcherProposals } from "./ai/watcher-proposals.js";
export { aiWatcherRunsPg as aiWatcherRuns } from "./ai/ai-watcher-runs.js";
export { aiInboxSnoozesPg as aiInboxSnoozes } from "./ai/ai-inbox-snoozes.js";
export { notificationChannelsPg as notificationChannels } from "./ai/notification-channels.js";
export { aiHitlRequestsPg as aiHitlRequests } from "./ai/ai-hitl-requests.js";
export { aiActionRequestsPg as aiActionRequests } from "./ai/ai-action-requests.js";
export { aiPendingProjectDraftsPg as aiPendingProjectDrafts } from "./ai/ai-pending-project-drafts.js";
export { aiQaCachePg as aiQaCache } from "./ai/ai-qa-cache.js";
// eventEmbeddings intentionally omitted — SQLite-only (Decision 3).

// ── ask-projects/ ─────────────────────────────────────────────────────────────
export { askThreadsPg as askThreads } from "./ask-projects/ask-threads.js";
export { askMessagesPg as askMessages } from "./ask-projects/ask-messages.js";
export { projectsPg as projects } from "./ask-projects/projects.js";
export { projectAlertRulesPg as projectAlertRules } from "./ask-projects/project-alert-rules.js";
export { projectAlertRuleFiresPg as projectAlertRuleFires } from "./ask-projects/project-alert-rule-fires.js";

// Also export typed variant so drizzle-kit and tests can import directly.
export { settingsPg } from "./core/settings.js";
