/**
 * drizzle-kit Postgres schema entry point.
 *
 * This file is only used by drizzle.config.postgres.ts for migration generation.
 * It re-exports all Postgres table definitions using direct TypeScript paths (no
 * .js extension aliases) so that drizzle-kit's CJS bundler can resolve them.
 *
 * Do NOT import this file from runtime code — use src/server/db/schema/index.ts
 * (or the specific barrel files) instead.
 *
 * eventEmbeddings is intentionally omitted — SQLite-only (Decision 3).
 */

// core/
export { sessionsPg as sessions } from "../src/server/db/schema/core/sessions";
export { eventsPg as events } from "../src/server/db/schema/core/events";
export { usersPg as users } from "../src/server/db/schema/core/users";
export { authSessionsPg as authSessions } from "../src/server/db/schema/core/auth-sessions";
export { apiKeysPg as apiKeys } from "../src/server/db/schema/core/api-keys";
export { settingsPg as settings } from "../src/server/db/schema/core/settings";
export { sessionTemplatesPg as sessionTemplates } from "../src/server/db/schema/core/session-templates";
export { supervisorsPg as supervisors } from "../src/server/db/schema/core/supervisors";
export { supervisorEnrollmentTokensPg as supervisorEnrollmentTokens } from "../src/server/db/schema/core/supervisor-enrollment-tokens";
export { supervisorCredentialsPg as supervisorCredentials } from "../src/server/db/schema/core/supervisor-credentials";
export { launchRequestsPg as launchRequests } from "../src/server/db/schema/core/launch-requests";
export { managedSessionsPg as managedSessions } from "../src/server/db/schema/core/managed-sessions";
export { controlActionsPg as controlActions } from "../src/server/db/schema/core/control-actions";

// ai/
export { llmProvidersPg as llmProviders } from "../src/server/db/schema/ai/llm-providers";
export { watcherConfigsPg as watcherConfigs } from "../src/server/db/schema/ai/watcher-configs";
export { aiDailySpendPg as aiDailySpend } from "../src/server/db/schema/ai/ai-daily-spend";
export { watcherProposalsPg as watcherProposals } from "../src/server/db/schema/ai/watcher-proposals";
export { aiWatcherRunsPg as aiWatcherRuns } from "../src/server/db/schema/ai/ai-watcher-runs";
export { aiInboxSnoozesPg as aiInboxSnoozes } from "../src/server/db/schema/ai/ai-inbox-snoozes";
export { notificationChannelsPg as notificationChannels } from "../src/server/db/schema/ai/notification-channels";
export { aiHitlRequestsPg as aiHitlRequests } from "../src/server/db/schema/ai/ai-hitl-requests";
export { aiActionRequestsPg as aiActionRequests } from "../src/server/db/schema/ai/ai-action-requests";
export { aiPendingProjectDraftsPg as aiPendingProjectDrafts } from "../src/server/db/schema/ai/ai-pending-project-drafts";
export { aiQaCachePg as aiQaCache } from "../src/server/db/schema/ai/ai-qa-cache";
// eventEmbeddings intentionally omitted — SQLite-only (Decision 3).

// ask-projects/
export { askThreadsPg as askThreads } from "../src/server/db/schema/ask-projects/ask-threads";
export { askMessagesPg as askMessages } from "../src/server/db/schema/ask-projects/ask-messages";
export { projectsPg as projects } from "../src/server/db/schema/ask-projects/projects";
export { projectAlertRulesPg as projectAlertRules } from "../src/server/db/schema/ask-projects/project-alert-rules";
export { projectAlertRuleFiresPg as projectAlertRuleFires } from "../src/server/db/schema/ask-projects/project-alert-rule-fires";
