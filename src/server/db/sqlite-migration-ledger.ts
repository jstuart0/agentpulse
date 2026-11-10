import { Database } from "bun:sqlite";
/**
 * SQLite migration ledger reconcile (AGEN-67).
 *
 * Drizzle's migrator reads only the largest `created_at` in `__drizzle_migrations` and runs every journal
 * entry after it. A database the legacy init built (or topped up) has the objects but no ledger, so a
 * forced Drizzle run replays migrations and fails with "already exists" or "duplicate column". This module
 * writes the ledger rows the schema already justifies, and only those.
 *
 * What counts as "justified" is structural equivalence, not presence. Each journal entry's effects come
 * from replaying the shipped SQL, through drizzle's own reader and statement splitting, into `:memory:`
 * with a snapshot after every entry. A snapshot is a set of keys (table, column, foreign key, index by
 * structure, trigger by its SQL) with a value each. A live database verifies an entry when every key that
 * entry touched is present with a value equivalent to one the replay gives it from that entry on. The
 * ledger is only ever extended by the longest verified prefix: drizzle can't record a gap, and one wrong
 * row silently suppresses everything before it.
 *
 * Invariant (client.ts): every existing-install boot that reaches `migrate()` reconciles first, in
 * "forced" mode, which throws a MigrationLedgerError instead of letting `migrate()` run into a gap. The
 * legacy init path reconciles too, in "legacy" mode, and never fails boot because of it.
 *
 * Hand-written notes for migration authors:
 *  - The comparison is by structure, so a later migration that does `DROP INDEX <drizzle name>` fails on a
 *    database the legacy path built (it names its indexes differently). Handle both names.
 *  - A migration needs a legacy counterpart in client.ts, or legacy-init-parity and U1/B8 fail.
 *  - A data statement (UPDATE/INSERT/DELETE outside a table rebuild or a trigger body) needs an entry in
 *    LEGACY_EQUIVALENTS naming the legacy code that does the same, or the entry is never verified.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { SESSION_CHILD_FK_TARGETS } from "./session-child-fks.js";

/** The release that first reconciles the ledger. Named in the fail-closed messages and the CHANGELOG. */
export const LEDGER_SINCE_VERSION = "0.11.0";

const LEDGER_TABLE = "__drizzle_migrations";
/** Drizzle's own DDL for its ledger (sqlite-core/dialect.js), so a table we create is the one it would. */
const LEDGER_DDL = `CREATE TABLE IF NOT EXISTS "${LEDGER_TABLE}" (
	id SERIAL PRIMARY KEY,
	hash text NOT NULL,
	created_at numeric
)`;

const UPGRADE_HINT = `Boot once on AgentPulse ${LEDGER_SINCE_VERSION} or later with AGENTPULSE_LEGACY_INIT unset (that creates what is missing and records the ledger), or restore the backup. See "Moving an existing SQLite install to Drizzle migrate" in deploy/k8s/README.md.`;

export class MigrationLedgerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}
/** A migration after the verified prefix is partly present, so `migrate()` would replay into it. */
export class MigrationLedgerGapError extends MigrationLedgerError {}
/** The ledger claims more than the schema shows. */
export class MigrationLedgerAheadError extends MigrationLedgerError {}
/** The ledger table isn't the shape drizzle writes. */
export class MigrationLedgerMalformedError extends MigrationLedgerError {}

export type LedgerMode = "legacy" | "forced";

export interface LedgerProblem {
	kind: "gap" | "ahead" | "malformed";
	message: string;
}

export interface LedgerReport {
	mode: LedgerMode;
	/** Tag of the last entry of the verified prefix, or null when not even the first is verified. */
	verifiedThrough: string | null;
	firstUnverified?: { tag: string; keys: string[] };
	/** Tags written to the ledger by this call. */
	recorded: string[];
	/** Tag of the newest journal entry the ledger covered before this call. */
	ledgerThrough: string | null;
	/** Ledger rows past the journal's tail (written by a newer binary). */
	newerRows: number;
	/** True when the ledger already sat at the tail and nothing was replayed or introspected. */
	fastPath: boolean;
	/** Ids of the LEGACY_EXCEPTIONS that matched a real difference during this call. */
	exceptionsUsed: string[];
	/** Set when a fail-closed condition was found. Forced mode throws it; legacy mode reports it. */
	problem?: LedgerProblem;
	durationMs: number;
}

// ── Snapshots ────────────────────────────────────────────────────────────────

interface Cell {
	value: string;
	/** The table the key belongs to, so a table rebuild can claim all of it. */
	table: string;
}
type Snapshot = Map<string, Cell>;

/** Counters a test reads to show the memo and the fast path really skip work. */
export const ledgerStats = { replays: 0, liveIntrospections: 0 };

/**
 * A SQL fragment with the spelling differences that don't change what it does taken out: identifier
 * quoting, case, white space, IF NOT EXISTS. String literals are values and are kept exactly.
 */
function normalizeSql(text: string): string {
	return text
		.split(/('(?:[^']|'')*')/)
		.map((part, i) =>
			i % 2 === 1
				? part
				: part
						.replace(/[`"]/g, "")
						.replace(/\bif not exists\b/gi, "")
						.replace(/\s+/g, " ")
						.replace(/\s*([(),;=<>])\s*/g, "$1")
						.toLowerCase(),
		)
		.join("")
		.trim();
}

/** The text between the parentheses opening at `open`, honouring quotes, and the index after the closing one. */
function balanced(sql: string, open: number): { body: string; end: number } | null {
	let depth = 0;
	for (let i = open; i < sql.length; i++) {
		const ch = sql[i] as string;
		if (ch === "'" || ch === '"' || ch === "`") {
			let j = i + 1;
			while (j < sql.length) {
				if (sql[j] === ch) {
					if (sql[j + 1] === ch) {
						j += 2;
						continue;
					}
					break;
				}
				j++;
			}
			i = j;
		} else if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) return { body: sql.slice(open + 1, i), end: i + 1 };
		}
	}
	return null;
}

/** Every CHECK expression of a CREATE TABLE statement (column and table level), normalized. */
function checkExpressions(sql: string): string[] {
	const out: string[] = [];
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i] as string;
		if (ch === "'" || ch === '"' || ch === "`") {
			const lit = balancedQuote(sql, i);
			i = lit;
			continue;
		}
		const word = /^\w+/.exec(sql.slice(i));
		if (word && (i === 0 || !/\w/.test(sql[i - 1] as string))) {
			if (word[0].toLowerCase() === "check") {
				const open = /^\s*\(/.exec(sql.slice(i + 5));
				if (open) {
					const group = balanced(sql, i + 5 + open[0].length - 1);
					if (group) {
						out.push(normalizeSql(group.body));
						i = group.end;
						continue;
					}
				}
			}
			i += word[0].length;
			continue;
		}
		i++;
	}
	return out;
}

function balancedQuote(sql: string, start: number): number {
	const q = sql[start] as string;
	let j = start + 1;
	while (j < sql.length) {
		if (sql[j] === q) {
			if (sql[j + 1] === q) {
				j += 2;
				continue;
			}
			break;
		}
		j++;
	}
	return j + 1;
}

function stripOuterParens(text: string): string {
	let t = text;
	while (t.startsWith("(") && t.endsWith(")")) {
		let depth = 0;
		let closesAtEnd = true;
		for (let i = 0; i < t.length; i++) {
			if (t[i] === "(") depth++;
			else if (t[i] === ")") {
				depth--;
				if (depth === 0 && i < t.length - 1) {
					closesAtEnd = false;
					break;
				}
			}
		}
		if (!closesAtEnd) break;
		t = t.slice(1, -1);
	}
	return t;
}

/** SQLite reads `false` and `true` as 0 and 1, so a default spelled either way is the same default. */
function normalizeDefault(raw: unknown): string {
	if (raw === null || raw === undefined) return "";
	const text = stripOuterParens(normalizeSql(String(raw)));
	return text === "false" ? "0" : text === "true" ? "1" : text;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** An index's own WHERE, with the table qualifier the legacy spelling adds taken out. */
function normalizeWhere(condition: string, table: string): string {
	const unqualified = condition
		.replace(/[`"]/g, "")
		.replace(new RegExp(`\\b${escapeRegExp(table)}\\.`, "gi"), "");
	return stripOuterParens(normalizeSql(unqualified).replace(/;$/, ""));
}

function indexWhere(sql: string | null, table: string): string {
	if (!sql) return "";
	const open = sql.indexOf("(");
	if (open < 0) return "";
	let depth = 0;
	let close = -1;
	for (let i = open; i < sql.length; i++) {
		if (sql[i] === "(") depth++;
		else if (sql[i] === ")") {
			depth--;
			if (depth === 0) {
				close = i;
				break;
			}
		}
	}
	if (close < 0) return "";
	const match = /^\s*where\s+([\s\S]*)$/i.exec(sql.slice(close + 1));
	return match ? normalizeWhere(match[1] ?? "", table) : "";
}

type Row = Record<string, string | number | null>;

function columnValue(c: Row, pkCount: number): string {
	const type = String(c.type ?? "")
		.toUpperCase()
		.replace(/\s+/g, " ")
		.trim();
	const pk = Number(c.pk);
	// An INTEGER PRIMARY KEY is the rowid and can't hold NULL whichever way it was spelled.
	const notnull = pk === 1 && pkCount === 1 && type === "INTEGER" ? 1 : Number(c.notnull);
	return `${type}|nn=${notnull}|dflt=${normalizeDefault(c.dflt_value)}|pk=${pk}|pkn=${pkCount}`;
}

/** Every table, column, foreign key, index (by structure) and trigger of a database, as comparable keys. */
function introspect(db: Database): Snapshot {
	const snap: Snapshot = new Map();
	const objects = db
		.prepare(
			"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','trigger')",
		)
		.all() as Row[];
	const virtuals = objects
		.filter((o) => o.type === "table" && /^\s*create\s+virtual/i.test(String(o.sql ?? "")))
		.map((o) => String(o.name));
	for (const o of objects) {
		const name = String(o.name);
		if (o.type === "trigger") {
			snap.set(`trigger:${normalizeSql(String(o.sql))}`, { value: "1", table: String(o.tbl_name) });
			continue;
		}
		if (virtuals.includes(name) || virtuals.some((v) => name.startsWith(`${v}_`))) continue;
		snap.set(`table:${name}`, { value: "1", table: name });
		const cols = db.prepare(`PRAGMA table_xinfo('${name}')`).all() as Row[];
		const pkCount = cols.filter((c) => Number(c.pk) > 0).length;
		for (const c of cols) {
			snap.set(`column:${name}.${c.name}`, { value: columnValue(c, pkCount), table: name });
		}
		const tableSql = String(o.sql ?? "");
		// A generated column's expression isn't in any PRAGMA: such a table is compared by its whole
		// statement, so a spelling difference fails closed (unverified) rather than passing unchecked.
		if (cols.some((c) => Number(c.hidden) >= 2)) {
			snap.set(`tablesql:${name}`, { value: normalizeSql(tableSql), table: name });
		}
		for (const expression of checkExpressions(tableSql)) {
			snap.set(`check:${name} ${expression}`, { value: "1", table: name });
		}
		const closing = tableSql.lastIndexOf(")");
		const options = normalizeSql(closing >= 0 ? tableSql.slice(closing + 1) : "");
		for (const option of ["strict", "without rowid"]) {
			if (options.includes(option))
				snap.set(`tableopt:${name} ${option}`, { value: "1", table: name });
		}
		// A foreign key is one constraint however many columns it names, so it is keyed by the whole group.
		const fkGroups = new Map<number, Row[]>();
		for (const f of db.prepare(`PRAGMA foreign_key_list('${name}')`).all() as Row[]) {
			const group = fkGroups.get(Number(f.id)) ?? [];
			group.push(f);
			fkGroups.set(Number(f.id), group);
		}
		for (const group of fkGroups.values()) {
			group.sort((x, y) => Number(x.seq) - Number(y.seq));
			const first = group[0] as Row;
			snap.set(
				`fk:${name}.${group.map((f) => f.from).join(",")}->${first.table}.${group
					.map((f) => f.to ?? "")
					.join(",")}`,
				{ value: `${first.on_delete}|${first.on_update}`, table: name },
			);
		}
		for (const i of db.prepare(`PRAGMA index_list('${name}')`).all() as Row[]) {
			if (i.origin === "pk") continue;
			const xinfo = (db.prepare(`PRAGMA index_xinfo('${i.name}')`).all() as Row[]).filter(
				(x) => Number(x.key) === 1,
			);
			const indexSql = (
				db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?").get(i.name) as {
					sql: string | null;
				} | null
			)?.sql;
			const hasExpression = xinfo.some((x) => x.name === null);
			const cols = hasExpression
				? `expr ${normalizeSql((indexSql ?? "").slice((indexSql ?? "").indexOf("(")))}`
				: xinfo
						.map(
							(x) =>
								`${x.name}${Number(x.desc) === 1 ? " desc" : ""}${
									String(x.coll).toUpperCase() === "BINARY" ? "" : ` collate ${x.coll}`
								}`,
						)
						.join(",");
			const where = indexWhere(indexSql ?? null, name);
			snap.set(
				`index:${name}(${cols})${Number(i.unique) === 1 ? " unique" : ""}${where ? ` where ${where}` : ""}`,
				{ value: "1", table: name },
			);
		}
	}
	return snap;
}

// ── Effects ──────────────────────────────────────────────────────────────────

export interface Effect {
	key: string;
	/** The key's value right after this entry (null: absent). */
	expected: string | null;
	/** Every value the key takes from this entry to the tail (null: absent). A live value matching any of them passes. */
	acceptable: Array<string | null>;
	/** The first later entry that removes the key (null: none does). */
	removedBy: number | null;
}

export interface EntryEffects {
	index: number;
	tag: string;
	when: number;
	hash: string;
	effects: Effect[];
	/** Table and column keys this entry adds (what makes a partly applied entry a gap). */
	created: string[];
	/** The entry has a top-level data statement (outside a table rebuild and a trigger body). */
	hasData: boolean;
}

export interface MigrationEffects {
	entries: EntryEffects[];
}

/**
 * Data statements the legacy init runs by itself, so a migration containing them is verified on the
 * schema alone. An entry whose tag isn't in the journal is stale and fails the drift test.
 */
export const LEGACY_EQUIVALENTS: ReadonlyArray<{ tag: string; kind: "data"; reason: string }> = [
	{
		tag: "0012_watcher_modes",
		kind: "data",
		reason:
			"The UPDATE that cancels duplicate open watcher runs is DEDUPE_OPEN_RUNS_SQL, which the legacy init runs on every boot before it creates the unique index.",
	},
];

const memo = new Map<string, MigrationEffects>();

interface JournalEntry {
	tag: string;
	when: number;
}

function readJournal(folder: string): { text: string; entries: JournalEntry[] } {
	const text = readFileSync(`${folder}/meta/_journal.json`, "utf8");
	return { text, entries: (JSON.parse(text) as { entries: JournalEntry[] }).entries };
}

function hasDataStatement(chunk: string): boolean {
	const first = chunk.replace(/^(\s|--[^\n]*\n)+/, "");
	if (/^insert\s+into\s+[`"]?__new_/i.test(first)) return false;
	return /^(update|insert|delete|replace)\b/i.test(first);
}

function recreatedTables(chunks: string[]): Set<string> {
	const out = new Set<string>();
	for (const chunk of chunks) {
		const m = /alter\s+table\s+[`"]?__new_(\w+)[`"]?\s+rename\s+to/i.exec(chunk);
		if (m?.[1]) out.add(m[1]);
	}
	return out;
}

/**
 * What each journal entry does to a database, derived by running the shipped SQL. Memoized per process
 * on the journal and every file's hash.
 */
export function migrationEffects(folder: string): MigrationEffects {
	const journal = readJournal(folder);
	const files = readMigrationFiles({ migrationsFolder: folder });
	const memoKey = createHash("sha256")
		.update(journal.text)
		.update(files.map((f) => f.hash).join(","))
		.digest("hex");
	const cached = memo.get(memoKey);
	if (cached) return cached;

	ledgerStats.replays++;
	const mem = new Database(":memory:");
	const snapshots: Snapshot[] = [new Map()];
	const rebuilt: Array<Set<string>> = [];
	try {
		for (const file of files) {
			for (const chunk of file.sql) {
				if (chunk.trim().length > 0) mem.prepare(chunk).run();
			}
			snapshots.push(introspect(mem));
			rebuilt.push(recreatedTables(file.sql));
		}
	} finally {
		mem.close();
	}

	const last = snapshots.length - 1;
	const entries: EntryEffects[] = files.map((file, i) => {
		const before = snapshots[i] as Snapshot;
		const after = snapshots[i + 1] as Snapshot;
		const touched = new Set<string>();
		for (const k of new Set([...before.keys(), ...after.keys()])) {
			if (before.get(k)?.value !== after.get(k)?.value) touched.add(k);
		}
		// A rebuilt table is owned whole, so a column that kept its spelling still has to be there.
		for (const table of rebuilt[i] ?? []) {
			for (const [k, cell] of after) if (cell.table === table) touched.add(k);
		}
		const effects: Effect[] = [...touched].map((key) => {
			const acceptable: Array<string | null> = [];
			let removedBy: number | null = null;
			for (let q = i + 1; q <= last; q++) {
				const v = snapshots[q]?.get(key)?.value ?? null;
				if (!acceptable.includes(v)) acceptable.push(v);
				// Snapshot q is the state after entry q - 1.
				if (v === null && removedBy === null && q > i + 1 && after.has(key)) removedBy = q - 1;
			}
			return { key, expected: after.get(key)?.value ?? null, acceptable, removedBy };
		});
		const created = [...after.keys()].filter(
			(k) => (k.startsWith("table:") || k.startsWith("column:")) && !before.has(k),
		);
		return {
			index: i,
			tag: (journal.entries[i] as JournalEntry).tag,
			when: file.folderMillis,
			hash: file.hash,
			effects,
			created,
			hasData: file.sql.some(hasDataStatement),
		};
	});
	const result = { entries };
	memo.set(memoKey, result);
	return result;
}

// ── Exceptions ───────────────────────────────────────────────────────────────

function parseColumn(value: string) {
	const m = /^(.*?)\|nn=(\d)\|dflt=([\s\S]*)\|pk=(\d+)\|pkn=(\d+)$/.exec(value);
	if (!m) return null;
	return {
		type: m[1] as string,
		nn: Number(m[2]),
		dflt: m[3] as string,
		pk: Number(m[4]),
		pkn: Number(m[5]),
	};
}

export interface LegacyException {
	id: "E1" | "E2" | "E3";
	reason: string;
	matches(key: string, expected: string, live: string): boolean;
}

/** Differences the legacy path has on purpose and the schema it creates still works with. Each is tested to exist. */
export const LEGACY_EXCEPTIONS: readonly LegacyException[] = [
	{
		id: "E1",
		reason:
			"sessions.metadata defaults to '{}' on the legacy path; the migration gives it no default.",
		matches(key, expected, live) {
			if (key !== "column:sessions.metadata") return false;
			const e = parseColumn(expected);
			const l = parseColumn(live);
			return !!e && !!l && e.dflt === "" && l.dflt === "'{}'" && e.type === l.type && e.nn === l.nn;
		},
	},
	{
		id: "E2",
		reason:
			"A single-column primary key that isn't INTEGER is NOT NULL in a migration and nullable on the legacy path.",
		matches(key, expected, live) {
			if (!key.startsWith("column:")) return false;
			const e = parseColumn(expected);
			const l = parseColumn(live);
			return (
				!!e &&
				!!l &&
				e.pk === 1 &&
				e.pkn === 1 &&
				e.type !== "INTEGER" &&
				e.nn === 1 &&
				l.nn === 0 &&
				e.type === l.type &&
				e.dflt === l.dflt &&
				e.pk === l.pk
			);
		},
	},
	{
		id: "E3",
		reason:
			"The post-boot cascade rebuild turns a session_id foreign key into ON DELETE CASCADE on the tables it targets.",
		matches(key, expected, live) {
			const m = /^fk:(\w+)\.(\w+)->sessions\.session_id$/.exec(key);
			if (!m) return false;
			if (!SESSION_CHILD_FK_TARGETS.some((t) => t.table === m[1] && t.column === m[2]))
				return false;
			const [expectedDelete, expectedUpdate] = expected.split("|");
			const [liveDelete, liveUpdate] = live.split("|");
			return (
				expectedDelete === "NO ACTION" && liveDelete === "CASCADE" && expectedUpdate === liveUpdate
			);
		},
	},
];

function equivalent(
	key: string,
	expected: string | null,
	live: string | null,
	used: Set<string>,
): boolean {
	if (expected === live) return true;
	if (expected === null || live === null) return false;
	for (const exception of LEGACY_EXCEPTIONS) {
		if (exception.matches(key, expected, live)) {
			used.add(exception.id);
			return true;
		}
	}
	return false;
}

// ── The ledger table ─────────────────────────────────────────────────────────

interface LedgerState {
	exists: boolean;
	malformed?: string;
	max: number | null;
}

function inspectLedger(sqlite: Database): LedgerState {
	const exists = sqlite
		.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
		.get(LEDGER_TABLE);
	if (!exists) return { exists: false, max: null };
	const columns = (sqlite.prepare(`PRAGMA table_info('${LEDGER_TABLE}')`).all() as Row[])
		.map((c) => String(c.name))
		.sort();
	if (columns.join(",") !== "created_at,hash,id") {
		return {
			exists: true,
			malformed: `${LEDGER_TABLE} has columns (${columns.join(", ")}), not (id, hash, created_at)`,
			max: null,
		};
	}
	const bad = sqlite
		.prepare(
			`SELECT count(*) AS n FROM ${LEDGER_TABLE} WHERE created_at IS NULL OR typeof(created_at) NOT IN ('integer','real')`,
		)
		.get() as { n: number };
	if (bad.n > 0) {
		return {
			exists: true,
			malformed: `${LEDGER_TABLE} has ${bad.n} row(s) whose created_at is NULL or not a number`,
			max: null,
		};
	}
	const max = sqlite.prepare(`SELECT max(created_at) AS m FROM ${LEDGER_TABLE}`).get() as {
		m: number | null;
	};
	return { exists: true, max: max.m === null ? null : Number(max.m) };
}

function newerRowCount(sqlite: Database, when: number): number {
	return (
		sqlite.prepare(`SELECT count(*) AS n FROM ${LEDGER_TABLE} WHERE created_at > ?`).get(when) as {
			n: number;
		}
	).n;
}

// ── Reconcile ────────────────────────────────────────────────────────────────

/**
 * Record in `__drizzle_migrations` every migration whose effects the database already has, as the longest
 * verified prefix of the journal. See the module comment for what "has" means.
 *
 * Forced mode throws a MigrationLedgerError, before writing anything, when `migrate()` would replay into
 * a half-applied migration or skip one the schema lacks. Legacy mode returns the same finding as
 * `report.problem` and records only what it can verify. Lock and IO errors propagate after a rollback.
 */
export function reconcileSqliteMigrationLedger(
	sqlite: Database,
	folder: string,
	mode: LedgerMode,
): LedgerReport {
	const started = performance.now();
	const finish = (report: Omit<LedgerReport, "mode" | "durationMs">): LedgerReport => ({
		mode,
		...report,
		durationMs: Math.round(performance.now() - started),
	});
	/** Forced mode stops here; legacy mode carries the finding in the report and goes on. */
	const raise = (problem: LedgerProblem): LedgerProblem => {
		if (mode === "forced") {
			if (problem.kind === "gap") throw new MigrationLedgerGapError(problem.message);
			if (problem.kind === "ahead") throw new MigrationLedgerAheadError(problem.message);
			throw new MigrationLedgerMalformedError(problem.message);
		}
		return problem;
	};
	const empty = {
		verifiedThrough: null,
		recorded: [],
		ledgerThrough: null,
		newerRows: 0,
		fastPath: false,
		exceptionsUsed: [],
	};

	const ledger = inspectLedger(sqlite);
	if (ledger.malformed) {
		const problem = raise({
			kind: "malformed",
			message: `[db] The migration ledger can't be read: ${ledger.malformed}. ${UPGRADE_HINT}`,
		});
		return finish({ ...empty, problem });
	}

	const journal = readJournal(folder);
	const tail = journal.entries.at(-1) as JournalEntry;
	// Legacy mode trusts a ledger at the tail, as drizzle does. Forced mode never does: it is about to hand
	// the database to migrate(), which would skip everything on a ledger that overstates the schema.
	if (mode === "legacy" && ledger.max === tail.when) {
		return finish({
			...empty,
			verifiedThrough: tail.tag,
			ledgerThrough: tail.tag,
			newerRows: 0,
			fastPath: true,
		});
	}

	const { entries } = migrationEffects(folder);
	ledgerStats.liveIntrospections++;
	const live = introspect(sqlite);
	const used = new Set<string>();

	let prefix = 0;
	let firstUnverified: LedgerReport["firstUnverified"];
	for (const entry of entries) {
		const failed = entryFailures(entry, live, used);
		if (failed.length > 0) {
			firstUnverified = { tag: entry.tag, keys: failed };
			break;
		}
		prefix++;
	}
	// An entry whose object is absent only because a later migration removes it can't be told from an entry
	// that never ran, so it stands only if that later migration is verified too.
	for (let again = true; again && prefix > 0; ) {
		again = false;
		for (let i = 0; i < prefix && !again; i++) {
			const entry = entries[i] as EntryEffects;
			const unexplained = entry.effects.find(
				(e) =>
					e.expected !== null && e.removedBy !== null && e.removedBy >= prefix && !live.has(e.key),
			);
			if (unexplained) {
				prefix = i;
				firstUnverified = {
					tag: entry.tag,
					keys: [`${unexplained.key} (absent, and the migration that removes it isn't verified)`],
				};
				again = true;
			}
		}
	}
	const verifiedThrough = prefix > 0 ? (entries[prefix - 1] as EntryEffects).tag : null;
	const ledgerThrough = ledgerTag(entries, ledger.max);
	const newerRows =
		ledger.max !== null && ledger.max > tail.when ? newerRowCount(sqlite, tail.when) : 0;
	const base = {
		verifiedThrough,
		firstUnverified,
		recorded: [] as string[],
		ledgerThrough,
		newerRows,
		fastPath: false,
		exceptionsUsed: [...used].sort(),
	};

	let problem: LedgerProblem | undefined;
	const leftovers = [...live.keys()].filter((k) => k.startsWith("table:__new_"));
	const verifiedWhen = prefix > 0 ? (entries[prefix - 1] as EntryEffects).when : 0;
	if (leftovers.length > 0) {
		// drizzle-kit rebuilds a table through __new_<name>; one left behind is a rebuild that stopped half way.
		problem = raise({
			kind: "gap",
			message: `[db] The database holds ${leftovers
				.slice(0, 3)
				.map((k) => k.slice("table:".length))
				.join(
					", ",
				)}, left by a table rebuild that didn't finish, so a migration would fail on it. ${UPGRADE_HINT}`,
		});
	} else if (prefix < entries.length && ledger.max !== null && ledger.max > verifiedWhen) {
		problem = raise({
			kind: "ahead",
			message: `[db] The migration ledger records migrations the schema doesn't show: it is at ${ledgerThrough ?? "an unknown migration"}, but ${
				firstUnverified?.tag ?? "a migration"
			} isn't fully present (${(firstUnverified?.keys ?? []).slice(0, 3).join("; ")}). ${UPGRADE_HINT}`,
		});
	} else {
		for (const entry of entries.slice(prefix)) {
			const present = entry.created.filter((k) => live.has(k));
			if (present.length > 0) {
				problem = raise({
					kind: "gap",
					message: `[db] Migration ${entry.tag} is partly present in the database (${present
						.slice(0, 3)
						.join(
							"; ",
						)}) but the migration ledger doesn't cover it, so Drizzle would replay it. ${UPGRADE_HINT}`,
				});
				break;
			}
		}
	}

	const floor = ledger.max ?? Number.NEGATIVE_INFINITY;
	const toRecord = entries.slice(0, prefix).filter((e) => e.when > floor);
	if (toRecord.length === 0) return finish({ ...base, problem });
	return finish({ ...base, problem, recorded: recordRows(sqlite, toRecord) });
}

function ledgerTag(entries: EntryEffects[], max: number | null): string | null {
	if (max === null) return null;
	let tag: string | null = null;
	for (const e of entries) if (e.when <= max) tag = e.tag;
	return tag;
}

/** The keys that stop an entry from being verified, or [] when it is. */
function entryFailures(entry: EntryEffects, live: Snapshot, used: Set<string>): string[] {
	if (entry.hasData && !LEGACY_EQUIVALENTS.some((q) => q.tag === entry.tag)) {
		return ["data statements with no legacy equivalent"];
	}
	const failed: string[] = [];
	for (const effect of entry.effects) {
		const liveValue = live.get(effect.key)?.value ?? null;
		if (!effect.acceptable.some((a) => equivalent(effect.key, a, liveValue, used))) {
			failed.push(effect.key);
		}
	}
	return failed;
}

/** Writes the rows in one immediate transaction that rereads the ledger's maximum first. */
function recordRows(sqlite: Database, toRecord: EntryEffects[]): string[] {
	const write = sqlite.transaction((): string[] => {
		sqlite.exec(LEDGER_DDL);
		const max = (
			sqlite.prepare(`SELECT max(created_at) AS m FROM ${LEDGER_TABLE}`).get() as {
				m: number | null;
			}
		).m;
		const floor = max === null ? Number.NEGATIVE_INFINITY : Number(max);
		const insert = sqlite.prepare(`INSERT INTO ${LEDGER_TABLE} (hash, created_at) VALUES (?, ?)`);
		const recorded: string[] = [];
		for (const entry of toRecord) {
			if (entry.when <= floor) continue;
			insert.run(entry.hash, entry.when);
			recorded.push(entry.tag);
		}
		return recorded;
	});
	return write.immediate();
}

/** The one line a boot logs. */
export function describeLedgerReport(report: LedgerReport, folder: string): string {
	const body = report.fastPath
		? `at tail (${report.verifiedThrough})`
		: `verified through ${report.verifiedThrough ?? "none"}; recorded ${report.recorded.length}${
				report.firstUnverified
					? `; first unverified ${report.firstUnverified.tag} (${report.firstUnverified.keys
							.slice(0, 3)
							.join("; ")})`
					: ""
			}${report.newerRows > 0 ? `; ${report.newerRows} ledger row(s) from a newer release` : ""}`;
	return `[db] migration ledger (${report.mode}): ${body} [${report.durationMs} ms, ${folder}]`;
}
