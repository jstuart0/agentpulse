/**
 * A small set of ids kept in localStorage (checklist items an admin dismissed,
 * keys and hosts they have looked at). Reading never throws: corrupt text, a
 * missing store (private mode) or a refused write all degrade to "remembered
 * for now, or not at all", which only costs a repeated reminder.
 */
export interface KeyValueStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const memory = new Map<string, Set<string>>();

export function browserStorage(): KeyValueStorage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

export function readIdSet(key: string, storage: KeyValueStorage | null): Set<string> {
	if (!storage) return new Set(memory.get(key) ?? []);
	try {
		const parsed: unknown = JSON.parse(storage.getItem(key) ?? "[]");
		if (!Array.isArray(parsed)) return new Set();
		return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
	} catch {
		return new Set();
	}
}

export function addToIdSet(
	key: string,
	ids: readonly string[],
	storage: KeyValueStorage | null,
): Set<string> {
	const next = readIdSet(key, storage);
	for (const id of ids) next.add(id);
	if (!storage) {
		memory.set(key, next);
		return new Set(next);
	}
	try {
		storage.setItem(key, JSON.stringify([...next]));
	} catch {
		// Storage refused the write: the set still answers for this session.
	}
	return next;
}

/** A storage key for one person on a shared browser, so one person's choices don't hide another's reminders. */
export function userScopedKey(base: string, userId: string | null): string {
	return `${base}.${userId ?? "anonymous"}`;
}
