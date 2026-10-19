import type { ServerWebSocket } from "bun";
import { eq, inArray } from "drizzle-orm";
import { WS_HEARTBEAT_INTERVAL_MS } from "../../shared/constants.js";
import type { Session, SessionEvent, WsMessage, WsMessageType } from "../../shared/types.js";
import type { Actor } from "../auth/actor.js";
import { SCOPE_ALL, getApiKeyLiveStates, getInactiveApiKeyIds } from "../auth/api-key.js";
import type { AuthUser } from "../auth/middleware.js";
import { resolveEffectiveRole, scopesIncludeManage } from "../auth/route-scope-policy.js";
import { getDb } from "../db/client.js";
import { sessions } from "../db/schema/index.js";
import { canReadSession } from "../services/authorization.js";
import { COMPACT_FIELD_MAX_BYTES, compactEvent } from "../services/event-compact.js";
import { type InstanceMode, getMode } from "../services/instance-mode.js";
import { getUserGateStates } from "../services/user-identity.js";
import { setWsRevalidationListener } from "./revalidation.js";
import type { WsConnectionData, WsProfile } from "./ws-auth.js";

/**
 * Close codes the server sends. A client treats them differently:
 *  - 4001: the credential is no longer valid (key revoked or deleted, user
 *    disabled, password change required). Reconnecting won't help; re-pair or sign in.
 *  - 4003: the credential is still valid but the authority behind it changed (the
 *    instance mode switched, or the key was handed to another owner). Reconnect
 *    and the socket is judged afresh.
 *  - 1011: the server couldn't decide (a database error while resolving
 *    authority); the socket is closed rather than left unjudged. Reconnect.
 */
export const WS_CLOSE_AUTH_REVOKED = 4001;
export const WS_CLOSE_AUTHORITY_CHANGED = 4003;
const WS_CLOSE_UNAVAILABLE = 1011;

/** Largest inbound frame the server accepts (a subscribe is a few hundred bytes). */
export const WS_MAX_INBOUND_BYTES = 16 * 1024;
/** Most channels one subscribe/unsubscribe message may name, and one socket may hold. */
export const WS_MAX_CHANNELS_PER_MESSAGE = 50;
export const WS_MAX_CHANNELS_PER_SOCKET = 200;
const WS_MAX_CHANNEL_NAME_LENGTH = 256;
/** Most sockets one API key may hold open at once (refused at the upgrade with 429). */
export const WS_MAX_SOCKETS_PER_KEY = 8;
/** Most session ids one sweep query names; a longer list is read in several queries. */
export const WS_SWEEP_QUERY_CHUNK = 500;
/** A rejected-subscribe frame is sent at most this often per socket, so rejecting can't be a flood of its own. */
const WS_REJECT_FRAME_MIN_INTERVAL_MS = 1000;
/** Subscribe/unsubscribe messages per socket: a burst, then a steady rate. */
const WS_MESSAGE_BURST = 20;
const WS_MESSAGES_PER_SECOND = 2;

interface WsClient {
	ws: ServerWebSocket<unknown>;
	channels: Set<string>;
	/** The user the connection is acting as: the cookie/SSO user, or an API key's owner. Null for DISABLE_AUTH, a service key, a supervisor credential. */
	userId: string | null;
	/** The API key the connection authenticated with, null when it didn't use one. */
	keyId: string | null;
	profile: WsProfile;
	/**
	 * True for a key without manage: it may subscribe only to `sessions` and to
	 * `session:<id>` channels it can read, never `*`, and in team mode sees only
	 * the sessions `canReadSession` allows. Everyone else keeps the unfiltered feed.
	 */
	restricted: boolean;
	/** A restricted socket's current authority; null until resolved (nothing is delivered meanwhile). */
	reader: RestrictedReader | null;
	/** Bumped by every restricted sweep, so a subscribe judged against older state can tell and look again. */
	epoch: number;
	/** Token bucket for control messages. */
	tokens: number;
	tokensAt: number;
	rejectedAt: number;
}

interface RestrictedReader {
	actor: Actor;
	mode: InstanceMode;
}

/** Per-field budget on a mobile socket's event payload. */
const MOBILE_FIELD_MAX_BYTES = COMPACT_FIELD_MAX_BYTES;
const SESSION_CHANNEL_PREFIX = "session:";

const clients = new Map<ServerWebSocket<unknown>, WsClient>();

// Handle new WebSocket connection. The identity was resolved at upgrade
// time (guardWsUpgrade) and rides on `ws.data`; a socket opened without it
// (none in production) is treated as having no user, no key and full read access.
// A restricted socket's authority is resolved before this settles; until then
// nothing is delivered to it.
export async function handleWsOpen(ws: ServerWebSocket<unknown>): Promise<void> {
	const data = ws.data as Partial<WsConnectionData> | undefined;
	const scopes = data?.scopes ?? [SCOPE_ALL];
	const client: WsClient = {
		ws,
		channels: new Set(["sessions"]),
		userId: data?.userId ?? null,
		keyId: data?.keyId ?? null,
		profile: data?.profile ?? "web",
		restricted: !scopesIncludeManage(scopes),
		reader: null,
		epoch: 0,
		tokens: WS_MESSAGE_BURST,
		tokensAt: Date.now(),
		rejectedAt: 0,
	};
	clients.set(ws, client);
	console.log(`[ws] Client connected (${clients.size} total)`);
	if (!client.restricted) return;
	try {
		await refreshRestrictedReaders([client]);
	} catch (err) {
		logSweepFailure("ws_open_authorization_failed", err);
		closeClient(client, "authorization_unavailable", WS_CLOSE_UNAVAILABLE);
	}
}

function takeToken(client: WsClient): boolean {
	const now = Date.now();
	client.tokens = Math.min(
		WS_MESSAGE_BURST,
		client.tokens + ((now - client.tokensAt) / 1000) * WS_MESSAGES_PER_SECOND,
	);
	client.tokensAt = now;
	if (client.tokens < 1) return false;
	client.tokens -= 1;
	return true;
}

/** How many sockets this key holds open right now (for the per-key cap at upgrade). */
export function openSocketCountForKey(keyId: string): number {
	let count = 0;
	for (const client of clients.values()) if (client.keyId === keyId) count++;
	return count;
}

/**
 * Tells a client its subscribe was not applied, so it isn't left believing it is
 * subscribed. One small frame, at most once a second per socket. Clients ignore
 * message types they don't know.
 */
function rejectSubscribe(
	client: WsClient,
	reason: "rate_limited" | "invalid_channels" | "too_many_channels" | "channel_limit",
): void {
	const now = Date.now();
	if (now - client.rejectedAt < WS_REJECT_FRAME_MIN_INTERVAL_MS) return;
	client.rejectedAt = now;
	try {
		client.ws.send(JSON.stringify({ type: "subscribe_rejected", reason }));
	} catch {
		// Client disconnected, will be cleaned up on close
	}
}

/** The channel names in a message, or null when the message is malformed or too big. */
function channelsOf(msg: WsMessage): string[] | null {
	if (!Array.isArray(msg.channels) || msg.channels.length > WS_MAX_CHANNELS_PER_MESSAGE)
		return null;
	return msg.channels.filter(
		(channel): channel is string =>
			typeof channel === "string" && channel.length <= WS_MAX_CHANNEL_NAME_LENGTH,
	);
}

function addChannel(client: WsClient, channel: string): void {
	if (client.channels.has(channel)) return;
	if (client.channels.size < WS_MAX_CHANNELS_PER_SOCKET) client.channels.add(channel);
	else rejectSubscribe(client, "channel_limit");
}

/**
 * Handle an incoming message. A full-access socket's subscribe is applied before
 * this returns; a restricted socket's `session:<id>` subscribe waits on one
 * read of the session, so the returned promise settles when it has been judged.
 * An unauthorized subscribe is dropped without a reply.
 */
export async function handleWsMessage(
	ws: ServerWebSocket<unknown>,
	message: string | Buffer,
): Promise<void> {
	try {
		const msg = JSON.parse(typeof message === "string" ? message : message.toString()) as WsMessage;

		const client = clients.get(ws);
		if (!client) return;
		if (msg.type !== "subscribe" && msg.type !== "unsubscribe") return;
		const subscribing = msg.type === "subscribe";
		if (!takeToken(client)) {
			if (subscribing) rejectSubscribe(client, "rate_limited");
			return;
		}
		const channels = channelsOf(msg);
		if (!channels) {
			if (subscribing) {
				rejectSubscribe(
					client,
					Array.isArray(msg.channels) ? "too_many_channels" : "invalid_channels",
				);
			}
			return;
		}

		if (msg.type === "unsubscribe") {
			for (const channel of channels) client.channels.delete(channel);
			return;
		}

		const pending: string[] = [];
		for (const channel of channels) {
			if (!client.restricted) addChannel(client, channel);
			else if (channel === "sessions") addChannel(client, channel);
			else if (isSessionChannel(channel)) pending.push(channel);
			// anything else, `*` included, is manage-only and dropped
		}
		if (pending.length > 0) await subscribeReadable(client, pending);
	} catch {
		// Ignore malformed messages
	}
}

function isSessionChannel(channel: unknown): channel is string {
	return (
		typeof channel === "string" &&
		channel.startsWith(SESSION_CHANNEL_PREFIX) &&
		channel.length > SESSION_CHANNEL_PREFIX.length
	);
}

/**
 * Adds the channels this restricted socket can read right now. The decision is
 * made against state read after the socket's epoch was noted; if a sweep ran in
 * between, the state may be older than the change that prompted it, so the
 * subscribe looks again (and is dropped if it can't settle).
 */
async function subscribeReadable(client: WsClient, channels: string[]): Promise<void> {
	for (let attempt = 0; attempt < 3; attempt++) {
		// Always fresh: a key revoked since the socket opened ends it here.
		try {
			await refreshRestrictedReaders([client]);
		} catch (err) {
			logSweepFailure("ws_subscribe_authorization_failed", err);
			closeClient(client, "authorization_unavailable", WS_CLOSE_UNAVAILABLE);
			return;
		}
		if (!clients.has(client.ws)) return;
		const epoch = client.epoch;
		const owners = await sessionOwners(channels.map(sessionIdOf));
		const reader = client.reader;
		if (!reader || !clients.has(client.ws)) return;
		if (client.epoch !== epoch) continue;
		for (const channel of channels) {
			const row = owners.get(sessionIdOf(channel));
			if (row && canReadSession(reader.actor, row)) addChannel(client, channel);
		}
		return;
	}
}

function sessionIdOf(channel: string): string {
	return channel.slice(SESSION_CHANNEL_PREFIX.length);
}

async function sessionOwners(
	sessionIds: readonly string[],
): Promise<Map<string, { ownerUserId: string | null }>> {
	const owners = new Map<string, { ownerUserId: string | null }>();
	const unique = [...new Set(sessionIds)];
	for (let start = 0; start < unique.length; start += WS_SWEEP_QUERY_CHUNK) {
		const chunk = unique.slice(start, start + WS_SWEEP_QUERY_CHUNK);
		const rows = await getDb()
			.select({ sessionId: sessions.sessionId, ownerUserId: sessions.ownerUserId })
			.from(sessions)
			.where(
				chunk.length === 1
					? eq(sessions.sessionId, chunk[0] as string)
					: inArray(sessions.sessionId, chunk),
			);
		for (const row of rows) owners.set(row.sessionId, { ownerUserId: row.ownerUserId });
	}
	return owners;
}

// Handle WebSocket close
export function handleWsClose(ws: ServerWebSocket<unknown>) {
	clients.delete(ws);
	console.log(`[ws] Client disconnected (${clients.size} total)`);
}

// Broadcast a message to all connected clients subscribed to relevant channels.
// A web-profile socket gets the message as is. A mobile-profile socket gets a
// trimmed copy (serialized once per event) and never a `new_event` on the
// `sessions` channel; a restricted socket additionally sees only sessions its
// reader may read.
export function broadcast(type: WsMessageType, data: unknown, channel = "sessions") {
	let full: string | undefined;
	let mobile: string | undefined;

	for (const client of clients.values()) {
		if (!client.channels.has(channel) && !client.channels.has("*")) continue;
		let message: string;
		if (client.profile === "mobile") {
			if (type === "new_event" && channel === "sessions") continue;
			if (client.restricted && !mayReceive(client, type, data, channel)) continue;
			message = mobile ??= JSON.stringify({ type, data: shapeForMobile(type, data) });
		} else {
			message = full ??= JSON.stringify({ type, data });
		}
		try {
			client.ws.send(message);
		} catch {
			// Client disconnected, will be cleaned up on close
		}
	}
}

/** What an `inbox_changed` is about, so a restricted socket is told only about changes it could see. */
export type InboxChangeSubject = { sessionId: string } | { adminOnly: true };

/**
 * Tells connected clients their inbox may have changed. The message is `{at}` and nothing
 * else: no ids, no kinds; the client re-reads the inbox, which is filtered for it. A dashboard
 * socket always hears it. A restricted socket hears it in solo mode, and in team mode only when
 * the change concerns a session its reader may read (or, for an action request, when the
 * reader is an admin), so one member cannot watch another's inbox activity.
 */
export async function broadcastInboxChanged(subject: InboxChangeSubject): Promise<void> {
	const message = JSON.stringify({
		type: "inbox_changed",
		data: { at: new Date().toISOString() },
	});
	const listening = [...clients.values()].filter(
		(client) => client.channels.has("sessions") || client.channels.has("*"),
	);
	let owner: { ownerUserId?: string | null } | undefined;
	let ownerRead = false;
	for (const client of listening) {
		if (client.restricted) {
			const reader = client.reader;
			if (!reader) continue;
			if (reader.mode !== "solo") {
				if ("adminOnly" in subject) {
					if (reader.actor.role !== "admin") continue;
				} else {
					if (!ownerRead) {
						owner = await sessionOwnerForInbox(subject.sessionId);
						ownerRead = true;
					}
					if (!canReadSession(reader.actor, owner ?? {})) continue;
				}
			}
		}
		try {
			client.ws.send(message);
		} catch {
			// Client disconnected, will be cleaned up on close
		}
	}
}

/** The session's owner field as `canReadSession` wants it: absent for a session that can't be found. */
async function sessionOwnerForInbox(
	sessionId: string,
): Promise<{ ownerUserId?: string | null } | undefined> {
	const [row] = await getDb()
		.select({ ownerUserId: sessions.ownerUserId })
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	return row ? { ownerUserId: row.ownerUserId ?? null } : undefined;
}

/**
 * Restricted sockets get an explicit allow-list; any other message type is
 * denied, so a new broadcast type is private until someone decides otherwise.
 *  - session_created / session_updated / session_ended: only with an `ownerUserId`
 *    present on the row (null is "unowned", missing is "unknown" and denied) and
 *    only when the socket's reader may read that session.
 *  - new_event: only on a `session:<id>` channel the socket subscribed to (the
 *    subscription is the authorization).
 *  - stats_updated: team-wide counts, so solo only.
 */
function mayReceive(
	client: WsClient,
	type: WsMessageType,
	data: unknown,
	channel: string,
): boolean {
	const reader = client.reader;
	if (!reader) return false;
	switch (type) {
		case "session_created":
		case "session_updated":
		case "session_ended": {
			const session = (data as { session?: { ownerUserId?: string | null } } | null)?.session;
			if (!session || session.ownerUserId === undefined) return false;
			return canReadSession(reader.actor, session);
		}
		case "new_event":
			return isSessionChannel(channel);
		case "stats_updated":
			return reader.mode === "solo";
		default:
			return false;
	}
}

/** What a phone gets of an event: the compact form (see event-compact.ts). */
function shapeForMobile(type: WsMessageType, data: unknown): unknown {
	if (type !== "new_event" || data === null || typeof data !== "object") return data;
	return compactEvent(data, MOBILE_FIELD_MAX_BYTES);
}

// Broadcast to a specific session channel
export function broadcastToSession(sessionId: string, type: WsMessageType, data: unknown) {
	broadcast(type, data, `session:${sessionId}`);
	broadcast(type, data, "sessions"); // Also broadcast to the sessions list channel
}

// Send heartbeats to keep connections alive
export function startHeartbeat() {
	setInterval(() => {
		sendHeartbeats();
		void heartbeatTick();
	}, WS_HEARTBEAT_INTERVAL_MS);
}

/** One heartbeat to every open socket. Exported so a test can sum what actually goes out. */
export function sendHeartbeats(): void {
	const message = JSON.stringify({ type: "heartbeat", data: { timestamp: Date.now() } });
	for (const client of clients.values()) {
		try {
			client.ws.send(message);
		} catch {
			// Will be cleaned up on close
		}
	}
}

function closeClient(client: WsClient, reason: string, code = WS_CLOSE_AUTH_REVOKED): void {
	try {
		client.ws.close(code, reason);
	} catch {
		// Already closed/closing — nothing left to do.
	}
	clients.delete(client.ws);
}

/**
 * Close every open socket belonging to a user. Runs on disable and
 * whenever must_change_password is set. Idempotent — a user with no open
 * sockets is a no-op.
 */
export function closeSocketsForUser(userId: string): void {
	for (const client of [...clients.values()]) {
		if (client.userId === userId) closeClient(client, "account_disabled");
	}
}

/**
 * One heartbeat-interval sweep: re-checks, in two batched queries, every
 * connected user's disabled/must-change-password state and every
 * connected key's active flag, and closes any socket whose identity is now
 * gated. This is what bounds "a replica that didn't handle the disable" to
 * one heartbeat interval. Never rejects: a database error is logged and the
 * sweep is retried on the next tick (sockets stay as they were). Exported
 * separately from startHeartbeat's setInterval wrapper so a test can invoke
 * exactly one sweep instead of waiting WS_HEARTBEAT_INTERVAL_MS.
 *
 * It also re-judges every restricted (respond) socket: a revoked, deleted or
 * re-owned key, or an instance mode that changed since it connected, closes the
 * socket (4001); a `session:<id>` subscription whose session the socket can no
 * longer read is dropped. The same sweep runs at once when ownership, a role, the
 * mode or a key changes (requestWsRevalidation).
 */
export async function heartbeatTick(): Promise<void> {
	// Separate attempts: a failure in one sweep must not skip the other.
	try {
		await sweepGatedIdentities();
	} catch (err) {
		logSweepFailure("ws_heartbeat_failed", err);
	}
	try {
		await sweepRestrictedSockets();
	} catch (err) {
		logSweepFailure("ws_restricted_sweep_failed", err);
	}
}

function logSweepFailure(kind: string, err: unknown): void {
	console.error(
		JSON.stringify({
			kind,
			level: "error",
			error: err instanceof Error ? err.message : String(err),
		}),
	);
}

async function sweepGatedIdentities(): Promise<void> {
	const userIds = new Set<string>();
	const keyIds = new Set<string>();
	for (const client of clients.values()) {
		if (client.userId) userIds.add(client.userId);
		if (client.keyId) keyIds.add(client.keyId);
	}
	if (userIds.size === 0 && keyIds.size === 0) return;

	const [userStates, inactiveKeyIds] = await Promise.all([
		getUserGateStates([...userIds]),
		getInactiveApiKeyIds([...keyIds]),
	]);

	for (const client of [...clients.values()]) {
		if (client.keyId && inactiveKeyIds.has(client.keyId)) {
			closeClient(client, "api_key_revoked");
			continue;
		}
		const state = client.userId ? userStates.get(client.userId) : undefined;
		if (!state) continue; // no user, or a deleted one — nothing to reconcile here
		if (state.disabled) closeClient(client, "account_disabled");
		else if (state.mustChangePassword) closeClient(client, "password_change_required");
	}
}

setWsRevalidationListener(heartbeatTick);

/**
 * The restricted sockets' authority from live state. A deleted or deactivated
 * key ends the socket (4001); a key handed to someone else, or an instance
 * mode that changed since the socket connected, ends it with 4003 (reconnect
 * and be judged afresh).
 *
 * The role comes from `resolveEffectiveRole`, so a respond key owned by an
 * admin resolves to admin: it can read every session in team mode, exactly as
 * that admin's other keys can. Scope narrows what a key may call, not who owns it.
 */
async function refreshRestrictedReaders(targets: WsClient[]): Promise<void> {
	const withKeys = targets.filter((client) => client.restricted);
	if (withKeys.length === 0) return;
	const [keyStates, mode] = await Promise.all([
		getApiKeyLiveStates([...new Set(withKeys.flatMap((c) => (c.keyId ? [c.keyId] : [])))]),
		getMode(),
	]);
	for (const client of withKeys) {
		const state = client.keyId ? keyStates.get(client.keyId) : undefined;
		if (!state?.isActive) {
			closeClient(client, "api_key_revoked");
			continue;
		}
		if (state.ownerUserId !== client.userId) {
			closeClient(client, "api_key_owner_changed", WS_CLOSE_AUTHORITY_CHANGED);
			continue;
		}
		if (client.reader && client.reader.mode !== mode) {
			closeClient(client, "instance_mode_changed", WS_CLOSE_AUTHORITY_CHANGED);
			continue;
		}
		const identity: AuthUser = {
			source: "api_key",
			name: "ws",
			userId: client.userId,
			keyId: client.keyId,
			scopes: [],
			mustChangePassword: false,
			displayName: null,
			ownerRole: state.ownerRole,
		};
		const role = await resolveEffectiveRole(identity, mode);
		client.reader = { actor: { userId: client.userId, label: "api_key", role, mode }, mode };
	}
}

async function sweepRestrictedSockets(): Promise<void> {
	const restricted = [...clients.values()].filter((client) => client.restricted);
	if (restricted.length === 0) return;
	for (const client of restricted) client.epoch++;
	await refreshRestrictedReaders(restricted);
	// A subscribe judged before the readers were refreshed looks again.
	for (const client of restricted) client.epoch++;

	// Only the subscriptions that existed now are judged; one added while this
	// sweep runs was judged on its own and isn't ours to drop.
	const held = new Map(
		restricted.map((client) => [client, [...client.channels].filter(isSessionChannel)] as const),
	);
	const owners = await sessionOwners([...held.values()].flat().map(sessionIdOf));
	for (const [client, channels] of held) {
		const reader = client.reader;
		if (!reader || !clients.has(client.ws)) continue;
		for (const channel of channels) {
			const row = owners.get(sessionIdOf(channel));
			if (!row || !canReadSession(reader.actor, row)) client.channels.delete(channel);
		}
	}
}

/** The server's WebSocket handlers and limits, shared by the real server and the tests that drive it. */
export const wsHandlers = {
	open: handleWsOpen,
	message: handleWsMessage,
	close: handleWsClose,
	maxPayloadLength: WS_MAX_INBOUND_BYTES,
};

// Get current connection count
export function getConnectionCount(): number {
	return clients.size;
}

// A-M3: sessionBus-subscriber interface. This interface is the minimal
// subset of EventEmitter<SessionBusEvents> that initWsBroadcaster needs,
// expressed as a structural type so ws/handler has no import dependency on
// notifier (which imports broadcast from here — keeping the graph acyclic).
interface SessionBusLike {
	on(event: "session_created", listener: (session: Session) => void): void;
	on(event: "session_updated", listener: (session: Session) => void): void;
	on(
		event: "session_event",
		listener: (payload: { sessionId: string; event: SessionEvent }) => void,
	): void;
}

// M1: track which bus instances have already been wired. Using a WeakSet so
// each distinct bus object can be initialized exactly once — this allows tests
// to use independent FakeBus instances while still preventing double-init of
// the production singleton.
const initializedBuses = new WeakSet<object>();

/** How long a push waits for its machine lookup before going out unstamped. */
export const WS_ANNOTATE_TIMEOUT_MS = 250;
/** Most machine lookups allowed in flight at once; past it pushes go out unstamped without asking. */
export const WS_ANNOTATE_MAX_IN_FLIGHT = 200;

export interface WsBroadcasterOptions {
	annotate?: (session: Session) => Promise<Session>;
	annotateTimeoutMs?: number;
	annotateMaxInFlight?: number;
}

/**
 * Wire up the WS broadcaster as a single subscriber on the in-process
 * session bus. Call once at startup (index.ts). notifier.ts only emits
 * to sessionBus; this function fans those events out to WS clients.
 *
 * A-M3: sessionBus is now the single source of truth for WS broadcasts.
 * notifier.ts no longer calls broadcast() or broadcastToSession() directly
 * for session-state events — only notifyChannel() retains a direct call
 * for channel-typed messages that have no session-state semantics.
 *
 * M1: idempotent — calling with the same bus object a second time is a no-op
 * (logs a warning). Prevents listener accumulation on hot-reload or accidental
 * double-init.
 *
 * `annotate` adds what a pushed session row can't carry itself (its machine,
 * which the composition root supplies). The broadcaster stays ignorant of how.
 * Order matters only within one session (its creation must reach a dashboard
 * before its first event), so each session has its own short chain: a slow
 * lookup holds up that session's later pushes and nothing else, and an event for
 * a session with nothing pending is sent at once. A lookup is given up on after a
 * short timeout (the row goes out as it was; the dashboard reads a missing
 * machine as "can't tell"), and at most a bounded number are in flight, so a
 * hung database can neither stall the live feed nor grow a queue. A lookup that
 * fails sends the row as it was. Without `annotate` every push is sent at once,
 * untouched.
 */
export function initWsBroadcaster(bus: SessionBusLike, options?: WsBroadcasterOptions): void {
	if (initializedBuses.has(bus)) {
		console.warn(JSON.stringify({ kind: "ws_broadcaster_double_init", level: "warn" }));
		return;
	}
	initializedBuses.add(bus);

	const annotate = options?.annotate;
	const timeoutMs = options?.annotateTimeoutMs ?? WS_ANNOTATE_TIMEOUT_MS;
	const maxInFlight = options?.annotateMaxInFlight ?? WS_ANNOTATE_MAX_IN_FLIGHT;
	const chains = new Map<string, Promise<void>>();
	let inFlight = 0;

	const sendInOrder = (sessionId: string, send: () => void | Promise<void>) => {
		const next = (chains.get(sessionId) ?? Promise.resolve()).then(send).catch(() => undefined);
		chains.set(sessionId, next);
		void next.then(() => {
			if (chains.get(sessionId) === next) chains.delete(sessionId);
		});
	};

	/** The row with its machine, or as it was when the lookup fails, hangs or isn't allowed. */
	const stamped = (session: Session): Promise<Session> => {
		if (!annotate || inFlight >= maxInFlight) return Promise.resolve(session);
		inFlight += 1;
		const lookup = annotate(session);
		void lookup.then(
			() => {
				inFlight -= 1;
			},
			() => {
				inFlight -= 1;
			},
		);
		return new Promise<Session>((resolve) => {
			const timer = setTimeout(() => resolve(session), timeoutMs);
			lookup.then(
				(row) => {
					clearTimeout(timer);
					resolve(row);
				},
				(err) => {
					clearTimeout(timer);
					console.error(
						JSON.stringify({
							kind: "ws_annotate_failed",
							level: "error",
							error: err instanceof Error ? err.message : String(err),
						}),
					);
					resolve(session);
				},
			);
		});
	};

	const pushSession = (type: "session_created" | "session_updated", session: Session) => {
		if (!annotate) {
			broadcast(type, { session });
			return;
		}
		const ready = stamped(session);
		sendInOrder(session.sessionId, async () => broadcast(type, { session: await ready }));
	};

	bus.on("session_created", (session) => pushSession("session_created", session));

	bus.on("session_updated", (session) => pushSession("session_updated", session));

	bus.on("session_event", ({ sessionId, event }) => {
		if (annotate && chains.has(sessionId)) {
			sendInOrder(sessionId, () => broadcastToSession(sessionId, "new_event", event));
			return;
		}
		broadcastToSession(sessionId, "new_event", event);
	});
}
