/**
 * Runtime schema barrel. Reads config.dialect at module load and selects the
 * appropriate per-dialect barrel.
 *
 * Decision 18: no DRIZZLE_DIALECT env var — two per-dialect entry files, and
 * this runtime barrel selects between them. The config.ts resolver is the
 * single source of truth.
 *
 * Migration complete as of 2026-05-05 (schema-importer-migration campaign).
 * All 64 production importers previously using db/schema.js now import from
 * this barrel directly. The db/schema.ts shim has been removed.
 *
 * TYPE STRATEGY:
 * Each export is cast to the SQLite-typed variant. This preserves the existing
 * TypeScript contracts for all 64 importers (which were written against SQLite
 * types) while the runtime value is correctly dialect-resolved. A follow-up
 * campaign will narrow the type contracts to accept both dialects via generics.
 *
 * CONSUMERS:
 *   - Production code: import from this barrel (db/schema/index.js) or
 *     specific subpaths (db/schema/core/..., db/schema/ai/..., etc.).
 *   - drizzle-kit (SQLite): import from index.sqlite.ts directly.
 *   - drizzle-kit (Postgres): import from index.postgres.ts directly.
 *   - Tests: import from this barrel (dialect-dispatched) or specific sub-files.
 *   - SQLite-only code (FTS, embeddings): import from index.sqlite.ts directly.
 */

import { config } from "../../config.js";
import * as postgresSchema from "./index.postgres.js";
import * as sqliteSchema from "./index.sqlite.js";

const active = config.dialect === "postgres" ? postgresSchema : sqliteSchema;

// ── core/ ─────────────────────────────────────────────────────────────────────
// biome-ignore format: dialect-resolved re-exports keep one line each
export const sessions = active.sessions as typeof sqliteSchema.sessions;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const events = active.events as typeof sqliteSchema.events;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const users = active.users as typeof sqliteSchema.users;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const authSessions = active.authSessions as typeof sqliteSchema.authSessions;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const apiKeys = active.apiKeys as typeof sqliteSchema.apiKeys;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const settings = active.settings as typeof sqliteSchema.settings;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const sessionTemplates = active.sessionTemplates as typeof sqliteSchema.sessionTemplates;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const supervisors = active.supervisors as typeof sqliteSchema.supervisors;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const supervisorEnrollmentTokens =
	active.supervisorEnrollmentTokens as typeof sqliteSchema.supervisorEnrollmentTokens;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const supervisorCredentials =
	active.supervisorCredentials as typeof sqliteSchema.supervisorCredentials;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const launchRequests = active.launchRequests as typeof sqliteSchema.launchRequests;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const managedSessions = active.managedSessions as typeof sqliteSchema.managedSessions;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const controlActions = active.controlActions as typeof sqliteSchema.controlActions;

// ── ai/ ───────────────────────────────────────────────────────────────────────
// biome-ignore format: dialect-resolved re-exports keep one line each
export const llmProviders = active.llmProviders as typeof sqliteSchema.llmProviders;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const watcherConfigs = active.watcherConfigs as typeof sqliteSchema.watcherConfigs;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const aiDailySpend = active.aiDailySpend as typeof sqliteSchema.aiDailySpend;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const watcherProposals = active.watcherProposals as typeof sqliteSchema.watcherProposals;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const aiWatcherRuns = active.aiWatcherRuns as typeof sqliteSchema.aiWatcherRuns;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const aiInboxSnoozes = active.aiInboxSnoozes as typeof sqliteSchema.aiInboxSnoozes;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const notificationChannels =
	active.notificationChannels as typeof sqliteSchema.notificationChannels;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const aiHitlRequests = active.aiHitlRequests as typeof sqliteSchema.aiHitlRequests;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const aiActionRequests = active.aiActionRequests as typeof sqliteSchema.aiActionRequests;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const aiPendingProjectDrafts =
	active.aiPendingProjectDrafts as typeof sqliteSchema.aiPendingProjectDrafts;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const aiQaCache = active.aiQaCache as typeof sqliteSchema.aiQaCache;

// SQLite-only — undefined on the Postgres path (no pgvector this campaign).
// Callers must gate on config.dialect === "sqlite" before accessing this.
export const eventEmbeddings =
	config.dialect === "sqlite" ? sqliteSchema.eventEmbeddings : undefined;

// ── ask-projects/ ─────────────────────────────────────────────────────────────
// biome-ignore format: dialect-resolved re-exports keep one line each
export const askThreads = active.askThreads as typeof sqliteSchema.askThreads;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const askMessages = active.askMessages as typeof sqliteSchema.askMessages;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const projects = active.projects as typeof sqliteSchema.projects;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const projectAlertRules = active.projectAlertRules as typeof sqliteSchema.projectAlertRules;
// biome-ignore format: dialect-resolved re-exports keep one line each
export const projectAlertRuleFires =
	active.projectAlertRuleFires as typeof sqliteSchema.projectAlertRuleFires;

// ── types (dialect-agnostic) ──────────────────────────────────────────────────
export type {
	ProjectDraftFields,
	NextQuestion,
	ProjectChoiceSnapshot,
	PendingWorkspaceScaffold,
	PendingWorkspaceClone,
	LaunchDisambiguationDraftFields,
} from "./types.js";

// Per-dialect typed variants (for drizzle-kit / explicit type imports).
export { settingsSqlite, settingsPg } from "./core/settings.js";
