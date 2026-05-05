/**
 * drizzle-kit SQLite schema entry point.
 *
 * This file is only used by drizzle.config.sqlite.ts for migration generation.
 * It re-exports all SQLite table definitions using direct TypeScript paths (no
 * .js extension aliases) so that drizzle-kit's CJS bundler can resolve them.
 *
 * Do NOT import this file from runtime code — use src/server/db/schema/index.ts
 * (or the specific barrel files) instead.
 */

// core/
export { sessionsSqlite as sessions } from "../src/server/db/schema/core/sessions";
export { eventsSqlite as events } from "../src/server/db/schema/core/events";
export { usersSqlite as users } from "../src/server/db/schema/core/users";
export { authSessionsSqlite as authSessions } from "../src/server/db/schema/core/auth-sessions";
export { apiKeysSqlite as apiKeys } from "../src/server/db/schema/core/api-keys";
export { settingsSqlite as settings } from "../src/server/db/schema/core/settings";
export { sessionTemplatesSqlite as sessionTemplates } from "../src/server/db/schema/core/session-templates";
export { supervisorsSqlite as supervisors } from "../src/server/db/schema/core/supervisors";
export { supervisorEnrollmentTokensSqlite as supervisorEnrollmentTokens } from "../src/server/db/schema/core/supervisor-enrollment-tokens";
export { supervisorCredentialsSqlite as supervisorCredentials } from "../src/server/db/schema/core/supervisor-credentials";
export { launchRequestsSqlite as launchRequests } from "../src/server/db/schema/core/launch-requests";
export { managedSessionsSqlite as managedSessions } from "../src/server/db/schema/core/managed-sessions";
export { controlActionsSqlite as controlActions } from "../src/server/db/schema/core/control-actions";

// ai/
export { llmProvidersSqlite as llmProviders } from "../src/server/db/schema/ai/llm-providers";
export { watcherConfigsSqlite as watcherConfigs } from "../src/server/db/schema/ai/watcher-configs";
export { aiDailySpendSqlite as aiDailySpend } from "../src/server/db/schema/ai/ai-daily-spend";
export { watcherProposalsSqlite as watcherProposals } from "../src/server/db/schema/ai/watcher-proposals";
export { aiWatcherRunsSqlite as aiWatcherRuns } from "../src/server/db/schema/ai/ai-watcher-runs";
export { aiInboxSnoozesSqlite as aiInboxSnoozes } from "../src/server/db/schema/ai/ai-inbox-snoozes";
export { notificationChannelsSqlite as notificationChannels } from "../src/server/db/schema/ai/notification-channels";
export { aiHitlRequestsSqlite as aiHitlRequests } from "../src/server/db/schema/ai/ai-hitl-requests";
export { aiActionRequestsSqlite as aiActionRequests } from "../src/server/db/schema/ai/ai-action-requests";
export { aiPendingProjectDraftsSqlite as aiPendingProjectDrafts } from "../src/server/db/schema/ai/ai-pending-project-drafts";
export { aiQaCacheSqlite as aiQaCache } from "../src/server/db/schema/ai/ai-qa-cache";
// eventEmbeddings is SQLite-only (Decision 3 / no pgTable equivalent).
export { eventEmbeddingsSqlite as eventEmbeddings } from "../src/server/db/schema/ai/event-embeddings";

// ask-projects/
export { askThreadsSqlite as askThreads } from "../src/server/db/schema/ask-projects/ask-threads";
export { askMessagesSqlite as askMessages } from "../src/server/db/schema/ask-projects/ask-messages";
export { projectsSqlite as projects } from "../src/server/db/schema/ask-projects/projects";
export { projectAlertRulesSqlite as projectAlertRules } from "../src/server/db/schema/ask-projects/project-alert-rules";
export { projectAlertRuleFiresSqlite as projectAlertRuleFires } from "../src/server/db/schema/ask-projects/project-alert-rule-fires";
