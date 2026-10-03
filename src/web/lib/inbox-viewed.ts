import { userScopedKey } from "./id-set-storage.js";

export interface InboxViewed {
	at: number;
	total: number;
}

const VIEWED_AT_KEY = "agentpulse.inboxLastViewedAt";
const VIEWED_TOTAL_KEY = "agentpulse.inboxLastViewedTotal";

/** Where the "last viewed the inbox" marks live for this viewer. */
export function inboxViewedKeys(userId: string | null): { at: string; total: string } {
	return {
		at: userScopedKey(VIEWED_AT_KEY, userId),
		total: userScopedKey(VIEWED_TOTAL_KEY, userId),
	};
}

function readNumber(storage: Pick<Storage, "getItem">, key: string): number {
	const raw = storage.getItem(key);
	if (!raw) return 0;
	const value = Number(raw);
	return Number.isFinite(value) ? value : 0;
}

export function readInboxViewed(
	storage: Pick<Storage, "getItem"> | undefined,
	userId: string | null,
): InboxViewed {
	if (!storage) return { at: 0, total: 0 };
	const keys = inboxViewedKeys(userId);
	return { at: readNumber(storage, keys.at), total: readNumber(storage, keys.total) };
}

export function writeInboxViewed(
	storage: Pick<Storage, "setItem"> | undefined,
	userId: string | null,
	viewed: InboxViewed,
): void {
	if (!storage) return;
	const keys = inboxViewedKeys(userId);
	try {
		storage.setItem(keys.at, String(viewed.at));
		storage.setItem(keys.total, String(viewed.total));
	} catch {
		// ignore storage failures
	}
}
