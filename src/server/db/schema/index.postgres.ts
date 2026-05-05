/**
 * Postgres schema barrel. Re-exports every table in its Postgres form.
 *
 * drizzle-kit Postgres config will point here unconditionally (Decision 18).
 * The runtime barrel (index.ts) selects this file when config.dialect === "postgres".
 *
 * Phase 1: only settings has a Postgres-typed definition; the remaining tables
 * from schema.ts are SQLite-typed. Phase 2a replaces them with pg-typed variants.
 * Until Phase 2a completes, the Postgres path will surface type mismatches in
 * any code that tries to use those tables against a Postgres connection — this
 * is expected and detected by the boot-failure registry in client.ts.
 *
 * The `settings` re-export below overrides the one from schema.ts.
 */
export type {
	ProjectDraftFields,
	NextQuestion,
	ProjectChoiceSnapshot,
	PendingWorkspaceScaffold,
	PendingWorkspaceClone,
	LaunchDisambiguationDraftFields,
} from "../schema.js";

export {
	sessions,
	events,
	users,
	authSessions,
	apiKeys,
	sessionTemplates,
	supervisors,
	supervisorEnrollmentTokens,
	supervisorCredentials,
	launchRequests,
	managedSessions,
	controlActions,
	llmProviders,
	watcherConfigs,
	eventEmbeddings,
	aiDailySpend,
	watcherProposals,
	aiWatcherRuns,
	notificationChannels,
	aiInboxSnoozes,
	projects,
	askThreads,
	askMessages,
	aiActionRequests,
	aiHitlRequests,
	projectAlertRules,
	projectAlertRuleFires,
	aiQaCache,
	aiPendingProjectDrafts,
} from "../schema.js";

// Postgres-typed settings (json() value column instead of text({mode:'json'})).
export { settingsPg as settings } from "./core/settings.js";
