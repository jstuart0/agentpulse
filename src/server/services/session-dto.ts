/**
 * Single mapper from a raw `sessions` row to the API/WebSocket DTO shape
 * (D14/F48). Adds the derived `nameSource`/`nativeName` fields so every
 * REST response and every WebSocket broadcast agrees, without a schema
 * change — both are computed from `metadata`.
 *
 * Used by getSessions/getSession (session-tracker.ts) and — critically —
 * inside notifySessionCreated/notifySessionUpdated (notifier.ts), which is
 * the single choke point for every session_created/session_updated
 * broadcast (ingest.ts, supervisors.ts). No raw row should reach
 * useWebSocket.ts without going through here first.
 */

export type NameSource = "user" | "native" | "generated";

interface SessionRowLike {
	displayName: string | null;
	metadata: unknown;
}

export function mapSessionDto<
	T extends SessionRowLike,
	E extends Record<string, unknown> = Record<string, never>,
>(row: T, extras?: E): T & E & { nameSource: NameSource; nativeName: string | null } {
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

	return { ...row, ...(extras ?? ({} as E)), nameSource, nativeName };
}
