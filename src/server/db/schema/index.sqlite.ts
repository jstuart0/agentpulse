/**
 * SQLite schema barrel. Re-exports every table in its SQLite form.
 *
 * drizzle-kit SQLite config points here unconditionally (Decision 18).
 * The runtime barrel (index.ts) selects this file when config.dialect === "sqlite".
 *
 * Phase 1: settings is the only dual-dialect table; all others come from the
 * legacy schema.ts. Phase 2a migrates the remaining tables.
 *
 * The `settings` re-export below overrides the one from schema.ts because an
 * explicit named export takes precedence over export-star in the same module.
 */
// All tables and types from schema.ts except settings.
// schema.ts's settings is SQLite-typed anyway but we provide the explicit
// typed variant from core/settings.ts for consistency.
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

// Dialect-typed settings — overrides the export from schema.ts above.
export { settingsSqlite as settings } from "./core/settings.js";
