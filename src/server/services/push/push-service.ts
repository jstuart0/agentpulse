/**
 * Sends events to phones through the relay.
 *
 * `sendToDevices` is the alert path: it applies each device's prefs and quiet
 * hours, drops repeats and floods, shapes and seals one payload per device, and
 * posts it. `sendActivityUpdate` is the Live Activity path. The two never share
 * a queue or a worker, so a backed-up Live Activity cannot delay an alert.
 *
 * Limits, all in memory (a restart forgets them, and each replica counts for
 * itself; the relay enforces the real budgets):
 * - fan-out: at most 10 devices per user per event, 4 posts at a time;
 * - dedupe: the same event (type, thing, device) at most once in 60 s, over a
 *   bounded LRU of 10,000 keys;
 * - per category: at most 20 alerts an hour per device. Only the server knows
 *   the category, so the relay cannot enforce this one.
 *
 * Nothing here retries. A budget answer or an outage drops that push and says
 * so in the outcome; the next event gets a fresh chance.
 */
import { randomBytes } from "node:crypto";
import { stripAndRedact } from "../ai/redactor.js";
import { type RelayEnvelope, type SealError, sealPushPayload } from "./hpke-seal.js";
import {
	baseLevelFor,
	buildPushPayload,
	categoryFor,
	collapseIdFor,
	dedupeKeyFor,
	inQuietHours,
	isCategoryEnabled,
	relayPriorityFor,
	sessionKeyFor,
} from "./push-payload.js";
import type { LiveActivityRequest, RelayResult } from "./relay-client.js";
import {
	type Clock,
	type PushCategory,
	type PushDevice,
	type PushEvent,
	type PushLogger,
	type PushRevocationSink,
	type RelayPriority,
	consolePushLogger,
	systemClock,
} from "./types.js";

export const MAX_DEVICES_PER_USER = 10;
export const ALERT_CONCURRENCY = 4;
export const ACTIVITY_CONCURRENCY = 2;
export const DEDUPE_WINDOW_MS = 60_000;
export const DEDUPE_MAX_KEYS = 10_000;
export const CATEGORY_LIMIT_PER_HOUR = 20;
/** Categories that need the person get a bucket of their own, so completion and request traffic can't use it up. */
export const TIME_SENSITIVE_LIMIT_PER_HOUR = 40;
export const SESSION_LIMIT_PER_HOUR = 5;
export const TIME_SENSITIVE_SESSION_LIMIT_PER_HOUR = 10;
/** A session's first alert of the hour may go past a full category bucket, up to this multiple of it. */
export const NEW_SESSION_CEILING_MULTIPLE = 2;
export const SESSION_MAX_KEYS = 20_000;
export const HOLD_MAX_KEYS = 10_000;
const TIME_SENSITIVE_CATEGORIES: ReadonlySet<PushCategory> = new Set([
	"NEEDS_YOU_TURN",
	"NEEDS_YOU_PERMISSION",
	"WATCHER_HITL",
	"RISKY",
]);
export const CATEGORY_WINDOW_MS = 3_600_000;
export const CATEGORY_MAX_KEYS = 10_000;
export const ALERT_MAX_PENDING = 1_000;
export const ACTIVITY_MAX_PENDING = 500;
/** Mirrors the relay's per-token activity bucket (30 a minute, burst 10), so the server doesn't spend posts the relay will refuse. */
export const ACTIVITY_BURST = 10;
export const ACTIVITY_PER_MINUTE = 30;

/** What the relay client offers the service; a test double can implement it. */
export interface RelayPoster {
	postAlert(
		sendToken: string,
		request: { envelope: RelayEnvelope; priority: RelayPriority; collapseId?: string },
	): Promise<RelayResult>;
	postLiveActivity(sendToken: string, request: LiveActivityRequest): Promise<RelayResult>;
}

/** An alert that never reached the phone for a reason that may pass gives its dedupe and quota places back. */
export const REFUNDED_OUTCOMES: ReadonlySet<string> = new Set([
	"unavailable",
	"budget_limited",
	"invalid",
	"queue_full",
]);

/** The refunded outcomes where the relay may already have accepted the push, or refused it for budget: not safe to repeat at once. */
export const AMBIGUOUS_OUTCOMES: ReadonlySet<string> = new Set(["unavailable", "budget_limited"]);

export type AlertOutcome =
	| { deviceId: string; status: "sent"; pushId: string | null }
	| { deviceId: string; status: "skipped"; reason: "category_off" | "no_target" }
	| { deviceId: string; status: "deduped" }
	| { deviceId: string; status: "category_limited" }
	| { deviceId: string; status: "session_limited" }
	| { deviceId: string; status: "capped" }
	| { deviceId: string; status: "queue_full" }
	| { deviceId: string; status: "invalid"; reason: string }
	| { deviceId: string; status: "gone" }
	| { deviceId: string; status: "unauthorized" }
	| { deviceId: string; status: "budget_limited"; retryAfterSec: number | null }
	| { deviceId: string; status: "rejected"; httpStatus: number; error: string | null }
	| { deviceId: string; status: "unavailable" };

export type ActivityOutcome =
	| { deviceId: string; slot: string; status: "sent"; pushId: string | null }
	| { deviceId: string; slot: string; status: "coalesced" }
	| {
			deviceId: string;
			slot: string;
			status: "skipped";
			reason: "no_target" | "send_token_unreadable";
	  }
	| { deviceId: string; slot: string; status: "rate_limited" }
	| { deviceId: string; slot: string; status: "queue_full" }
	| { deviceId: string; slot: string; status: "activity_gone" }
	| { deviceId: string; slot: string; status: "device_gone" }
	| { deviceId: string; slot: string; status: "unauthorized" }
	| { deviceId: string; slot: string; status: "budget_limited"; retryAfterSec: number | null }
	| { deviceId: string; slot: string; status: "rejected"; httpStatus: number; error: string | null }
	| { deviceId: string; slot: string; status: "unavailable" };

export interface ActivityUpdate {
	slot: string;
	generation: number;
	event: "update" | "end";
	contentState: Record<string, unknown>;
	staleDate?: number;
	dismissalDate?: number;
}

export interface PushServiceOptions {
	relay: RelayPoster;
	revocations: PushRevocationSink;
	clock?: Clock;
	logger?: PushLogger;
	/** Redacts agent text before it is cut and sealed. Default: the server's own redactor. */
	redact?: (text: string) => string;
	/**
	 * Turns a device's stored send token into the bearer token. It runs right before each post and its result is
	 * never kept or logged. There is deliberately no default: sending the stored form would be a silent bug.
	 */
	readSendToken: (storedToken: string) => string | Promise<string>;
	/** Test seam for push ids. */
	newPushId?: () => string;
}

const defaultRedact = (text: string): string => stripAndRedact(text).text;
const defaultPushId = (): string => randomBytes(16).toString("base64url");

/** A bounded map that forgets the least recently set key first. */
class LruMap<V> {
	private readonly map = new Map<string, V>();
	constructor(private readonly max: number) {}
	get(key: string): V | undefined {
		return this.map.get(key);
	}
	set(key: string, value: V): void {
		this.map.delete(key);
		this.map.set(key, value);
		if (this.map.size > this.max) {
			const oldest = this.map.keys().next().value;
			if (oldest !== undefined) this.map.delete(oldest);
		}
	}
	delete(key: string): void {
		this.map.delete(key);
	}
	get size(): number {
		return this.map.size;
	}
}

/** 0 is served first. Alerts the relay calls needs-you take lane 0; everything else lane 1. */
type Lane = 0 | 1;

interface Waiting {
	start: () => void;
	drop: () => void;
}

/**
 * Runs jobs a few at a time from a bounded waiting line with two lanes. When the line is full a
 * newcomer displaces the oldest job of a strictly lower lane; with nothing lower to drop, the newcomer
 * is the one refused.
 */
export class WorkPool {
	private running = 0;
	private readonly lanes: Waiting[][] = [[], []];
	constructor(
		private readonly concurrency: number,
		private readonly maxPending: number,
	) {}

	/** Resolves with the job's result, or with "queue_full" if it was refused or displaced. */
	run<T>(job: () => Promise<T>, lane: Lane = 1): Promise<T | "queue_full"> {
		if (this.running >= this.concurrency && this.pending >= this.maxPending) {
			const victimLane = lane === 0 ? this.lanes[1] : undefined;
			const victim = victimLane?.shift();
			if (!victim) return Promise.resolve("queue_full");
			victim.drop();
		}
		return new Promise((resolve, reject) => {
			const start = () => {
				this.running += 1;
				job()
					.then(resolve, reject)
					.finally(() => {
						this.running -= 1;
						this.next();
					});
			};
			if (this.running < this.concurrency) start();
			else this.lanes[lane].push({ start, drop: () => resolve("queue_full") });
		});
	}

	private next(): void {
		const waiting = this.lanes[0].shift() ?? this.lanes[1].shift();
		waiting?.start();
	}

	get inFlight(): number {
		return this.running;
	}
	get pending(): number {
		return this.lanes[0].length + this.lanes[1].length;
	}
}

interface PendingActivity {
	device: PushDevice;
	update: ActivityUpdate;
	resolvers: ((outcome: ActivityOutcome) => void)[];
}

export class PushService {
	private readonly relay: RelayPoster;
	private readonly revocations: PushRevocationSink;
	private readonly readSendToken: (storedToken: string) => string | Promise<string>;
	private readonly clock: Clock;
	private readonly logger: PushLogger;
	private readonly redact: (text: string) => string;
	private readonly newPushId: () => string;

	private readonly alertPool = new WorkPool(ALERT_CONCURRENCY, ALERT_MAX_PENDING);
	private readonly dedupe = new LruMap<number>(DEDUPE_MAX_KEYS);
	private readonly categoryLog = new LruMap<number[]>(CATEGORY_MAX_KEYS);
	private readonly sessionLog = new LruMap<number[]>(SESSION_MAX_KEYS);
	/** Not-before times the relay asked for (Retry-After), per device and budget. */
	private readonly holds = new LruMap<number>(HOLD_MAX_KEYS);

	// The Live Activity line: one waiting entry per (device, slot), newest wins.
	private readonly activityWaiting = new Map<string, PendingActivity>();
	private activityRunning = 0;
	private readonly activityBuckets = new LruMap<{ tokens: number; at: number }>(CATEGORY_MAX_KEYS);

	/** Remembers how long the relay asked us to wait, so the next push isn't sent only to be refused again. */
	private hold(
		device: PushDevice,
		budget: "alert" | "activity",
		retryAfterSec: number | null,
	): void {
		if (retryAfterSec !== null && retryAfterSec > 0) {
			this.holds.set(`${device.id}|${budget}`, this.clock.now() + retryAfterSec * 1000);
		}
	}

	/**
	 * What a 401 does. Only the relay's own `{error:"unauthorized"}` (confirmed) says the send token
	 * is bad. A 401 from anything in front of the relay never revokes, however often it repeats: it is
	 * logged here, and the relay client has already opened its breaker.
	 */
	private async onUnauthorized(device: PushDevice, confirmed: boolean): Promise<void> {
		if (!confirmed) {
			this.logger.warn("relay answered 401 without its own error: not revoking", {
				device: device.id,
			});
			return;
		}
		await this.notify("send token rejected", () => this.revocations.tokenRejected(device), device);
	}

	/** The bearer token for one post, or null when the stored token cannot be read. Logs the device, never the token. */
	private async tokenFor(device: PushDevice): Promise<string | null> {
		try {
			return (await this.readSendToken(device.sendTokenCiphertext)) || null;
		} catch {
			this.logger.warn("send token unreadable", { device: device.id });
			return null;
		}
	}

	constructor(options: PushServiceOptions) {
		this.relay = options.relay;
		this.revocations = options.revocations;
		this.readSendToken = options.readSendToken;
		this.clock = options.clock ?? systemClock;
		this.logger = options.logger ?? consolePushLogger;
		this.redact = options.redact ?? defaultRedact;
		this.newPushId = options.newPushId ?? defaultPushId;
	}

	/** Alerts. One outcome per device, in the order given. Never throws. */
	async sendToDevices(devices: PushDevice[], event: PushEvent): Promise<AlertOutcome[]> {
		const category = categoryFor(event);
		const perUser = new Map<string, number>();
		const jobs = devices.map((device): Promise<AlertOutcome> => {
			const seen = perUser.get(device.userId) ?? 0;
			perUser.set(device.userId, seen + 1);
			if (seen >= MAX_DEVICES_PER_USER) {
				this.logger.warn("fan-out capped", {
					user: device.userId,
					cap: MAX_DEVICES_PER_USER,
					type: event.type,
				});
				return Promise.resolve({ deviceId: device.id, status: "capped" });
			}
			const admitted = this.admit(device, event, category);
			if ("outcome" in admitted) return Promise.resolve(admitted.outcome);
			return this.alertPool
				.run(
					() => this.deliverAlert(device, event, category, admitted),
					relayPriorityFor(admitted.level) === "needs-you" ? 0 : 1,
				)
				.then(
					(result): AlertOutcome =>
						result === "queue_full" ? { deviceId: device.id, status: "queue_full" } : result,
				)
				.catch((err: unknown): AlertOutcome => {
					this.logger.warn("alert delivery crashed", {
						device: device.id,
						error: err instanceof Error ? err.name : "unknown",
					});
					return { deviceId: device.id, status: "unavailable" };
				})
				.then((outcome) => {
					if (REFUNDED_OUTCOMES.has(outcome.status)) admitted.release();
					return outcome;
				});
		});
		return Promise.all(jobs);
	}

	/**
	 * Prefs, the relay's hold, dedupe, then the limits. A push that passes reserves its dedupe and quota places;
	 * `release` hands them back when the push never reached the phone (see REFUNDED_OUTCOMES).
	 */
	private admit(
		device: PushDevice,
		event: PushEvent,
		category: PushCategory,
	): { outcome: AlertOutcome } | { level: ReturnType<typeof baseLevelFor>; release: () => void } {
		if (!device.sendTokenCiphertext) {
			return { outcome: { deviceId: device.id, status: "skipped", reason: "no_target" } };
		}
		if (!isCategoryEnabled(device.prefs, category)) {
			return { outcome: { deviceId: device.id, status: "skipped", reason: "category_off" } };
		}
		const now = this.clock.now();

		const heldUntil = this.holds.get(`${device.id}|alert`);
		if (heldUntil !== undefined && now < heldUntil) {
			return {
				outcome: {
					deviceId: device.id,
					status: "budget_limited",
					retryAfterSec: Math.ceil((heldUntil - now) / 1000),
				},
			};
		}

		const dedupeKey = `${dedupeKeyFor(event)}|${device.id}`;
		const last = this.dedupe.get(dedupeKey);
		if (last !== undefined && now - last < DEDUPE_WINDOW_MS) {
			return { outcome: { deviceId: device.id, status: "deduped" } };
		}

		const timeSensitive = TIME_SENSITIVE_CATEGORIES.has(category);
		const categoryLimit = timeSensitive ? TIME_SENSITIVE_LIMIT_PER_HOUR : CATEGORY_LIMIT_PER_HOUR;
		const sessionLimit = timeSensitive
			? TIME_SENSITIVE_SESSION_LIMIT_PER_HOUR
			: SESSION_LIMIT_PER_HOUR;
		const categoryKey = `${device.id}|${category}`;
		const sessionKey = `${categoryKey}|${sessionKeyFor(event)}`;
		const inWindow = (log: number[] | undefined) =>
			(log ?? []).filter((t) => now - t < CATEGORY_WINDOW_MS);
		const sessionRecent = inWindow(this.sessionLog.get(sessionKey));
		const categoryRecent = inWindow(this.categoryLog.get(categoryKey));

		if (sessionRecent.length >= sessionLimit) {
			this.logger.warn("session limit reached", {
				device: device.id,
				category,
				perHour: sessionLimit,
			});
			return { outcome: { deviceId: device.id, status: "session_limited" } };
		}
		const firstOfSession = sessionRecent.length === 0;
		const ceiling = firstOfSession ? categoryLimit * NEW_SESSION_CEILING_MULTIPLE : categoryLimit;
		if (categoryRecent.length >= ceiling) {
			this.logger.warn("category limit reached", {
				device: device.id,
				category,
				perHour: categoryLimit,
			});
			return { outcome: { deviceId: device.id, status: "category_limited" } };
		}

		this.dedupe.set(dedupeKey, now);
		categoryRecent.push(now);
		this.categoryLog.set(categoryKey, categoryRecent);
		sessionRecent.push(now);
		this.sessionLog.set(sessionKey, sessionRecent);
		const release = () => {
			if (this.dedupe.get(dedupeKey) === now) this.dedupe.delete(dedupeKey);
			for (const [key, log] of [
				[categoryKey, this.categoryLog.get(categoryKey)],
				[sessionKey, this.sessionLog.get(sessionKey)],
			] as const) {
				const at = log?.indexOf(now) ?? -1;
				if (log && at >= 0) {
					log.splice(at, 1);
					if (key === categoryKey) this.categoryLog.set(key, log);
					else this.sessionLog.set(key, log);
				}
			}
		};
		return { level: inQuietHours(device.prefs, now) ? "passive" : baseLevelFor(event), release };
	}

	private async deliverAlert(
		device: PushDevice,
		event: PushEvent,
		category: PushCategory,
		admitted: { level: ReturnType<typeof baseLevelFor> },
	): Promise<AlertOutcome> {
		const pushId = this.newPushId();
		const built = buildPushPayload({
			event,
			device,
			pushId,
			nowMs: this.clock.now(),
			redact: this.redact,
			level: admitted.level,
		});
		if (!built.ok) {
			this.logger.warn("payload not built", {
				device: device.id,
				type: event.type,
				reason: built.reason,
			});
			return { deviceId: device.id, status: "invalid", reason: built.reason };
		}

		let sealed: Awaited<ReturnType<typeof sealPushPayload>>;
		try {
			sealed = await sealPushPayload(built.payload, {
				publicKey: device.publicKey,
				relayDeviceId: device.relayDeviceId,
			});
		} catch (err) {
			const code = (err as SealError).code ?? "seal_failed";
			this.logger.warn("seal failed", { device: device.id, type: event.type, code });
			return { deviceId: device.id, status: "invalid", reason: code };
		}
		if (sealed.trimmed.length > 0) {
			this.logger.info("payload trimmed to fit", {
				device: device.id,
				type: event.type,
				trimmed: sealed.trimmed.join(","),
			});
		}

		const token = await this.tokenFor(device);
		if (token === null) {
			return { deviceId: device.id, status: "invalid", reason: "send_token_unreadable" };
		}
		const result = await this.relay.postAlert(token, {
			envelope: sealed.envelope,
			priority: relayPriorityFor(admitted.level),
			collapseId: collapseIdFor(event, category),
		});
		return this.alertOutcome(device, event.type, result);
	}

	private async alertOutcome(
		device: PushDevice,
		type: string,
		result: RelayResult,
	): Promise<AlertOutcome> {
		switch (result.kind) {
			case "accepted":
				return { deviceId: device.id, status: "sent", pushId: result.pushId };
			case "gone":
				if (result.gone === "device") {
					await this.notify("device gone", () => this.revocations.deviceGone(device), device);
					return { deviceId: device.id, status: "gone" };
				}
				return { deviceId: device.id, status: "rejected", httpStatus: 410, error: null };
			case "unauthorized":
				await this.onUnauthorized(device, result.confirmed);
				return { deviceId: device.id, status: "unauthorized" };
			case "budget":
				this.hold(device, "alert", result.retryAfterSec);
				this.logger.warn("alert dropped: relay budget", {
					device: device.id,
					type,
					budget: result.budget,
				});
				return {
					deviceId: device.id,
					status: "budget_limited",
					retryAfterSec: result.retryAfterSec,
				};
			case "rejected":
				this.logger.warn("alert rejected by relay", {
					device: device.id,
					type,
					status: result.status,
					error: result.error ?? "",
				});
				return {
					deviceId: device.id,
					status: "rejected",
					httpStatus: result.status,
					error: result.error,
				};
			default:
				this.logger.warn("alert dropped: relay unavailable", { device: device.id, type });
				return { deviceId: device.id, status: "unavailable" };
		}
	}

	/**
	 * A Live Activity update for one device. Updates for the same slot that are
	 * still waiting are merged (the newest wins; an `end` is never overwritten by
	 * an update), the device is held to the relay's own activity rate, and the work
	 * runs on its own workers.
	 */
	sendActivityUpdate(device: PushDevice, update: ActivityUpdate): Promise<ActivityOutcome> {
		if (!device.sendTokenCiphertext) {
			return Promise.resolve({
				deviceId: device.id,
				slot: update.slot,
				status: "skipped",
				reason: "no_target",
			});
		}
		const key = `${device.id}|${update.slot}`;
		const slot = update.slot;

		const waiting = this.activityWaiting.get(key);
		if (waiting) {
			return new Promise((resolve) => {
				if (waiting.update.event === "end" && update.event !== "end") {
					resolve({ deviceId: device.id, slot, status: "coalesced" });
					return;
				}
				waiting.update = update;
				waiting.resolvers.push(resolve);
			});
		}
		if (
			this.activityWaiting.size >= ACTIVITY_MAX_PENDING &&
			this.activityRunning >= ACTIVITY_CONCURRENCY
		) {
			return Promise.resolve({ deviceId: device.id, slot, status: "queue_full" });
		}
		const heldUntil = this.holds.get(`${device.id}|activity`);
		if (heldUntil !== undefined && this.clock.now() < heldUntil) {
			return Promise.resolve({
				deviceId: device.id,
				slot,
				status: "budget_limited",
				retryAfterSec: Math.ceil((heldUntil - this.clock.now()) / 1000),
			});
		}
		if (!this.takeActivityToken(device.id)) {
			return Promise.resolve({ deviceId: device.id, slot, status: "rate_limited" });
		}
		return new Promise((resolve) => {
			this.activityWaiting.set(key, { device, update, resolvers: [resolve] });
			this.pumpActivities();
		});
	}

	private takeActivityToken(deviceId: string): boolean {
		const now = this.clock.now();
		const bucket = this.activityBuckets.get(deviceId) ?? { tokens: ACTIVITY_BURST, at: now };
		bucket.tokens = Math.min(
			ACTIVITY_BURST,
			bucket.tokens + ((now - bucket.at) * ACTIVITY_PER_MINUTE) / 60_000,
		);
		bucket.at = now;
		const allowed = bucket.tokens >= 1;
		if (allowed) bucket.tokens -= 1;
		this.activityBuckets.set(deviceId, bucket);
		return allowed;
	}

	private pumpActivities(): void {
		while (this.activityRunning < ACTIVITY_CONCURRENCY) {
			const next = this.activityWaiting.entries().next();
			if (next.done) return;
			const [key, entry] = next.value;
			this.activityWaiting.delete(key);
			this.activityRunning += 1;
			this.deliverActivity(entry)
				.catch((err: unknown): ActivityOutcome => {
					this.logger.warn("activity delivery crashed", {
						device: entry.device.id,
						error: err instanceof Error ? err.name : "unknown",
					});
					return { deviceId: entry.device.id, slot: entry.update.slot, status: "unavailable" };
				})
				.then((outcome) => {
					for (const resolve of entry.resolvers) resolve(outcome);
				})
				.finally(() => {
					this.activityRunning -= 1;
					this.pumpActivities();
				});
		}
	}

	private async deliverActivity(entry: PendingActivity): Promise<ActivityOutcome> {
		const { device, update } = entry;
		const base = { deviceId: device.id, slot: update.slot } as const;
		const token = await this.tokenFor(device);
		if (token === null) return { ...base, status: "skipped", reason: "send_token_unreadable" };
		const result = await this.relay.postLiveActivity(token, {
			slot: update.slot,
			generation: update.generation,
			event: update.event,
			contentState: update.contentState,
			...(update.staleDate !== undefined ? { staleDate: update.staleDate } : {}),
			...(update.dismissalDate !== undefined ? { dismissalDate: update.dismissalDate } : {}),
		});
		switch (result.kind) {
			case "accepted":
				return { ...base, status: "sent", pushId: result.pushId };
			case "gone":
				if (result.gone === "activity") {
					await this.notify(
						"activity gone",
						() => this.revocations.activityGone(device, update.slot),
						device,
					);
					return { ...base, status: "activity_gone" };
				}
				await this.notify("device gone", () => this.revocations.deviceGone(device), device);
				return { ...base, status: "device_gone" };
			case "unauthorized":
				await this.onUnauthorized(device, result.confirmed);
				return { ...base, status: "unauthorized" };
			case "budget":
				this.hold(device, "activity", result.retryAfterSec);
				this.logger.warn("activity dropped: relay budget", {
					device: device.id,
					budget: result.budget,
				});
				return { ...base, status: "budget_limited", retryAfterSec: result.retryAfterSec };
			case "rejected":
				this.logger.warn("activity rejected by relay", {
					device: device.id,
					status: result.status,
					error: result.error ?? "",
				});
				return { ...base, status: "rejected", httpStatus: result.status, error: result.error };
			default:
				this.logger.warn("activity dropped: relay unavailable", { device: device.id });
				return { ...base, status: "unavailable" };
		}
	}

	/** A revocation sink that throws must not turn a delivered answer into a crash. */
	private async notify(
		what: string,
		call: () => Promise<void> | void,
		device: PushDevice,
	): Promise<void> {
		try {
			await call();
		} catch (err) {
			this.logger.warn(`${what}: revocation failed`, {
				device: device.id,
				error: err instanceof Error ? err.name : "unknown",
			});
		}
	}

	/** Counters for diagnostics and tests. */
	stats(): {
		alertsInFlight: number;
		alertsWaiting: number;
		activitiesInFlight: number;
		activitiesWaiting: number;
		dedupeKeys: number;
		categoryKeys: number;
	} {
		return {
			alertsInFlight: this.alertPool.inFlight,
			alertsWaiting: this.alertPool.pending,
			activitiesInFlight: this.activityRunning,
			activitiesWaiting: this.activityWaiting.size,
			dedupeKeys: this.dedupe.size,
			categoryKeys: this.categoryLog.size,
		};
	}
}
