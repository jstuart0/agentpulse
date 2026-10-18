/**
 * Keeps the Live Activities phones follow up to date.
 *
 * A phone tells the server which session it follows on the Lock Screen
 * (`POST /devices/:id/activities`); this module then pushes that session's
 * state to the phone's activity through the relay. The state is the closed
 * `live-activity-state` contract: status, when it began, the tool count and a
 * 24-bucket activity trace (75 seconds a bucket). Nothing else ever leaves.
 *
 * What it sends, and when:
 * - a status change goes out at once;
 * - the trace and tool count go out when events happened, at most every 75
 *   seconds per session, and only while the device's relay budget allows (a
 *   refusal holds trace updates back and the next pass tries again);
 * - the activity ends on completion (the phone keeps it for 15 minutes), on
 *   archive, on the relay's `gone:activity`, after 8 hours, or when the device
 *   stops being eligible.
 *
 * Eligibility is judged before every send, the same rule as alerts: the device
 * is live, its key is active and still its owner's, the owner isn't disabled,
 * and in team mode the owner can still read the session. A device that lost
 * only its read access (the session was handed to someone else) is sent an
 * `end`. A device that is revoked, whose key was revoked or whose owner was
 * disabled has no send token left to use, so its activity is only closed here.
 *
 * Session events are cheap on the hot path: only sessions someone follows are
 * tracked, and a handler for any other session returns after one map lookup.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getOperationalStatus } from "../../../shared/session-state.js";
import type { Session, SessionEvent } from "../../../shared/types.js";
import { getDb } from "../../db/client.js";
import { mobileDeviceActivities, sessions } from "../../db/schema/index.js";
import { withTransaction } from "../../db/with-transaction.js";
import { observeWsRevalidation } from "../../ws/revalidation.js";
import { getMode } from "../instance-mode.js";
import type { SessionBus } from "../notifier.js";
import { getEligibleDevice, listEligibleDevices } from "./device-source.js";
import { IntervalScheduler, type PushScheduler } from "./push-scheduler.js";
import type { ActivityOutcome, PushService } from "./push-service.js";
import {
	type EligibleDevice,
	type InstanceModeReader,
	canDeviceReadSession,
} from "./push-targets.js";
import {
	type Clock,
	type PushLogger,
	type PushSessionStatus,
	consolePushLogger,
	systemClock,
} from "./types.js";

export const TRACE_BUCKETS = 24;
export const BUCKET_MS = 75_000;
export const TRACE_COUNT_MAX = 9_999;
export const ACTIVITY_MAX_AGE_MS = 8 * 60 * 60 * 1000;
/** How long the phone keeps a finished activity on the Lock Screen. */
export const COMPLETED_DISMISSAL_SEC = 15 * 60;
/** An activity that hears nothing for this long shows as stale on the phone. */
export const STALE_AFTER_SEC = 15 * 60;
export const PUBLISHER_INTERVAL_MS = 15_000;
/** How long trace updates wait after the relay refused one and gave no better hint. */
export const BACKOFF_MS = 30_000;
export const MAX_LIVE_ACTIVITIES_PER_DEVICE = 8;

/** Sessions looked up per owner query. */
const OWNER_READ_CHUNK = 500;
/** Refusals in a row, saying the activity is not there, after which the follow is finished. */
const REJECTS_BEFORE_FINISH = 2;
const NOT_THERE_ERRORS = new Set(["unknown_slot", "stale_generation"]);
const STATUS_SINCE_MIN = 1_700_000_000;
const STATUS_SINCE_MAX = 4_102_444_800;
const TOOL_COUNT_MAX = 1_000_000;
const FALLBACK_BACKOFF = new Set(["rate_limited", "budget_limited", "queue_full", "unavailable"]);
const ROW_FINISHED = new Set(["activity_gone", "device_gone", "unauthorized"]);

/** One followed session on one device. */
export interface LiveActivityRow {
	deviceId: string;
	sessionId: string;
	slot: string;
	generation: number;
	startedAtMs: number;
}

export interface ActivityStore {
	liveRows(): Promise<LiveActivityRow[]>;
	endRow(deviceId: string, sessionId: string, atIso: string): Promise<void>;
}

/** What the publisher needs to know about a session. */
export interface SessionView {
	ownerUserId: string | null;
	status: PushSessionStatus;
	toolCount: number;
	archived: boolean;
}

export interface PublisherDeps {
	service: Pick<PushService, "sendActivityUpdate">;
	store: ActivityStore;
	readSession(sessionId: string): Promise<SessionView | null>;
	eligibleDevices(): Promise<EligibleDevice[]>;
	eligibleDevice(deviceId: string): Promise<EligibleDevice | null>;
	/** The current owner of each session, in one query. A session that no longer exists is absent from the answer. */
	readOwners(sessionIds: string[]): Promise<Map<string, string | null>>;
	/** The signal that someone's authority just changed (a handover, a role, a disabled user). Returns the unsubscribe. */
	observeRevalidation?(observer: () => Promise<void>): () => void;
	mode: InstanceModeReader;
	bus: Pick<SessionBus, "on" | "off">;
	clock?: Clock;
	logger?: PushLogger;
	intervalMs?: number;
}

interface Tracker {
	sessionId: string;
	ownerUserId: string | null;
	status: PushSessionStatus;
	statusSinceMs: number;
	toolCount: number;
	/** Oldest first; the last element is the bucket at `head`. */
	counts: number[];
	head: number;
	dirty: boolean;
	lastSentAtMs: number;
	holdUntilMs: number;
	rows: Map<string, LiveActivityRow>;
	/** Consecutive refusals by the relay that say the activity is not there (per device). */
	rejects: Map<string, number>;
}

const bucketOf = (ms: number) => Math.floor(ms / BUCKET_MS);
const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, Math.trunc(value)));

function advance(tracker: Tracker, nowMs: number): void {
	const target = bucketOf(nowMs);
	if (target <= tracker.head) return;
	const shift = Math.min(target - tracker.head, TRACE_BUCKETS);
	tracker.counts = [...tracker.counts.slice(shift), ...new Array<number>(shift).fill(0)];
	tracker.head = target;
}

export class LiveActivityPublisher implements PushScheduler {
	readonly clock: Clock;
	private readonly logger: PushLogger;
	private readonly trackers = new Map<string, Tracker>();
	private readonly scheduler: IntervalScheduler;
	private unobserve: (() => void) | null = null;

	constructor(private readonly deps: PublisherDeps) {
		this.clock = deps.clock ?? systemClock;
		this.logger = deps.logger ?? consolePushLogger;
		this.scheduler = new IntervalScheduler({
			name: "live activity publisher",
			intervalMs: deps.intervalMs ?? PUBLISHER_INTERVAL_MS,
			tick: () => this.tick(),
			onStart: () => this.restore(),
			clock: this.clock,
			logger: this.logger,
		});
	}

	start(): void {
		if (this.scheduler.started) return;
		this.deps.bus.on("session_updated", this.onSessionUpdated);
		this.deps.bus.on("session_event", this.onSessionEvent);
		this.unobserve = this.deps.observeRevalidation?.(this.onRevalidate) ?? null;
		this.scheduler.start();
	}

	stop(): void {
		this.deps.bus.off("session_updated", this.onSessionUpdated);
		this.deps.bus.off("session_event", this.onSessionEvent);
		this.unobserve?.();
		this.unobserve = null;
		this.scheduler.stop();
		this.trackers.clear();
	}

	/** How many sessions are followed right now (tests and metrics). */
	get watchedSessions(): number {
		return this.trackers.size;
	}

	// ── following ───────────────────────────────────────────────────────────

	/** A device started following a session: track it and send the first state. */
	async follow(row: LiveActivityRow): Promise<void> {
		let tracker = this.trackers.get(row.sessionId);
		if (!tracker) {
			const view = await this.deps.readSession(row.sessionId);
			if (!view) {
				await this.deps.store.endRow(row.deviceId, row.sessionId, this.nowIso());
				return;
			}
			tracker = this.trackers.get(row.sessionId) ?? this.newTracker(row.sessionId, view);
			this.trackers.set(row.sessionId, tracker);
		}
		const previous = tracker.rows.get(row.deviceId);
		// A new slot (or a follow after the old row was closed) is a new activity on the phone: refusals
		// of the old one say nothing about it.
		if (!previous || previous.slot !== row.slot) tracker.rejects.delete(row.deviceId);
		tracker.rows.set(row.deviceId, row);
		await this.settleAll(tracker, "update");
	}

	/** A device stopped following: close the row and, if the device can still be told, end the activity. */
	async unfollow(row: LiveActivityRow): Promise<void> {
		const tracker = this.trackers.get(row.sessionId);
		tracker?.rows.delete(row.deviceId);
		if (tracker && tracker.rows.size === 0) this.trackers.delete(row.sessionId);
		await this.deps.store.endRow(row.deviceId, row.sessionId, this.nowIso());
		const entry = await this.deps.eligibleDevice(row.deviceId);
		if (!entry) return;
		const view = tracker ?? this.newTracker(row.sessionId, await this.viewOrDefault(row.sessionId));
		// Ending one's own follow must not be the way to read a session one can no longer read.
		const owners = await this.deps.readOwners([row.sessionId]);
		const ownerUserId = owners.has(row.sessionId)
			? (owners.get(row.sessionId) ?? null)
			: view.ownerUserId;
		const neutral = !canDeviceReadSession(entry, ownerUserId, await this.deps.mode());
		await this.send(view, row, entry, "end", { dismissalSec: this.nowSec(), neutral });
	}

	// ── bus handlers (arrow functions: they are subscribed and unsubscribed by identity) ──

	private readonly onSessionEvent = ({
		sessionId,
		event,
	}: { sessionId: string; event: SessionEvent }): void => {
		const tracker = this.trackers.get(sessionId);
		if (!tracker) return;
		const nowMs = this.clock.now();
		advance(tracker, nowMs);
		const last = TRACE_BUCKETS - 1;
		tracker.counts[last] = Math.min(TRACE_COUNT_MAX, (tracker.counts[last] ?? 0) + 1);
		if (event.eventType === "PostToolUse") {
			tracker.toolCount = Math.min(TOOL_COUNT_MAX, tracker.toolCount + 1);
		}
		tracker.dirty = true;
	};

	private readonly onSessionUpdated = (session: Session): void => {
		const tracker = this.trackers.get(session.sessionId);
		if (!tracker) return;
		this.handleUpdated(tracker, session).catch((err: unknown) =>
			this.logger.warn("live activity update failed", {
				session: tracker.sessionId,
				error: err instanceof Error ? err.name : "unknown",
			}),
		);
	};

	private async handleUpdated(tracker: Tracker, session: Session): Promise<void> {
		const status = (session.operationalStatus ?? tracker.status) as PushSessionStatus;
		const ownerChanged = tracker.ownerUserId !== (session.ownerUserId ?? null);
		tracker.ownerUserId = session.ownerUserId ?? null;
		tracker.toolCount = clamp(session.totalToolUses ?? tracker.toolCount, 0, TOOL_COUNT_MAX);

		if (session.isArchived) return this.finish(tracker, "archived");
		if (status === "completed") return this.finish(tracker, "completed");
		if (status !== tracker.status) {
			tracker.status = status;
			tracker.statusSinceMs = this.clock.now();
			return this.settleAll(tracker, "update");
		}
		tracker.dirty = true;
		if (ownerChanged) await this.revalidate(tracker, await this.deps.mode());
	}

	// ── the pass ────────────────────────────────────────────────────────────

	/** One pass: close activities that expired or lost eligibility, and send due trace updates. */
	async tick(): Promise<void> {
		if (this.trackers.size === 0) return;
		// Ownership can change without a session update (a handover, a claim, a disabled user), so the
		// owner is read afresh, in one query, before anyone is judged against it.
		await this.refreshOwners();
		const nowMs = this.clock.now();
		const mode = await this.deps.mode();
		const eligible = new Map((await this.deps.eligibleDevices()).map((e) => [e.device.id, e]));
		for (const tracker of [...this.trackers.values()]) {
			for (const row of [...tracker.rows.values()]) {
				const entry = eligible.get(row.deviceId);
				const expired = nowMs - row.startedAtMs >= ACTIVITY_MAX_AGE_MS;
				if (expired || !entry || !canDeviceReadSession(entry, tracker.ownerUserId, mode)) {
					await this.close(tracker, row, entry, mode, this.nowSec());
				}
			}
			if (tracker.rows.size === 0) {
				this.trackers.delete(tracker.sessionId);
				continue;
			}
			await this.flushTrace(tracker, eligible, mode, nowMs);
			if (tracker.rows.size === 0) this.trackers.delete(tracker.sessionId);
		}
	}

	private async refreshOwners(): Promise<void> {
		const ids = [...this.trackers.keys()];
		for (let i = 0; i < ids.length; i += OWNER_READ_CHUNK) {
			const chunk = ids.slice(i, i + OWNER_READ_CHUNK);
			const owners = await this.deps.readOwners(chunk);
			for (const id of chunk) {
				const tracker = this.trackers.get(id);
				if (!tracker) continue;
				if (owners.has(id)) tracker.ownerUserId = owners.get(id) ?? null;
				else await this.finish(tracker, "archived");
			}
		}
	}

	/** Authority changed somewhere: re-judge every followed session now rather than at the next pass. */
	private readonly onRevalidate = async (): Promise<void> => {
		try {
			await this.refreshOwners();
			if (this.trackers.size === 0) return;
			// One device query and one mode read for every followed session, not one per row.
			const mode = await this.deps.mode();
			const eligible = new Map((await this.deps.eligibleDevices()).map((e) => [e.device.id, e]));
			for (const tracker of [...this.trackers.values()]) {
				await this.revalidate(tracker, mode, (deviceId) => eligible.get(deviceId));
			}
		} catch (err) {
			// The 15 s pass judges everything again, so this only delays an end; it must be seen.
			this.logger.warn("live activity revalidation failed", {
				error: err instanceof Error ? err.name : "unknown",
			});
		}
	};

	private async flushTrace(
		tracker: Tracker,
		eligible: Map<string, EligibleDevice>,
		mode: "solo" | "team",
		nowMs: number,
	): Promise<void> {
		if (!tracker.dirty) return;
		if (nowMs - tracker.lastSentAtMs < BUCKET_MS || nowMs < tracker.holdUntilMs) return;
		let holdMs = 0;
		for (const row of [...tracker.rows.values()]) {
			const entry = eligible.get(row.deviceId);
			if (!entry || !canDeviceReadSession(entry, tracker.ownerUserId, mode)) continue;
			const outcome = await this.send(tracker, row, entry, "update");
			if (FALLBACK_BACKOFF.has(outcome.status)) {
				const hint =
					"retryAfterSec" in outcome && outcome.retryAfterSec ? outcome.retryAfterSec * 1000 : 0;
				holdMs = Math.max(holdMs, hint || BACKOFF_MS);
			}
		}
		if (holdMs > 0) {
			tracker.holdUntilMs = nowMs + holdMs;
			return;
		}
		tracker.dirty = false;
		tracker.lastSentAtMs = nowMs;
	}

	// ── sending ─────────────────────────────────────────────────────────────

	/** Sends `event` to every followed device that is still eligible; closes the ones that are not. */
	private async settleAll(tracker: Tracker, event: "update" | "end"): Promise<void> {
		const mode = await this.deps.mode();
		tracker.dirty = false;
		tracker.lastSentAtMs = this.clock.now();
		for (const row of [...tracker.rows.values()]) {
			const entry = await this.deps.eligibleDevice(row.deviceId);
			if (!entry || !canDeviceReadSession(entry, tracker.ownerUserId, mode)) {
				await this.close(tracker, row, entry ?? undefined, mode, this.nowSec());
			} else {
				await this.send(tracker, row, entry, event);
			}
		}
		if (tracker.rows.size === 0) this.trackers.delete(tracker.sessionId);
	}

	/** After an owner change: end the activity of every device that can no longer read the session. */
	private async revalidate(
		tracker: Tracker,
		mode: "solo" | "team",
		lookup?: (deviceId: string) => EligibleDevice | undefined,
	): Promise<void> {
		for (const row of [...tracker.rows.values()]) {
			const entry = lookup
				? lookup(row.deviceId)
				: ((await this.deps.eligibleDevice(row.deviceId)) ?? undefined);
			if (!entry || !canDeviceReadSession(entry, tracker.ownerUserId, mode)) {
				await this.close(tracker, row, entry, mode, this.nowSec());
			}
		}
		if (tracker.rows.size === 0) this.trackers.delete(tracker.sessionId);
	}

	/** The session is over for everyone: end each activity and stop tracking. */
	private async finish(tracker: Tracker, reason: "completed" | "archived"): Promise<void> {
		this.trackers.delete(tracker.sessionId);
		tracker.status = "completed";
		tracker.statusSinceMs = this.clock.now();
		const mode = await this.deps.mode();
		const dismissalSec = this.nowSec() + (reason === "completed" ? COMPLETED_DISMISSAL_SEC : 0);
		for (const row of [...tracker.rows.values()]) {
			const entry = await this.deps.eligibleDevice(row.deviceId);
			await this.close(tracker, row, entry ?? undefined, mode, dismissalSec);
		}
	}

	/** Ends one row: the activity is told where the device is still reachable, and the row is closed either way. */
	private async close(
		tracker: Tracker,
		row: LiveActivityRow,
		entry: EligibleDevice | undefined,
		mode: "solo" | "team",
		dismissalSec: number,
	): Promise<void> {
		tracker.rows.delete(row.deviceId);
		await this.deps.store.endRow(row.deviceId, row.sessionId, this.nowIso());
		// A device that lost only its read access is still reachable: tell it. One that is revoked has no token.
		if (!entry) return;
		// A device that can no longer read the session is told to stop, and nothing about the session.
		const neutral = !canDeviceReadSession(entry, tracker.ownerUserId, mode);
		await this.send(tracker, row, entry, "end", { dismissalSec, neutral });
	}

	private async send(
		tracker: Tracker,
		row: LiveActivityRow,
		entry: EligibleDevice,
		event: "update" | "end",
		options: { dismissalSec?: number; neutral?: boolean } = {},
	): Promise<ActivityOutcome> {
		const nowMs = this.clock.now();
		advance(tracker, nowMs);
		const outcome = await this.deps.service.sendActivityUpdate(entry.device, {
			slot: row.slot,
			generation: row.generation,
			event,
			contentState: options.neutral ? this.neutralState() : this.contentState(tracker),
			staleDate: Math.floor(nowMs / 1000) + STALE_AFTER_SEC,
			...(options.dismissalSec !== undefined ? { dismissalDate: options.dismissalSec } : {}),
		});
		const refusedAsGone =
			outcome.status === "rejected" &&
			outcome.error !== null &&
			NOT_THERE_ERRORS.has(outcome.error);
		if (refusedAsGone)
			tracker.rejects.set(row.deviceId, (tracker.rejects.get(row.deviceId) ?? 0) + 1);
		else if (outcome.status === "sent") tracker.rejects.delete(row.deviceId);
		const finished =
			ROW_FINISHED.has(outcome.status) ||
			(refusedAsGone && (tracker.rejects.get(row.deviceId) ?? 0) >= REJECTS_BEFORE_FINISH);
		if (finished && tracker.rows.get(row.deviceId) === row) {
			tracker.rows.delete(row.deviceId);
			await this.deps.store.endRow(row.deviceId, row.sessionId, this.nowIso());
			if (outcome.status === "unauthorized") this.dropDevice(row.deviceId);
		}
		return outcome;
	}

	/** A revoked device follows nothing: forget every row it had. */
	private dropDevice(deviceId: string): void {
		for (const tracker of this.trackers.values()) tracker.rows.delete(deviceId);
	}

	private neutralState(): Record<string, unknown> {
		return {
			status: "completed",
			statusSince: clamp(this.nowSec(), STATUS_SINCE_MIN, STATUS_SINCE_MAX),
			toolCount: 0,
			trace: new Array<number>(TRACE_BUCKETS).fill(0),
		};
	}

	private contentState(tracker: Tracker): Record<string, unknown> {
		return {
			status: tracker.status,
			statusSince: clamp(
				Math.floor(tracker.statusSinceMs / 1000),
				STATUS_SINCE_MIN,
				STATUS_SINCE_MAX,
			),
			toolCount: clamp(tracker.toolCount, 0, TOOL_COUNT_MAX),
			trace: tracker.counts.map((n) => clamp(n, 0, TRACE_COUNT_MAX)),
		};
	}

	// ── start-up ────────────────────────────────────────────────────────────

	/** After a restart: pick up the activities still marked live and end the ones whose session is over. */
	private async restore(): Promise<void> {
		const rows = await this.deps.store.liveRows();
		const bySession = new Map<string, LiveActivityRow[]>();
		for (const row of rows)
			bySession.set(row.sessionId, [...(bySession.get(row.sessionId) ?? []), row]);
		for (const [sessionId, group] of bySession) {
			const view = await this.deps.readSession(sessionId);
			const tracker = view ? this.newTracker(sessionId, view) : null;
			if (!tracker || !view || view.archived || view.status === "completed") {
				for (const row of group) {
					await this.deps.store.endRow(row.deviceId, row.sessionId, this.nowIso());
				}
				continue;
			}
			for (const row of group) tracker.rows.set(row.deviceId, row);
			this.trackers.set(sessionId, tracker);
		}
	}

	private newTracker(sessionId: string, view: SessionView): Tracker {
		const nowMs = this.clock.now();
		return {
			sessionId,
			ownerUserId: view.ownerUserId,
			status: view.status,
			statusSinceMs: nowMs,
			toolCount: clamp(view.toolCount, 0, TOOL_COUNT_MAX),
			counts: new Array<number>(TRACE_BUCKETS).fill(0),
			head: bucketOf(nowMs),
			dirty: false,
			lastSentAtMs: 0,
			holdUntilMs: 0,
			rows: new Map(),
			rejects: new Map(),
		};
	}

	private async viewOrDefault(sessionId: string): Promise<SessionView> {
		return (
			(await this.deps.readSession(sessionId)) ?? {
				ownerUserId: null,
				status: "completed",
				toolCount: 0,
				archived: false,
			}
		);
	}

	private nowIso(): string {
		return new Date(this.clock.now()).toISOString();
	}

	private nowSec(): number {
		return Math.floor(this.clock.now() / 1000);
	}
}

// ── the database side ───────────────────────────────────────────────────────

type ActivityRow = typeof mobileDeviceActivities.$inferSelect;

function toLiveRow(row: ActivityRow): LiveActivityRow {
	const startedAtMs = Date.parse(row.createdAt);
	return {
		deviceId: row.deviceId,
		sessionId: row.sessionId,
		slot: row.slot,
		generation: row.generation,
		startedAtMs: Number.isNaN(startedAtMs) ? Date.now() : startedAtMs,
	};
}

export type UpsertResult =
	| { kind: "ok"; row: LiveActivityRow; created: boolean; changed: boolean }
	| { kind: "stale_generation" }
	| { kind: "limit" };

/** The `mobile_device_activities` table: one row per (device, session). */
export class DbActivityStore implements ActivityStore {
	async liveRows(): Promise<LiveActivityRow[]> {
		const rows = await getDb()
			.select()
			.from(mobileDeviceActivities)
			.where(isNull(mobileDeviceActivities.endedAt));
		return rows.map(toLiveRow);
	}

	/** The live follow of this session on this device, or null when there is none. */
	async row(deviceId: string, sessionId: string): Promise<LiveActivityRow | null> {
		const [row] = await getDb()
			.select()
			.from(mobileDeviceActivities)
			.where(
				and(
					eq(mobileDeviceActivities.deviceId, deviceId),
					eq(mobileDeviceActivities.sessionId, sessionId),
					isNull(mobileDeviceActivities.endedAt),
				),
			)
			.limit(1);
		return row ? toLiveRow(row) : null;
	}

	async endRow(deviceId: string, sessionId: string, atIso: string): Promise<void> {
		await getDb()
			.update(mobileDeviceActivities)
			.set({ endedAt: atIso })
			.where(
				and(
					eq(mobileDeviceActivities.deviceId, deviceId),
					eq(mobileDeviceActivities.sessionId, sessionId),
					isNull(mobileDeviceActivities.endedAt),
				),
			);
	}

	/**
	 * Starts (or refreshes) a device's follow of a session. The same slot and
	 * generation again changes nothing; a newer generation or a new slot replaces
	 * it and reopens an ended row; an older generation is refused. A device holds
	 * a bounded number of live follows.
	 */
	async upsert(
		input: { deviceId: string; sessionId: string; slot: string; generation: number },
		now: Date = new Date(),
	): Promise<UpsertResult> {
		const nowIso = now.toISOString();
		return withTransaction(async (tx) => {
			const [existing] = await tx
				.select()
				.from(mobileDeviceActivities)
				.where(
					and(
						eq(mobileDeviceActivities.deviceId, input.deviceId),
						eq(mobileDeviceActivities.sessionId, input.sessionId),
					),
				)
				.limit(1);
			if (existing) {
				if (input.generation < existing.generation) return { kind: "stale_generation" } as const;
				const unchanged =
					existing.endedAt === null &&
					existing.slot === input.slot &&
					existing.generation === input.generation;
				if (unchanged)
					return { kind: "ok", row: toLiveRow(existing), created: false, changed: false } as const;
				if (
					existing.endedAt !== null &&
					(await this.liveCount(tx, input.deviceId)) >= MAX_LIVE_ACTIVITIES_PER_DEVICE
				) {
					return { kind: "limit" } as const;
				}
				const [updated] = await tx
					.update(mobileDeviceActivities)
					.set({
						slot: input.slot,
						generation: input.generation,
						endedAt: null,
						createdAt: existing.endedAt === null ? existing.createdAt : nowIso,
					})
					.where(eq(mobileDeviceActivities.id, existing.id))
					.returning();
				return { kind: "ok", row: toLiveRow(updated), created: false, changed: true } as const;
			}
			if ((await this.liveCount(tx, input.deviceId)) >= MAX_LIVE_ACTIVITIES_PER_DEVICE) {
				return { kind: "limit" } as const;
			}
			const [inserted] = await tx
				.insert(mobileDeviceActivities)
				.values({
					deviceId: input.deviceId,
					sessionId: input.sessionId,
					slot: input.slot,
					generation: input.generation,
					createdAt: nowIso,
				})
				.returning();
			return { kind: "ok", row: toLiveRow(inserted), created: true, changed: true } as const;
		});
	}

	// biome-ignore lint/suspicious/noExplicitAny: dialect-portable transaction handle
	private async liveCount(tx: any, deviceId: string): Promise<number> {
		const rows = await tx
			.select({ id: mobileDeviceActivities.id })
			.from(mobileDeviceActivities)
			.where(
				and(eq(mobileDeviceActivities.deviceId, deviceId), isNull(mobileDeviceActivities.endedAt)),
			);
		return rows.length;
	}
}

/** One session as the publisher sees it, or null when it doesn't exist. */
export async function readSessionView(sessionId: string): Promise<SessionView | null> {
	const [row] = await getDb()
		.select()
		.from(sessions)
		.where(eq(sessions.sessionId, sessionId))
		.limit(1);
	if (!row) return null;
	return {
		ownerUserId: row.ownerUserId ?? null,
		status: getOperationalStatus(row),
		toolCount: row.totalToolUses,
		archived: row.isArchived,
	};
}

/** Who owns each of these sessions now, in one query. */
export async function readSessionOwners(sessionIds: string[]): Promise<Map<string, string | null>> {
	if (sessionIds.length === 0) return new Map();
	const rows = await getDb()
		.select({ sessionId: sessions.sessionId, ownerUserId: sessions.ownerUserId })
		.from(sessions)
		.where(inArray(sessions.sessionId, sessionIds));
	return new Map(rows.map((r) => [r.sessionId, r.ownerUserId ?? null]));
}

/** The publisher wired to the database, the device rules and the session bus. */
export function createDbLiveActivityPublisher(
	service: Pick<PushService, "sendActivityUpdate">,
	bus: Pick<SessionBus, "on" | "off">,
	logger: PushLogger = consolePushLogger,
): LiveActivityPublisher {
	return new LiveActivityPublisher({
		service,
		store: new DbActivityStore(),
		readSession: readSessionView,
		eligibleDevices: listEligibleDevices,
		eligibleDevice: async (id) => getEligibleDevice(id),
		readOwners: readSessionOwners,
		observeRevalidation: observeWsRevalidation,
		mode: getMode,
		bus,
		logger,
	});
}
