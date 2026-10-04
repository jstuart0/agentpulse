/**
 * event_embeddings table — SQLite-ONLY (Decision 3 / Phase 2a brief).
 *
 * No pgTable export. The Postgres entry file does NOT re-export this symbol.
 * The runtime barrel re-exports eventEmbeddings as undefined on the Postgres
 * path. Phase 3 gates callers on config.dialect === "sqlite" &&
 * config.vectorSearchEnabled.
 */
import { sql } from "drizzle-orm";
import { blob, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const eventEmbeddingsSqlite = sqliteTable(
	"event_embeddings",
	{
		eventId: integer("event_id").primaryKey(),
		model: text("model").notNull(),
		dim: integer("dim").notNull(),
		vector: blob("vector", { mode: "buffer" }).notNull(),
		createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	},
	(t) => [
		// Serves the Ask scan's keyset read (services/ai/embeddings/vector-scan.ts):
		// seek (model, dim), walk event_id downwards, so rows examined equal
		// rows returned however many vectors of other models or dimensions sit
		// in between. The scan names it with INDEXED BY.
		index("idx_event_embeddings_model_dim_event").on(t.model, t.dim, t.eventId),
	],
);

// No eventEmbeddingsPg — pgvector is a Postgres-better follow-up, not in scope.
