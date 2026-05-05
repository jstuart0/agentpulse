/**
 * Single source of truth for the resolved dialect. Thin re-export of
 * config.dialect so schema files and client.ts can import a named symbol
 * without pulling in the full config object at module-load time.
 *
 * Decision 27: config.ts is the authoritative resolver; this file only
 * re-exports. Do not add resolution logic here.
 */
import { config } from "../config.js";

export type Dialect = "sqlite" | "postgres";

export const dialect: Dialect = config.dialect;
