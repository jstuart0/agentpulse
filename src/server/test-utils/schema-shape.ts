/**
 * The structural shape of a SQLite database (tables, columns, indexes, triggers), and a one-way diff of two
 * shapes. Compared by structure, not name: a legacy inline UNIQUE and a Drizzle `_unique` index are the same
 * thing. Used by the legacy-init parity test and the migration ledger boot tests as the oracle for "the
 * booted schema has everything a Drizzle-born one has". Deliberately shares no code with the ledger module.
 * Not a test file.
 */
import type { Database } from "bun:sqlite";

/** Drizzle's own bookkeeping (the legacy path writes the ledger too since AGEN-67, but its rows are checked elsewhere). */
const NOT_ON_LEGACY = new Set(["__drizzle_migrations"]);

export interface Shape {
	tables: Set<string>;
	columns: Set<string>;
	indexes: Set<string>;
	triggers: Set<string>;
}

type Row = Record<string, string | number | null>;

/**
 * Tables whose columns are compared in full (NOT NULL, default, foreign key and its delete rule), not
 * just by name and type. The older tables differ on purpose and harmlessly (a legacy `id TEXT PRIMARY
 * KEY` is nullable, `events.session_id` is rebuilt with its cascade only after boot), so a blanket
 * comparison would only report those. A table born in a migration with its constraints must match.
 */
const FULLY_COMPARED = new Set(["codex_approvals", "codex_approval_audit"]);

/** SQLite reads `false` and `true` as 0 and 1, so a default spelled either way is the same default. */
function normalizeDefault(value: unknown): string {
	const text = normalizeSql(String(value));
	return text === "false" ? "0" : text === "true" ? "1" : text;
}

/** A trigger's SQL with the spelling differences that don't change what it does taken out. */
function normalizeSql(text: string): string {
	return text
		.replace(/[`"]/g, "")
		.replace(/\bif not exists\b/gi, "")
		.replace(/\s+/g, " ")
		.replace(/\s*([(),;=<>])\s*/g, "$1")
		.trim()
		.toLowerCase();
}

export function shapeOf(db: Database): Shape {
	const shape: Shape = {
		tables: new Set(),
		columns: new Set(),
		indexes: new Set<string>(),
		triggers: new Set<string>(),
	};
	const objects = db
		.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
		.all() as Row[];
	for (const o of objects) {
		const name = String(o.name);
		if (o.type === "trigger") {
			// By name and by what it does: a trigger whose body drifted is a different trigger.
			shape.triggers.add(name);
			shape.triggers.add(`${name}: ${normalizeSql(String(o.sql))}`);
		}
		if (o.type !== "table" || NOT_ON_LEGACY.has(name) || name.includes("_fts")) continue;
		shape.tables.add(name);
		for (const c of db.prepare(`PRAGMA table_info('${name}')`).all() as Row[]) {
			shape.columns.add(`${name}.${c.name} ${String(c.type).toUpperCase()}`);
			// NOT NULL and the default decide what an insert may omit and what a row reads back as.
			if (FULLY_COMPARED.has(name)) {
				shape.columns.add(
					`${name}.${c.name} notnull=${c.notnull} default=${normalizeDefault(c.dflt_value)}`,
				);
			}
		}
		for (const f of FULLY_COMPARED.has(name)
			? (db.prepare(`PRAGMA foreign_key_list('${name}')`).all() as Row[])
			: []) {
			shape.columns.add(
				`${name}.${f.from} -> ${f.table}.${f.to} on_delete=${f.on_delete} on_update=${f.on_update}`,
			);
		}
		for (const i of db.prepare(`PRAGMA index_list('${name}')`).all() as Row[]) {
			if (i.origin === "pk") continue;
			const cols = (db.prepare(`PRAGMA index_info('${i.name}')`).all() as Row[]).map((c) => c.name);
			shape.indexes.add(`${name}(${cols.join(",")}) unique=${i.unique} partial=${i.partial}`);
		}
	}
	return shape;
}

export function missingFrom(legacy: Shape, born: Shape): string[] {
	const out: string[] = [];
	for (const kind of ["tables", "columns", "indexes", "triggers"] as const) {
		for (const item of born[kind]) if (!legacy[kind].has(item)) out.push(`${kind}: ${item}`);
	}
	return out.sort();
}
