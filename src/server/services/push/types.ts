/**
 * Types shared by the mobile push modules. Nothing here touches the database:
 * the device rows and the targeting policy arrive through the interfaces
 * below, so these modules can be built and tested on their own.
 */

/** Event types the server can push about. Open set on the wire; these are the ones this server emits. */
export const PUSH_EVENT_TYPES = [
	"turn_completed",
	"permission_wait",
	"session_failed",
	"session_completed",
	"hitl_opened",
	"action_request_opened",
	"launch_status",
	"stuck",
	"risky",
	"daily_digest",
] as const;
export type PushEventType = (typeof PUSH_EVENT_TYPES)[number];

/** The notification category the phone's extension applies (the outer alert is always the generic Open-only one). */
export const PUSH_CATEGORIES = [
	"NEEDS_YOU_TURN",
	"NEEDS_YOU_PERMISSION",
	"SESSION_FAILED",
	"SESSION_COMPLETED",
	"WATCHER_HITL",
	"ACTION_REQUEST",
	"LAUNCH_STATUS",
	"STUCK",
	"RISKY",
	"DIGEST",
] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];

export type InterruptionLevel = "passive" | "active" | "time-sensitive";

/** The relay's cleartext priority class for an alert. It is the only thing the relay learns about urgency. */
export type RelayPriority = "needs-you" | "normal" | "quiet";

export type PushSessionStatus = "waiting" | "working" | "error" | "idle" | "completed";

interface SessionScoped {
	sessionId: string;
	sessionName?: string | null;
	agent?: string | null;
	machine?: string | null;
	status?: PushSessionStatus;
	/** How many things are waiting on the user after this event. */
	pending?: number;
}

/**
 * A push-worthy happening. Carries ids and short labels, never transcripts.
 * `text` is the one free-text member: a redacted line of agent output that only
 * reaches a device whose owner turned on "Include agent text".
 */
export type PushEvent =
	| ({ type: "turn_completed"; text?: string | null } & SessionScoped)
	| ({ type: "permission_wait"; text?: string | null } & SessionScoped)
	| ({
			type: "session_failed";
			durationSec?: number;
			toolCount?: number;
			text?: string | null;
	  } & SessionScoped)
	| ({ type: "session_completed"; durationSec?: number; toolCount?: number } & SessionScoped)
	| ({
			type: "hitl_opened";
			hitlId: string;
			proposalId: string;
			promptHash?: string;
			text?: string | null;
	  } & SessionScoped)
	| {
			type: "action_request_opened";
			actionRequestId: string;
			actionKind: string;
			sessionId?: string;
			text?: string | null;
	  }
	| ({ type: "launch_status"; launchId: string; failed?: boolean } & Partial<SessionScoped>)
	| ({ type: "stuck"; text?: string | null } & SessionScoped)
	| ({ type: "risky"; text?: string | null } & SessionScoped)
	| { type: "daily_digest"; digestDate: string };

export interface QuietHours {
	enabled: boolean;
	/** Local HH:mm. */
	start: string;
	end: string;
}

/** The members of a device's `prefs` this module reads. Unknown members are ignored. */
export interface DevicePrefs {
	/** Names, agent and machine in the sealed payload. Default on. */
	showContent?: boolean;
	/** Redacted agent text (180 characters) in the sealed payload. Default off. */
	includeAgentText?: boolean;
	quietHours?: QuietHours;
	/** Category -> enabled. Absent means the category's default. */
	categories?: Partial<Record<PushCategory, boolean>>;
	/** IANA zone for quiet hours. */
	timezone?: string;
}

/**
 * What the push modules need to know about a registered phone. The device
 * table's row maps onto this; `sendTokenCiphertext` and `publicKey` are the two
 * members that carry weight and must never be logged. The send token is held
 * encrypted at rest and decrypted only inside the call that posts to the relay.
 */
export interface PushDevice {
	/** This server's id for the device (revocation and logs). */
	id: string;
	userId: string;
	platform: string;
	/** The relay's id for the device: the `d` of every envelope. */
	relayDeviceId: string;
	/** The stored (encrypted) send token. Empty means revoked: the device is no target and is never retried. */
	sendTokenCiphertext: string;
	/** The key id the phone registered with; goes in the payload for rotation. */
	kid: string;
	/** Uncompressed P-256 point, base64url. */
	publicKey: string;
	/** The reference the phone registered for this server. */
	clientServerRef: string;
	prefs: DevicePrefs;
}

/** Resolves who should hear about an event. S4 supplies the full policy; solo mode is "every active device". */
export interface PushTargetResolver {
	resolve(event: PushEvent): Promise<PushDevice[]>;
}

/** What the push service tells the rest of the server when the relay reports a device or activity gone. */
export interface PushRevocationSink {
	/** The relay said `gone:"device"`: revoke that device only. */
	deviceGone(device: PushDevice): Promise<void> | void;
	/** The relay said `gone:"activity"`: end that activity row only. */
	activityGone(device: PushDevice, slot: string): Promise<void> | void;
	/** The relay said 401: the send token is revoked or wrong. */
	tokenRejected(device: PushDevice): Promise<void> | void;
}

export interface PushLogger {
	info(message: string, fields?: Record<string, string | number | boolean>): void;
	warn(message: string, fields?: Record<string, string | number | boolean>): void;
}

export interface Clock {
	now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Logs with a fixed tag. Fields are flat scalars: callers pass identifiers and counts, never tokens, keys or payloads. */
export const consolePushLogger: PushLogger = {
	info: (message, fields) => console.log(formatLog(message, fields)),
	warn: (message, fields) => console.warn(formatLog(message, fields)),
};

function formatLog(message: string, fields?: Record<string, string | number | boolean>): string {
	const tail = fields
		? ` ${Object.entries(fields)
				.map(
					([k, v]) =>
						`${k}=${String(v)
							.replace(/[\r\n]/g, " ")
							.slice(0, 120)}`,
				)
				.join(" ")}`
		: "";
	return `[push] ${message}${tail}`;
}
