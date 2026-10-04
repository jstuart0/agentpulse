/**
 * Records every statement executed through the raw bun:sqlite handle: its
 * SQL, bound parameters, rows returned and BLOB bytes returned. Lets a test
 * assert what one statement materialised without measuring RSS or wall time.
 *
 * It wraps `prepare` and `query` on the handle, so code under test must
 * prepare per call (a statement cached at module load is invisible, and the
 * tests assert at least one execution was seen).
 */
import { getSqlite } from "../db/client.js";

export interface StatementExecution {
	sql: string;
	params: unknown[];
	rows: number;
	/** Bytes of BLOB values returned (strings and numbers are not counted). */
	bytes: number;
	seq: number;
	/** The executor used: all, get, values, run or iterate. */
	method: string;
}

export interface StatementMeter {
	executions: StatementExecution[];
	/** Executions whose SQL matches the pattern, in order. */
	matching(pattern: RegExp): StatementExecution[];
	/** Called synchronously after each execution, before the caller sees the result. */
	setAfterExecute(fn: ((execution: StatementExecution) => void) | null): void;
	restore(): void;
}

const EXECUTORS = ["all", "get", "values", "run", "iterate"] as const;

/** Only BLOB values count: that is the part of a vector read that scales with the dimension. */
function sizeOf(value: unknown): number {
	return value instanceof Uint8Array ? value.byteLength : 0;
}

function measure(result: unknown): { rows: number; bytes: number } {
	const list = Array.isArray(result) ? result : result == null ? [] : [result];
	let bytes = 0;
	for (const row of list) {
		if (row && typeof row === "object" && !(row instanceof Uint8Array)) {
			const cells = Array.isArray(row) ? row : Object.values(row as Record<string, unknown>);
			for (const cell of cells) bytes += sizeOf(cell);
		}
	}
	return { rows: list.length, bytes };
}

export function installStatementMeter(): StatementMeter {
	const sqlite = getSqlite() as unknown as Record<string, unknown> & {
		prepare: (sql: string) => object;
		query: (sql: string) => object;
	};
	const original = { prepare: sqlite.prepare, query: sqlite.query };
	const executions: StatementExecution[] = [];
	let afterExecute: ((execution: StatementExecution) => void) | null = null;
	let seq = 0;

	function wrap(statement: object, sql: string): object {
		return new Proxy(statement, {
			get(target, prop) {
				const value = Reflect.get(target, prop, target);
				if (typeof value !== "function") return value;
				if (!(EXECUTORS as readonly string[]).includes(prop as string)) return value.bind(target);
				return (...params: unknown[]) => {
					const result = value.apply(target, params);
					const { rows, bytes } = measure(result);
					const execution = { sql, params, rows, bytes, seq: seq++, method: prop as string };
					executions.push(execution);
					afterExecute?.(execution);
					return result;
				};
			},
		});
	}

	sqlite.prepare = function (this: unknown, sql: string) {
		return wrap((original.prepare as (s: string) => object).call(sqlite, sql), sql);
	};
	sqlite.query = function (this: unknown, sql: string) {
		return wrap((original.query as (s: string) => object).call(sqlite, sql), sql);
	};

	return {
		executions,
		matching: (pattern) => executions.filter((e) => pattern.test(e.sql)),
		setAfterExecute: (fn) => {
			afterExecute = fn;
		},
		restore() {
			sqlite.prepare = original.prepare;
			sqlite.query = original.query;
		},
	};
}
