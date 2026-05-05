# pgvector event embeddings — follow-up campaign stub

The current Postgres backend campaign (2026-05-05-deliver-postgres-backend) gates all embedding
functionality to `config.dialect === "sqlite"` to avoid blocking the core Postgres port. The raw
`bun:sqlite` calls in `embedding-service.ts` and `vector-enricher.ts` are intentionally left in
place behind that dialect guard; a follow-up campaign should replace them with a pgvector-backed
implementation using `drizzle-orm/pg-core`'s vector extension support and the `vector` column
type, migrating the `event_embeddings` table schema accordingly, and updating the cosine
similarity scan in `VectorEmbeddingEnricher.enrich()` to use an approximate-nearest-neighbour
index (`ivfflat` or `hnsw`) via `<=>` operator queries so that the brute-force scan over all rows
does not become a bottleneck as the events table grows past ~10K rows on Postgres deployments.
