/**
 * Guard for anything that creates a credential or host on behalf of a user:
 * a disabled user must not gain a new key or host. Callers run it inside
 * the admin lock's transaction, in the same transaction as the insert, so a
 * disable that commits first is always seen and one that comes after sees
 * (and revokes) the new row.
 */
import { eq } from "drizzle-orm";
import { users } from "../db/schema/index.js";

export class OwnerDisabledError extends Error {
	readonly userId: string;
	constructor(userId: string) {
		super(`User ${userId} is disabled.`);
		this.name = "OwnerDisabledError";
		this.userId = userId;
	}
}

export class OwnerNotFoundError extends Error {
	readonly userId: string;
	constructor(userId: string) {
		super(`User ${userId} does not exist.`);
		this.name = "OwnerNotFoundError";
		this.userId = userId;
	}
}

/**
 * For handing something to a named user (a key, a host, sessions): the user
 * must exist and be active. Unlike assertOwnerActive, an unknown id is refused.
 */
// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function assertOwnerAssignable(tx: any, userId: string): Promise<void> {
	const [row] = await tx
		.select({ disabledAt: users.disabledAt })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!row) throw new OwnerNotFoundError(userId);
	if (row.disabledAt !== null) throw new OwnerDisabledError(userId);
}

/**
 * Throws OwnerDisabledError when the user exists and is disabled. A user id
 * with no row is let through: ownership columns are plain text, and a
 * missing row is not a disabled one.
 */
// biome-ignore lint/suspicious/noExplicitAny: dialect-portable handle, same shape as withTransaction's tx
export async function assertOwnerActive(tx: any, userId: string): Promise<void> {
	const [row] = await tx
		.select({ disabledAt: users.disabledAt })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (row && row.disabledAt !== null) throw new OwnerDisabledError(userId);
}
