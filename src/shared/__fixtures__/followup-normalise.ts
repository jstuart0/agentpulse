/**
 * The one normalisation both halves of the Codex follow-up use before they compare against a committed
 * fixture (codex-prompt-action.json, codex-followup-events.json): ids become placeholders, timestamps are
 * dropped, everything else compares exactly. Test support only; nothing in the product imports it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Keys whose value is a moment in time. */
const TIMESTAMP_KEYS = new Set([
	"occurredAt",
	"createdAt",
	"updatedAt",
	"at",
	"timestamp",
	"finishedAt",
	"startedAt",
]);

/** A value to look for and the placeholder it becomes, e.g. [sessionId, "<session>"]. */
export type Replacement = readonly [value: string, placeholder: string];

export function normaliseFollowUp<T>(value: T, replacements: readonly Replacement[]): T {
	const walk = (node: unknown): unknown => {
		if (typeof node === "string") {
			let out = node;
			for (const [from, to] of replacements) {
				if (from) out = out.split(from).join(to);
			}
			return out;
		}
		if (Array.isArray(node)) return node.map(walk);
		if (node && typeof node === "object") {
			const out: Record<string, unknown> = {};
			for (const [key, child] of Object.entries(node)) {
				if (TIMESTAMP_KEYS.has(key)) continue;
				out[key] = walk(child);
			}
			return out;
		}
		return node;
	};
	return walk(value) as T;
}

/**
 * Reads a committed fixture. With UPDATE_FIXTURES=1 it is rewritten from `actual` first, which is how a
 * fixture is regenerated; it is never edited by hand.
 */
export function readOrUpdateFixture<T>(path: URL, actual: T): T {
	if (process.env.UPDATE_FIXTURES === "1") {
		writeFileSync(path, `${JSON.stringify(actual, null, "\t")}\n`);
	}
	if (!existsSync(path)) {
		throw new Error(`Fixture ${path.pathname} is missing; regenerate it with UPDATE_FIXTURES=1.`);
	}
	return JSON.parse(readFileSync(path, "utf8")) as T;
}
