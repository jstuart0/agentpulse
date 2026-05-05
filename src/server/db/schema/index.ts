/**
 * Runtime schema barrel. Reads config.dialect at module load and selects the
 * appropriate per-dialect barrel.
 *
 * Decision 18: no DRIZZLE_DIALECT env var — two per-dialect entry files, and
 * this runtime barrel selects between them. The config.ts resolver is the
 * single source of truth.
 *
 * Phase 2a: all 30 tables are now dual-dialect. The per-dialect entry files
 * (index.sqlite.ts, index.postgres.ts) export dialect-specific types for
 * drizzle-kit. This runtime barrel re-exports SQLite-typed symbols so the
 * ~60 existing importers see no type change. Phase 2b wires the actual
 * runtime dialect selection into client.ts and migrates the importers to
 * dialect-aware types.
 *
 * CONSUMERS:
 *   - Production code: import from this barrel or "../db/schema" (shim).
 *     SQLite-typed until Phase 2b migrates them.
 *   - drizzle-kit (SQLite): import from index.sqlite.ts directly.
 *   - drizzle-kit (Postgres): import from index.postgres.ts directly.
 *   - Tests: import from index.sqlite.ts (or index.postgres.ts for Postgres axis).
 *
 * TODO(Phase 2b — ian mid-build H1 tracking): 12 production files still import
 * `settings` from `../schema.js`. Phase 2b migrates each to `from
 * "../db/schema/index.js"` once client.ts is updated to support Postgres:
 *   - src/server/routes/auth.ts
 *   - src/server/routes/settings.ts
 *   - src/server/routes/ai-watcher.ts
 *   - src/server/services/local-auth-bootstrap.ts
 *   - src/server/services/labs-service.ts
 *   - src/server/services/settings-service.ts
 *   - src/server/services/telemetry.ts
 *   - src/server/services/channels/telegram-credentials.ts
 *   - src/server/services/workspace/feature.ts
 *   - src/server/services/ai/risk-classes.ts
 *   - src/server/services/ai/feature.ts
 *   - src/server/services/ai/embeddings/embedding-service.ts
 */

// Re-export all SQLite-typed symbols from the SQLite entry file. This maintains
// the exact type contract existing importers depend on through Phase 2b.
// The `settings` export from index.sqlite.ts uses the Phase 1 settingsSqlite
// definition and is the dialect-resolved export for the SQLite path.
export * from "./index.sqlite.js";

// Also export the Postgres-typed variant for drizzle-kit / tests.
// Does NOT override the `settings` export above — index.sqlite.ts wins.
export { settingsPg } from "./core/settings.js";
