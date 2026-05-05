/**
 * @deprecated import from "./schema/index.js" or specific files in "./schema/<group>/"
 *
 * This shim re-exports everything from the new schema directory introduced in
 * Phase 2a. All existing importers continue to resolve through this path.
 * Phase 8 removes this shim once all importers have migrated.
 *
 * Maintained for one-release backwards compat (Decision 22 / dexter L-2 exit criterion).
 */

// Runtime-resolved tables (dialect selected by config.dialect at module load).
export {
	sessions,
	events,
	users,
	authSessions,
	apiKeys,
	settings,
	sessionTemplates,
	supervisors,
	supervisorEnrollmentTokens,
	supervisorCredentials,
	launchRequests,
	managedSessions,
	controlActions,
	llmProviders,
	watcherConfigs,
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
	// SQLite-only; undefined on Postgres path — Phase 3 gates callers.
	eventEmbeddings,
} from "./schema/index.js";

// Orphan interface types moved to schema/types.ts (Decision 29 / librarian Item 3).
export type {
	ProjectDraftFields,
	NextQuestion,
	ProjectChoiceSnapshot,
	PendingWorkspaceScaffold,
	PendingWorkspaceClone,
	LaunchDisambiguationDraftFields,
} from "./schema/types.js";

// Per-dialect typed variants (for any code that imported these explicitly).
export { settingsSqlite, settingsPg } from "./schema/core/settings.js";
