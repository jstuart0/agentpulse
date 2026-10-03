/**
 * Single mapper from a raw `sessions` row to the API/WebSocket DTO shape.
 * Adds the derived `nameSource`/`nativeName`/`operationalStatus`
 * fields so every REST response and every WebSocket broadcast agrees,
 * without a schema change — all three are computed from columns already on
 * the row.
 *
 * Used by getSessions/getSession (session-tracker.ts) and — critically —
 * inside notifySessionCreated/notifySessionUpdated (notifier.ts), which is
 * the single choke point for every session_created/session_updated
 * broadcast (ingest.ts, supervisors.ts). No raw row should reach
 * useWebSocket.ts without going through here first.
 */
import { type OperationalStatus, getOperationalStatus } from "../../shared/session-state.js";

export type NameSource = "user" | "native" | "generated";

/**
 * Derived from owner_user_id / ingest_key_id: "user" when the session
 * has an owner; "service" when it's unowned but a service key's event
 * created or filled it; "unassigned" when both are still null.
 */
export type OwnerKind = "user" | "service" | "unassigned";

interface SessionRowLike {
	displayName: string | null;
	metadata: unknown;
	ownerUserId?: string | null;
	ingestKeyId?: string | null;
	/** Present when the row is an already-mapped session (its key id is gone). */
	ownerKind?: OwnerKind;
	// Optional: a narrow projection (getSessionSummaries) doesn't
	// select these. operationalStatus comes out wrong (defaults to "idle")
	// on such a row, but no caller of that projection reads the field —
	// see computeOperationalStatus's fallback below.
	status?: string;
	isWorking?: boolean;
	isArchived?: boolean;
	endedAt?: string | null;
	semanticStatus?: string | null;
	lastAgentTurnCompletedAt?: string | null;
	lastUserAcknowledgedAt?: string | null;
}

function computeOperationalStatus(
	row: SessionRowLike,
	metadata: Record<string, unknown>,
): OperationalStatus {
	return getOperationalStatus({
		status: row.status ?? "active",
		isWorking: row.isWorking ?? false,
		isArchived: row.isArchived ?? false,
		endedAt: row.endedAt ?? null,
		semanticStatus: row.semanticStatus ?? null,
		metadata,
		lastAgentTurnCompletedAt: row.lastAgentTurnCompletedAt ?? null,
		lastUserAcknowledgedAt: row.lastUserAcknowledgedAt ?? null,
	});
}

export function deriveOwnerKind(
	row: Pick<SessionRowLike, "ownerUserId" | "ingestKeyId" | "ownerKind">,
): OwnerKind {
	// A session that was already mapped has had its key id stripped, so
	// "unassigned" can't be told from "service" by looking again: keep the
	// kind it was given.
	if (row.ingestKeyId === undefined && row.ownerKind !== undefined) return row.ownerKind;
	if (row.ownerUserId != null) return "user";
	if (row.ingestKeyId != null) return "service";
	return "unassigned";
}

export function mapSessionDto<
	T extends SessionRowLike,
	E extends Record<string, unknown> = Record<string, never>,
>(
	row: T,
	extras?: E,
): Omit<T, "ingestKeyId"> &
	E & {
		nameSource: NameSource;
		nativeName: string | null;
		ownerKind: OwnerKind;
		operationalStatus: OperationalStatus;
	} {
	const metadata = (row.metadata ?? {}) as Record<string, unknown>;

	let nameSource: NameSource;
	if (metadata.renameSource === "user") {
		nameSource = "user";
	} else if (row.displayName !== null && row.displayName === metadata.lastAppliedNativeName) {
		nameSource = "native";
	} else {
		nameSource = "generated";
	}

	const nativeName = typeof metadata.nativeName === "string" ? metadata.nativeName : null;
	const ownerKind = deriveOwnerKind(row);
	const operationalStatus = computeOperationalStatus(row, metadata);

	// ingestKeyId never leaves the server — removed here, not just
	// left undefined, so it's absent from the serialized JSON too.
	const { ingestKeyId: _ingestKeyId, ...rest } = row as T & { ingestKeyId?: string | null };

	return {
		...rest,
		...(extras ?? ({} as E)),
		nameSource,
		nativeName,
		ownerKind,
		operationalStatus,
	} as Omit<T, "ingestKeyId"> &
		E & {
			nameSource: NameSource;
			nativeName: string | null;
			ownerKind: OwnerKind;
			operationalStatus: OperationalStatus;
		};
}
