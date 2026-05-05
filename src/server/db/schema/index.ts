/**
 * Runtime schema barrel. Reads config.dialect at module load and selects the
 * appropriate per-dialect barrel.
 *
 * Decision 18: no DRIZZLE_DIALECT env var — two per-dialect entry files, and
 * this runtime barrel selects between them. The config.ts resolver is the
 * single source of truth.
 *
 * Phase 1: only settings is dual-dialect. All other tables come through from
 * the legacy schema.ts (SQLite-typed). Phase 2a migrates the remaining tables.
 *
 * Phase 2b wires this barrel into client.ts so it becomes the single import
 * point for all schema tables. Until then, production code continues to
 * import from schema.ts directly.
 *
 * CONSUMERS: import from this barrel only when you need the runtime-resolved
 * schema (e.g. application code that should work on both dialects). For tests
 * and drizzle-kit, import from index.sqlite.ts or index.postgres.ts directly.
 */
import { config } from "../../config.js";
import { settingsPg, settingsSqlite } from "./core/settings.js";

// All tables except settings come from the legacy schema.ts (unchanged in Phase 1).
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

export type {
	ProjectDraftFields,
	NextQuestion,
	ProjectChoiceSnapshot,
	PendingWorkspaceScaffold,
	PendingWorkspaceClone,
	LaunchDisambiguationDraftFields,
} from "../schema.js";

// Also re-export the typed variants for drizzle-kit and tests.
export { settingsPg, settingsSqlite };

// Dialect-resolved settings table. This is the export callers should use when
// they want the correct type for the current dialect.
export const settings = config.dialect === "postgres" ? settingsPg : settingsSqlite;
