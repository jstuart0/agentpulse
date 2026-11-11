/**
 * What both databases accept as stored text (AGEN-39).
 *
 * Postgres refuses U+0000 in a `text` value, refuses a lone-surrogate escape in a `json` value,
 * and can't read any key of a `json` value that holds a `\u0000` escape. SQLite stores all of
 * it. One rule for both, so a row means the same thing on either: U+0000 becomes a visible
 * marker and a lone surrogate becomes U+FFFD. Each replacement is one unit for one unit, so caps,
 * cut points and redaction offsets never move.
 */

export const STORAGE_NUL_MARKER = "␀";
const NUL = "\u0000";

export const STORAGE_TOO_DEEP_MARKER = "[STORAGE:too_deep]";
export const STORAGE_TOO_LARGE_MARKER = "[STORAGE:too_large]";

const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 200_000;

// `isWellFormed`/`toWellFormed` are ES2024; tsconfig targets ES2022, so reach them through a cast.
type WellFormedString = string & { isWellFormed(): boolean; toWellFormed(): string };

/** The text with U+0000 replaced by `␀` and each lone surrogate by U+FFFD. The same reference when clean. */
export function wellFormedText(text: string): string {
	const hasNul = text.includes(NUL);
	const isWellFormed = (text as WellFormedString).isWellFormed();
	if (!hasNul && isWellFormed) return text;
	const unNulled = hasNul ? text.replaceAll(NUL, STORAGE_NUL_MARKER) : text;
	return isWellFormed ? unNulled : (unNulled as WellFormedString).toWellFormed();
}

/** The first `max` units, never ending on a high surrogate. */
export function cutText(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return text.slice(0, end);
}

/** The last `max` units, never starting on a low surrogate. */
export function cutTextTail(text: string, max: number): string {
	if (text.length <= max) return text;
	let start = text.length - max;
	const first = text.charCodeAt(start);
	if (first >= 0xdc00 && first <= 0xdfff) start++;
	return text.slice(start);
}

interface BoundState {
	nodes: number;
	maxDepth: number;
	maxNodes: number;
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
	// So an own `__proto__` key stays data and never reaches the prototype.
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

function boundedWalk(value: unknown, depth: number, state: BoundState): unknown {
	// Every value counts, scalars too: a flat array of a million numbers is out of reach of the rule otherwise.
	if (++state.nodes > state.maxNodes) return STORAGE_TOO_LARGE_MARKER;
	if (typeof value === "string") return wellFormedText(value);
	if (value === null || typeof value !== "object") return value;
	if (depth >= state.maxDepth) return STORAGE_TOO_DEEP_MARKER;
	if (Array.isArray(value)) {
		let out: unknown[] | null = null;
		for (let i = 0; i < value.length; i++) {
			const next = boundedWalk(value[i], depth + 1, state);
			if (out === null && next !== value[i]) out = value.slice(0, i);
			if (out !== null) out.push(next);
		}
		return out ?? value;
	}
	const source = value as Record<string, unknown>;
	const keys = Object.keys(source);
	let out: Record<string, unknown> | null = null;
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i] as string;
		const fixedKey = wellFormedText(key);
		const next = boundedWalk(source[key], depth + 1, state);
		if (out === null && (fixedKey !== key || next !== source[key])) {
			out = {};
			for (let j = 0; j < i; j++) defineOwn(out, keys[j] as string, source[keys[j] as string]);
		}
		if (out !== null) defineOwn(out, fixedKey, next);
	}
	return out ?? value;
}

/**
 * A JSON-shaped value with every string and every key made well formed, copied only where
 * something changed (the same reference otherwise). A subtree deeper than `maxDepth` becomes
 * `[STORAGE:too_deep]` and the rest past `maxNodes` values (scalars included) becomes `[STORAGE:too_large]`, so a
 * hostile body can't put the rule out of reach. Not a redaction: it leaves secrets alone.
 */
export function boundedWellFormedValue<T>(
	value: T,
	options: { maxDepth?: number; maxNodes?: number } = {},
): T {
	const state: BoundState = {
		nodes: 0,
		maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
		maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
	};
	return boundedWalk(value, 0, state) as T;
}
