/**
 * Output-cap helpers (AGEN-12 Phase 2, D5).
 *
 * Pure functions — no client, no server dependencies. Every MCP tool result
 * is expected to route through these (structurally, via the registration
 * wrappers in server.ts — see registerReadTool/registerMutatingTool) before
 * it reaches the client, so a single oversized page never blows the
 * client's ~25K-token hard cap.
 */

/** ~10K tokens at a conservative 4 chars/token; the client's hard cap is ~25K tokens. */
export const DEFAULT_CHAR_BUDGET = 40_000;

/** Per-field preview cap for free-text fields (tool_input/tool_response previews, etc). */
export const DEFAULT_TEXT_CAP = 500;

export interface CapListOptions<T> {
	/** Character budget for the serialized list (default DEFAULT_CHAR_BUDGET). */
	budget?: number;
	/** Offset already applied upstream — the continuation hint's offset= is relative to this. */
	offset?: number;
	/** How to measure an item's size. Defaults to JSON.stringify length. */
	serialize?: (item: T) => string;
}

export interface CapListResult<T> {
	items: T[];
	/** Present only when the list was truncated. Format: "…N more — call again with offset=X". */
	hint?: string;
}

const defaultSerialize = <T>(item: T): string => JSON.stringify(item);

/**
 * Drop tail entries once the running serialized size would exceed `budget`,
 * appending a continuation hint naming exactly how many were dropped and
 * where to resume. Always keeps at least one item (even if that item alone
 * exceeds the budget) — returning zero items with no explanation is worse
 * than one oversized item; the hint on the single-oversized-item case notes
 * the overage explicitly instead of implying more items exist.
 */
export function capList<T>(items: T[], options: CapListOptions<T> = {}): CapListResult<T> {
	const budget = options.budget ?? DEFAULT_CHAR_BUDGET;
	const offset = options.offset ?? 0;
	const serialize = options.serialize ?? defaultSerialize;

	if (items.length === 0) return { items: [] };

	const kept: T[] = [];
	let used = 0;

	for (let i = 0; i < items.length; i++) {
		const size = serialize(items[i]).length;

		if (kept.length === 0) {
			kept.push(items[i]);
			used += size;
			if (size > budget && items.length === 1) {
				return {
					items: kept,
					hint: "this single item exceeds the output budget on its own — content may be incomplete",
				};
			}
			continue;
		}

		if (used + size > budget) {
			const droppedCount = items.length - kept.length;
			const nextOffset = offset + kept.length;
			return {
				items: kept,
				hint: `…${droppedCount} more — call again with offset=${nextOffset}`,
			};
		}

		kept.push(items[i]);
		used += size;
	}

	return { items: kept };
}

/**
 * Truncate a free-text field to at most `maxLength` UTF-16 code units,
 * appending an ellipsis marker. UTF-8/UTF-16-safe: never slices between a
 * surrogate pair (would otherwise produce an unpaired surrogate on
 * multi-byte characters like emoji or CJK text straddling the boundary).
 *
 * Deliberately does NOT redact secret-shaped substrings (API keys, Bearer
 * tokens) — transcript/tool-output content is trusted passthrough per the
 * plan's Risks section; this function's only job is length capping.
 */
export function capText(text: string, maxLength: number = DEFAULT_TEXT_CAP): string {
	if (text.length <= maxLength) return text;

	let end = maxLength;
	const code = text.charCodeAt(end - 1);
	const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
	if (isHighSurrogate) end -= 1;

	return `${text.slice(0, end)}…`;
}

function serializedLength(value: unknown): number {
	try {
		return JSON.stringify(value)?.length ?? 0;
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

/**
 * Structural safety net applied by the tool-registration wrappers
 * (registerReadTool/registerMutatingTool in server.ts) to EVERY handler
 * return value — not just ones a handler author remembered to cap. Most
 * tools should call capList/capText themselves for precise, per-field
 * control; this exists so an oversized result still never reaches the
 * client's ~25K-token hard cap even when a handler didn't.
 *
 * Strategy: pass through under budget. Over budget: if the result is an
 * array, delegate to capList. If it's an object, cap its largest
 * array-valued field (the common "list wrapped in an envelope" shape) and
 * attach the drop hint under `_truncated`. Otherwise (a single oversized
 * scalar/object with no array to trim) fall back to a truncated summary —
 * never emit a result that blows the budget with no explanation.
 */
export function capToolResult(result: unknown, budget: number = DEFAULT_CHAR_BUDGET): unknown {
	const totalSize = serializedLength(result);
	if (totalSize <= budget) return result;

	if (Array.isArray(result)) {
		const capped = capList(result, { budget });
		return capped.hint ? { items: capped.items, _truncated: capped.hint } : capped.items;
	}

	if (result && typeof result === "object") {
		const entries = Object.entries(result as Record<string, unknown>);
		const arrayEntries = entries.filter((entry): entry is [string, unknown[]] =>
			Array.isArray(entry[1]),
		);
		const [largestKey, largestArray] =
			arrayEntries.sort((a, b) => serializedLength(b[1]) - serializedLength(a[1]))[0] ?? [];

		if (largestKey !== undefined) {
			const envelopeOverhead = totalSize - serializedLength(largestArray);
			const arrayBudget = Math.max(budget - envelopeOverhead, 500);
			const capped = capList(largestArray, { budget: arrayBudget });
			const out: Record<string, unknown> = {
				...(result as Record<string, unknown>),
				[largestKey]: capped.items,
			};
			if (capped.hint) out._truncated = capped.hint;
			return out;
		}
	}

	return {
		truncated: true,
		note: `Result exceeds the ${budget}-character output budget and could not be structurally capped down to a smaller array field; omitted to protect the client.`,
		originalSizeChars: totalSize,
	};
}
