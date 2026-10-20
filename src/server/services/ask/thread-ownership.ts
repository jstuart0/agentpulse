/**
 * Who owns an Ask thread, as one definition used twice: as a SQL condition (the thread read, list and
 * archive rules) and as a plain function (the push targeting for `ask_reply`). Keeping both here is what
 * lets "the push only goes to devices that can open the thread" be true by construction, and a parity
 * test (ask-reply-push.test.ts) holds the two forms together.
 *
 * The rule, for a caller that may reach only its own threads (a respond key; every caller in `ownOnly`):
 *   - a thread with an owner user is the caller's if the caller's user is that user. A key owned by a
 *     person counts as that person, so a phone's respond key reads a thread its owner started on the
 *     web (a cookie caller, or a manage key of the same person), whichever credential asked it;
 *   - a thread with no owner user but an owner key is the caller's only if the caller IS that key.
 *     This covers a key with no person behind it (solo or team). It is deliberately not widened to
 *     "keys paired to the same device" or "any ownerless key in solo": nothing ties two ownerless keys
 *     to one person, so another ownerless key reads nothing of theirs;
 *   - a thread with neither (predates owners, Telegram, auth off) is nobody's here.
 */
import { type SQL, and, eq, or, sql } from "drizzle-orm";
import { askThreads } from "../../db/schema/index.js";

export interface ThreadOwner {
	ownerUserId: string | null;
	ownerKeyId: string | null;
}

/** The credential behind a request: the person its key belongs to (null for an ownerless key) and the key itself. */
export interface ThreadReader {
	userId: string | null;
	keyId: string | null;
}

/** An empty id is no id: the table has no CHECK, so `""` may be stored, and both forms read it as absent. */
function present(id: string | null | undefined): string | null {
	return id ? id : null;
}

export function ownsThread(owner: ThreadOwner, who: ThreadReader): boolean {
	const ownerUserId = present(owner.ownerUserId);
	const ownerKeyId = present(owner.ownerKeyId);
	if (ownerUserId !== null) return who.userId === ownerUserId;
	return ownerKeyId !== null && who.keyId === ownerKeyId;
}

/** The same rule as `ownsThread`, for a WHERE clause. */
export function ownsThreadCondition(who: ThreadReader): SQL {
	const owned: SQL[] = [];
	if (who.userId) owned.push(eq(askThreads.ownerUserId, who.userId));
	if (who.keyId) {
		// NULLIF: a stored "" owner user is no owner (see `present`), so the key rule applies to it.
		owned.push(
			and(
				sql`NULLIF(${askThreads.ownerUserId}, '') IS NULL`,
				eq(askThreads.ownerKeyId, who.keyId),
			) as SQL,
		);
	}
	return owned.length > 0 ? (or(...owned) as SQL) : sql`1 = 0`;
}
