/**
 * The one call every push trigger makes: `void dispatchEvent(event)`.
 *
 * It is fire-and-forget. It never rejects and never throws, so a trigger sitting
 * in an ingest path can call it without a try/catch. It yields to the event loop
 * before the first read, so the trigger's own transaction has committed and its
 * response has been queued before any target lookup runs. When push is not set
 * up there is no runtime and the call returns at once, reading nothing.
 *
 * Devices are not notification channels: this path deliberately does not go
 * through the channel registry or add a channel kind.
 */
import { decryptSecretAsync } from "../ai/secrets.js";
import { categoryFor, dedupeKeyFor } from "./push-payload.js";
import { AMBIGUOUS_OUTCOMES, PushService, REFUNDED_OUTCOMES } from "./push-service.js";
import { RelayClient } from "./relay-client.js";
import {
	type PushDispatchContext,
	type PushEvent,
	type PushLogger,
	type PushRevocationSink,
	type PushTargetResolver,
	type SessionSnapshot,
	consolePushLogger,
} from "./types.js";

export interface PushRuntime {
	targets: PushTargetResolver;
	/** Adds the labels and status a trigger left out. A failure here sends the event as it was. */
	enrich?: (event: PushEvent, ctx: PushDispatchContext) => Promise<PushEvent>;
	/** Reads a session once for a dispatch; target resolution and enrichment share the answer. */
	readSession?: (sessionId: string) => Promise<SessionSnapshot | null>;
	service: Pick<PushService, "sendToDevices">;
	logger?: PushLogger;
}

let runtime: PushRuntime | null = null;

/** Installs (or, with null, removes) the push runtime. Called once at startup by whatever wires push in. */
export function configurePushRuntime(next: PushRuntime | null): void {
	runtime = next;
}

export function getPushRuntime(): PushRuntime | null {
	return runtime;
}

/** Builds the runtime for a configured relay: the client, the service and the given targeting and revocation. */
export function createPushRuntime(options: {
	relayUrl: string;
	targets: PushTargetResolver;
	revocations: PushRevocationSink;
	logger?: PushLogger;
}): PushRuntime {
	const logger = options.logger ?? consolePushLogger;
	const relay = new RelayClient({ relayUrl: options.relayUrl, logger });
	return {
		targets: options.targets,
		service: new PushService({
			relay,
			revocations: options.revocations,
			readSendToken: decryptSecretAsync,
			logger,
		}),
		logger,
	};
}

/**
 * What became of a dispatch, for the triggers that must know whether to try again (the health job).
 *  - `sent`: at least one phone was handed the push.
 *  - `settled`: it was judged and nothing more should be done now (already dispatched in the window, or every
 *    phone answered definitively: off, limited, capped, gone, refused, or a send whose outcome is unknown).
 *  - `retry`: it never got to a phone for a reason that may pass (over budget, nobody to tell yet, a failure,
 *    or every send refused before reaching the relay).
 */
export type DispatchResult = "sent" | "settled" | "retry";

/** Events being resolved or sent. Past this the newest are dropped: a stalled relay must not pile up work behind ingest. */
export const MAX_INFLIGHT_DISPATCHES = 500;
/** The top of that budget is kept for events that need the person, so a flood of the rest cannot crowd them out. */
export const TIME_SENSITIVE_HEADROOM = 100;
/**
 * In-flight events one origin (an ingest key's owner, or the key itself) may hold. Ingest-made events
 * (a permission wait, a finished turn) are in the needs-the-person category, so without this one noisy
 * key could fill the reserved headroom and crowd out everyone else's `hitl_opened`.
 */
export const MAX_INFLIGHT_PER_ORIGIN = 50;
/** The shared origin of ingest events that carry no key context (auth disabled, supervisor reports): one pool, one cap. */
export const ANON_ORIGIN = "anon";
/** The same event is dispatched at most once in this window, judged before any read. */
export const DISPATCH_DEDUPE_MS = 60_000;
/**
 * How long the dedupe key is kept after a send whose outcome is unknown (the relay may have taken the push
 * before it timed out) or that the relay's budget refused. Long enough that a repeat of the event doesn't
 * double-notify, short enough that a transient failure is still retried soon.
 */
export const DISPATCH_AMBIGUOUS_HOLD_MS = 7_000;
const DISPATCH_DEDUPE_MAX_KEYS = 10_000;
/** The "dropped" line is written at most this often, with how many it stands for. */
const DROP_LOG_EVERY_MS = 10_000;
const NEEDS_THE_PERSON: ReadonlySet<string> = new Set([
	"NEEDS_YOU_TURN",
	"NEEDS_YOU_PERMISSION",
	"WATCHER_HITL",
	"RISKY",
]);

let inflight = 0;
/** Bumped by the test reset, so a dispatch that began before it doesn't count itself out of the new tally. */
let epoch = 0;
const inflightByOrigin = new Map<string, number>();
const recent = new Map<string, number>();
let dropped = 0;
let lastDropLogAt = 0;

/** Test seam: forgets dedupe history and the drop log's pacing. */
export function _resetDispatchForTest(): void {
	epoch += 1;
	inflight = 0;
	recent.clear();
	inflightByOrigin.clear();
	dropped = 0;
	lastDropLogAt = 0;
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** True if this event was dispatched in the last window; records it otherwise. No I/O. */
function seenRecently(event: PushEvent, now: number): boolean {
	const key = dedupeKeyFor(event);
	const last = recent.get(key);
	if (last !== undefined && now - last < DISPATCH_DEDUPE_MS) return true;
	recent.delete(key);
	recent.set(key, now);
	if (recent.size > DISPATCH_DEDUPE_MAX_KEYS) {
		const oldest = recent.keys().next().value;
		if (oldest !== undefined) recent.delete(oldest);
	}
	return false;
}

/** Keeps the key, but only for `DISPATCH_AMBIGUOUS_HOLD_MS` more rather than the whole window. */
function holdBriefly(key: string): void {
	recent.delete(key);
	recent.set(key, Date.now() - DISPATCH_DEDUPE_MS + DISPATCH_AMBIGUOUS_HOLD_MS);
}

function noteDrop(logger: PushLogger, type: string, now: number): void {
	dropped += 1;
	if (now - lastDropLogAt < DROP_LOG_EVERY_MS) return;
	logger.warn("dispatch dropped: too many events in flight", { type, dropped });
	dropped = 0;
	lastDropLogAt = now;
}

/**
 * `origin` names who caused an ingest-made event; it is counted against `MAX_INFLIGHT_PER_ORIGIN`.
 * Ingest events with no key context use `ANON_ORIGIN`. Events the server makes for itself
 * (hitl, action requests, launches) pass none.
 */
export async function dispatchEvent(event: PushEvent, origin?: string): Promise<DispatchResult> {
	const current = runtime;
	if (!current) return "settled";
	const logger = current.logger ?? consolePushLogger;
	const now = Date.now();
	const budget = NEEDS_THE_PERSON.has(categoryFor(event))
		? MAX_INFLIGHT_DISPATCHES
		: MAX_INFLIGHT_DISPATCHES - TIME_SENSITIVE_HEADROOM;
	if (inflight >= budget) {
		noteDrop(logger, event.type, now);
		return "retry";
	}
	if (origin !== undefined && (inflightByOrigin.get(origin) ?? 0) >= MAX_INFLIGHT_PER_ORIGIN) {
		noteDrop(logger, event.type, now);
		return "retry";
	}
	if (seenRecently(event, now)) return "settled";
	inflight += 1;
	const startedInEpoch = epoch;
	if (origin !== undefined) inflightByOrigin.set(origin, (inflightByOrigin.get(origin) ?? 0) + 1);
	const dedupeKey = dedupeKeyFor(event);
	try {
		await yieldToEventLoop();
		const ctx = sharedContext(current);
		const devices = await current.targets.resolve(event, ctx);
		if (devices.length === 0) {
			recent.delete(dedupeKey); // nobody was told; a repeat after a device pairs may reach it
			return "retry";
		}
		const outcomes = await current.service.sendToDevices(
			devices,
			await enriched(current, event, ctx, logger),
		);
		// Every push came back refunded: the service gave back its own dedupe places. Give ours back too when
		// nothing could have reached a phone; when the relay may have accepted one (a timeout, a 5xx) or refused
		// it for budget, keep the key for a short back-off so an immediate repeat doesn't double-notify.
		if (outcomes.every((o) => REFUNDED_OUTCOMES.has(o.status))) {
			if (outcomes.some((o) => AMBIGUOUS_OUTCOMES.has(o.status))) holdBriefly(dedupeKey);
			else recent.delete(dedupeKey);
		}
		if (outcomes.some((o) => o.status === "sent")) return "sent";
		const repeatable = outcomes.every(
			(o) => REFUNDED_OUTCOMES.has(o.status) && !AMBIGUOUS_OUTCOMES.has(o.status),
		);
		return repeatable ? "retry" : "settled";
	} catch (err) {
		recent.delete(dedupeKey); // a dispatch that failed hasn't told anyone; a repeat may try again
		logger.warn("dispatch failed", {
			type: event.type,
			error: err instanceof Error ? err.name : "unknown",
		});
		return "retry";
	} finally {
		if (startedInEpoch === epoch) {
			inflight -= 1;
			if (origin !== undefined) releaseOrigin(origin);
		}
	}
}

function releaseOrigin(origin: string): void {
	const left = (inflightByOrigin.get(origin) ?? 1) - 1;
	if (left <= 0) inflightByOrigin.delete(origin);
	else inflightByOrigin.set(origin, left);
}

/** One lazy read of the session per dispatch, shared by whoever asks first. */
function sharedContext(runtime: PushRuntime): PushDispatchContext {
	const reads = new Map<string, Promise<SessionSnapshot | null>>();
	return {
		session: (sessionId) => {
			let read = reads.get(sessionId);
			if (!read) {
				read = runtime.readSession ? runtime.readSession(sessionId) : Promise.resolve(null);
				reads.set(sessionId, read);
			}
			return read;
		},
	};
}

async function enriched(
	runtime: PushRuntime,
	event: PushEvent,
	ctx: PushDispatchContext,
	logger: PushLogger,
): Promise<PushEvent> {
	if (!runtime.enrich) return event;
	try {
		return await runtime.enrich(event, ctx);
	} catch (err) {
		logger.warn("push enrichment failed: sending without it", {
			type: event.type,
			error: err instanceof Error ? err.name : "unknown",
		});
		return event;
	}
}
