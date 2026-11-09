/**
 * Where unsent prompt drafts live in localStorage, and the rules for reading them back. No React and no
 * zustand, so the sign-out path can import it without pulling the draft store into the entry chunk.
 *
 * Layout: one index per viewer, `[sessionId, savedAtMs]` pairs newest first (so the 7-day TTL and the
 * 30-draft limit are decided from the index alone), and one entry per draft, `{"t": text, "at": savedAtMs}`.
 */
export const DRAFT_PREFIX = "agentpulse.promptDraft.";
export const MAX_DRAFTS = 30;

/** Encodes one key part; the dot too, so no viewer's key prefix can match another viewer's keys. */
function part(value: string): string {
	return encodeURIComponent(value).replaceAll(".", "%2E");
}

/** `u:<id>` for a signed-in viewer, `anon` for none; the two can't collide. */
export function viewerTag(userId: string | null): string {
	return userId === null ? "anon" : `u:${part(userId)}`;
}

export function indexKey(tag: string): string {
	return `${DRAFT_PREFIX}index.${tag}`;
}

export function draftKeyPrefix(tag: string): string {
	return `${DRAFT_PREFIX}d.${tag}.`;
}

export function draftKey(tag: string, sessionId: string): string {
	return `${draftKeyPrefix(tag)}${part(sessionId)}`;
}

export type IndexPair = [sessionId: string, savedAt: number];

/** Defensive: anything but pairs of a string and a finite number is dropped, ids are deduplicated (first wins), at most 30 are kept. */
export function parseIndex(raw: string | null): IndexPair[] {
	if (raw === null) return [];
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const pairs: IndexPair[] = [];
	for (const item of value) {
		if (pairs.length >= MAX_DRAFTS) break;
		if (!Array.isArray(item)) continue;
		const [id, at] = item as unknown[];
		if (typeof id !== "string" || typeof at !== "number" || !Number.isFinite(at)) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		pairs.push([id, at]);
	}
	return pairs;
}

export function parseEntry(raw: string | null): { t: string; at: number } | null {
	if (raw === null) return null;
	try {
		const value = JSON.parse(raw) as { t?: unknown; at?: unknown } | null;
		if (
			typeof value?.t !== "string" ||
			typeof value.at !== "number" ||
			!Number.isFinite(value.at)
		) {
			return null;
		}
		return { t: value.t, at: value.at };
	} catch {
		return null;
	}
}

export interface PurgeableStorage {
	readonly length: number;
	key(index: number): string | null;
	removeItem(key: string): void;
}

let draftsPurged = false;

/** Removes every draft key (every viewer's, the indexes too) and stops any later draft write from landing. Never throws. */
export function purgeAllPromptDrafts(storage: PurgeableStorage | null): void {
	draftsPurged = true;
	if (!storage) return;
	try {
		const keys: string[] = [];
		for (let i = 0; i < storage.length; i++) {
			const key = storage.key(i);
			if (key?.startsWith(DRAFT_PREFIX)) keys.push(key);
		}
		for (const key of keys) storage.removeItem(key);
	} catch {
		// Storage refused: nothing more can be done from here.
	}
}

/** False once the page has purged drafts for a sign-out: a debounced write or the pagehide flush must not put one back. */
export function draftWritesAllowed(): boolean {
	return !draftsPurged;
}

export function __resetDraftsPurgedForTests(): void {
	draftsPurged = false;
}
