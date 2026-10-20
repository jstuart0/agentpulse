/**
 * The start/stop contract every push background job follows (the Live Activity
 * publisher, and the health and digest triggers below). A job does its work in
 * `tick`; this runs it on a timer that never overlaps itself, never keeps the
 * process alive, and stops cleanly. Time comes from an injected clock, so tests
 * drive `tick` directly and never wait on a timer.
 */
import type { HealthState } from "../ai/classifier.js";
import type { DispatchResult } from "./dispatch.js";
import { isCategoryEnabled } from "./push-payload.js";
import type { AlertOutcome } from "./push-service.js";
import { AMBIGUOUS_OUTCOMES, REFUNDED_OUTCOMES } from "./push-service.js";
import { type EligibleDevice, canDeviceReadSession } from "./push-targets.js";
import {
	type Clock,
	type PushDevice,
	type PushEvent,
	type PushLogger,
	consolePushLogger,
	systemClock,
} from "./types.js";

export interface PushScheduler {
	/** The clock the job reads; injected so tests control time. */
	readonly clock: Clock;
	/** Begins work. Calling it again while running does nothing. */
	start(): void;
	/** Stops work. Anything in flight finishes; nothing new starts. */
	stop(): void;
}

export interface IntervalSchedulerOptions {
	name: string;
	intervalMs: number;
	tick: () => Promise<void>;
	/** Runs once at start, before the first interval. */
	onStart?: () => Promise<void>;
	onStop?: () => void;
	clock?: Clock;
	logger?: PushLogger;
}

/** A `PushScheduler` that calls `tick` every `intervalMs`, one call at a time. */
export class IntervalScheduler implements PushScheduler {
	readonly clock: Clock;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private readonly logger: PushLogger;

	constructor(private readonly options: IntervalSchedulerOptions) {
		this.clock = options.clock ?? systemClock;
		this.logger = options.logger ?? consolePushLogger;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.runTick(), this.options.intervalMs);
		this.timer.unref?.();
		if (this.options.onStart) {
			this.options.onStart().catch((err: unknown) => this.logFailure("start", err));
		}
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.options.onStop?.();
	}

	get started(): boolean {
		return this.timer !== null;
	}

	/** One pass, skipped if the last one is still going. Never rejects. */
	async runTick(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			await this.options.tick();
		} catch (err) {
			this.logFailure("tick", err);
		} finally {
			this.running = false;
		}
	}

	private logFailure(phase: string, err: unknown): void {
		this.logger.warn(`${this.options.name} ${phase} failed`, {
			error: err instanceof Error ? err.name : "unknown",
		});
	}
}

// ── Health and digest triggers (S7) ─────────────────────────────────────────

/** How often the health job looks at sessions. */
export const HEALTH_INTERVAL_MS = 60_000;
/** How often the digest job looks for devices whose local morning has come. */
export const DIGEST_INTERVAL_MS = 15 * 60_000;
/** At most this many active sessions are classified in one pass, newest activity first. */
export const MAX_HEALTH_SESSIONS = 200;
/** Health events handed to dispatch at once; dispatch caps one origin at 50 in flight, and this stays well inside it. */
const EMIT_BATCH = 25;

/** The two health states that make a push. `blocked` is covered by the HITL push; the rest are not alarming. */
type AlarmState = "stuck" | "risky";
const isAlarm = (health: HealthState | undefined): health is AlarmState =>
	health === "stuck" || health === "risky";

export interface HealthCandidate {
	sessionId: string;
	ownerUserId: string | null;
}

/**
 * What the triggers need from the rest of the server. The database-backed implementation is in
 * push-trigger-ports.ts; tests pass in memory ones.
 */
export interface PushTriggerPorts {
	/** Is AI on (built, enabled, not paused)? When it isn't, neither job sends anything. */
	enabled(): Promise<boolean>;
	mode(): Promise<"solo" | "team">;
	/** Devices that may be sent to now (the one eligibility rule). */
	eligibleDevices(): Promise<EligibleDevice[]>;
	/** One device judged afresh, or null when it may no longer be sent to (revoked, key or user gone, user disabled). */
	eligibleDevice(deviceId: string): Promise<EligibleDevice | null>;
	/** Active or idle, unarchived sessions, newest activity first. */
	activeSessions(limit: number): Promise<HealthCandidate[]>;
	/** The classifier's verdict for each id (an id the classifier can't judge is absent). */
	classify(sessionIds: string[], now: Date): Promise<Map<string, HealthState>>;
	/** Active snoozes as `<kind>:<targetId>`, the shape the inbox filters by. */
	snoozes(now: Date): Promise<ReadonlySet<string>>;
	/** Hands a session event to the push dispatch (targeting, dedupe and limits happen there) and says what became of it. */
	emit(event: PushEvent): Promise<DispatchResult>;
	/** How many sessions this device's owner may read in the digest window. A count only: nothing else is read or sent. */
	digestSessionCount(entry: EligibleDevice, mode: "solo" | "team", now: Date): Promise<number>;
	/** Sends one event to exactly these devices (their prefs, quiet hours and limits still apply). */
	sendToDevices(devices: PushDevice[], event: PushEvent): Promise<AlertOutcome[]>;
	/** Records that this device's digest for its local `date` is done. */
	markDigestSent(deviceId: string, date: string): Promise<void>;
}

export interface PushTriggerOptions {
	ports: PushTriggerPorts;
	clock?: Clock;
	logger?: PushLogger;
	/** Overrides for tests; production uses the constants above. */
	healthIntervalMs?: number;
	digestIntervalMs?: number;
}

/** The device's wall clock: its local calendar date (YYYY-MM-DD) and hour, in the zone it named (UTC if unknown). */
export function localDateAndHour(
	nowMs: number,
	timeZone: string | undefined,
): { date: string; hour: number } {
	const parts = (zone: string) => {
		const formatted = new Intl.DateTimeFormat("en-GB", {
			timeZone: zone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			hourCycle: "h23",
		}).formatToParts(new Date(nowMs));
		const get = (type: string) => formatted.find((p) => p.type === type)?.value ?? "00";
		return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
	};
	try {
		return parts(timeZone || "UTC");
	} catch {
		return parts("UTC");
	}
}

/** Is the device's digest due: opted in, a send hour chosen, that hour reached in its own zone, and today's not yet done. */
export function digestDue(device: PushDevice, nowMs: number): { due: boolean; date: string } {
	const { date, hour } = localDateAndHour(nowMs, device.prefs.timezone);
	const sendHour = device.prefs.digestHour;
	const due =
		isCategoryEnabled(device.prefs, "DIGEST") &&
		typeof sendHour === "number" &&
		hour >= sendHour &&
		device.prefs.lastDigestDate !== date;
	return { due, date };
}

/**
 * The health and digest triggers: one `PushScheduler`, two independent timers, so a slow digest pass can't
 * hold the health pass back (each timer's pass never overlaps itself, and they don't wait on each other).
 * Neither job sends anything while AI is switched off.
 *
 * Health (every 60 s): classifies up to 200 active sessions and pushes `stuck` / `risky` when a session moves
 * INTO that state. It re-arms when the session leaves the state (or leaves the active set), and a snooze
 * suppresses the push without being a way back in: a snoozed session that is still stuck when the snooze ends
 * is not announced again. A session is marked announced only once dispatch reports the push settled or sent;
 * one that was over budget, had nobody to tell, or failed is tried again on the next pass. The first pass after
 * start, after nobody was subscribed, or after AI was off, only records what is already stuck, so a restart
 * doesn't announce the backlog.
 *
 * Digest (every 15 min): a device whose local clock has passed its `digestHour`, and whose `lastDigestDate`
 * isn't its local today, gets one digest push. Eligibility is a count of the sessions its owner may read (no
 * classification, no names); when it is zero nothing is sent. Just before the send each target is judged afresh,
 * so a device revoked, disabled or demoted during the pass is not sent to. The push carries no counts or
 * names: the phone fetches what it shows. Each replica runs its own copy.
 */
export class PushTriggerScheduler implements PushScheduler {
	readonly clock: Clock;
	private readonly ports: PushTriggerPorts;
	private readonly logger: PushLogger;
	private readonly health: IntervalScheduler;
	private readonly digest: IntervalScheduler;

	private readonly alarmed = new Map<string, AlarmState | "ok">();
	private baselined = false;
	/** Devices whose digest for a date is done, so a lost marker write can't send it twice. Pruned to live devices. */
	private readonly digestDone = new Map<string, string>();

	constructor(options: PushTriggerOptions) {
		this.ports = options.ports;
		this.clock = options.clock ?? systemClock;
		this.logger = options.logger ?? consolePushLogger;
		this.health = new IntervalScheduler({
			name: "push health",
			intervalMs: options.healthIntervalMs ?? HEALTH_INTERVAL_MS,
			tick: () => this.healthTick(),
			clock: this.clock,
			logger: this.logger,
		});
		this.digest = new IntervalScheduler({
			name: "push digest",
			intervalMs: options.digestIntervalMs ?? DIGEST_INTERVAL_MS,
			tick: () => this.digestTick(),
			onStart: () => this.digest.runTick(),
			clock: this.clock,
			logger: this.logger,
		});
	}

	start(): void {
		this.health.start();
		this.digest.start();
	}

	stop(): void {
		this.health.stop();
		this.digest.stop();
	}

	/** One health pass. Never rejects. */
	async healthTick(): Promise<void> {
		await this.guarded("health", async () => this.healthPass(await this.gatedDevices()));
	}

	/** One digest pass. Never rejects. */
	async digestTick(): Promise<void> {
		await this.guarded("digest", async () => this.digestPass(await this.gatedDevices()));
	}

	/** Both passes, health first: for tests and one-shot callers. */
	async tick(): Promise<void> {
		await this.healthTick();
		await this.digestTick();
	}

	/** The eligible devices, or none while AI is off (so the health pass forgets its state and turning AI back on starts fresh). */
	private async gatedDevices(): Promise<EligibleDevice[]> {
		// No devices means the health pass forgets its state (it does so whenever nobody is subscribed).
		return (await this.ports.enabled()) ? this.ports.eligibleDevices() : [];
	}

	private async guarded(job: string, run: () => Promise<void>): Promise<void> {
		try {
			await run();
		} catch (err) {
			this.logger.warn(`push ${job} pass failed`, {
				error: err instanceof Error ? err.name : "unknown",
			});
		}
	}

	// ── health ──

	private async healthPass(devices: EligibleDevice[]): Promise<void> {
		const subscribed = devices.filter(
			({ device }) =>
				device.sendTokenCiphertext !== "" &&
				(isCategoryEnabled(device.prefs, "STUCK") || isCategoryEnabled(device.prefs, "RISKY")),
		);
		if (subscribed.length === 0) {
			this.alarmed.clear();
			this.baselined = false;
			return;
		}
		const now = new Date(this.clock.now());
		const mode = await this.ports.mode();
		const candidates = (await this.ports.activeSessions(MAX_HEALTH_SESSIONS)).filter(
			(s) =>
				mode === "solo" || subscribed.some((d) => canDeviceReadSession(d, s.ownerUserId, mode)),
		);
		const health = await this.ports.classify(
			candidates.map((s) => s.sessionId),
			now,
		);
		const snoozes = await this.ports.snoozes(now);

		const present = new Set(candidates.map((s) => s.sessionId));
		for (const id of this.alarmed.keys()) if (!present.has(id)) this.alarmed.delete(id);

		const announce: Array<{ sessionId: string; state: AlarmState }> = [];
		for (const { sessionId } of candidates) {
			const verdict = health.get(sessionId);
			const current: AlarmState | "ok" = isAlarm(verdict) ? verdict : "ok";
			const before = this.alarmed.get(sessionId);
			if (!this.baselined || current === "ok" || current === before) {
				this.alarmed.set(sessionId, current);
				continue;
			}
			if (snoozes.has(`${current}:${current}:${sessionId}`)) {
				this.alarmed.set(sessionId, current);
				continue;
			}
			announce.push({ sessionId, state: current });
		}
		this.baselined = true;

		for (let i = 0; i < announce.length; i += EMIT_BATCH) {
			const batch = announce.slice(i, i + EMIT_BATCH);
			const results = await Promise.all(
				batch.map(({ sessionId, state }) => this.ports.emit({ type: state, sessionId })),
			);
			batch.forEach(({ sessionId, state }, n) => {
				// A push that never reached anyone and may yet be able to is left unmarked: next pass sees the transition again.
				if (results[n] !== "retry") this.alarmed.set(sessionId, state);
			});
		}
	}

	// ── digest ──

	private async digestPass(devices: EligibleDevice[]): Promise<void> {
		const nowMs = this.clock.now();
		const live = new Set(devices.map((e) => e.device.id));
		for (const id of this.digestDone.keys()) if (!live.has(id)) this.digestDone.delete(id);

		const now = new Date(nowMs);
		const due = devices.flatMap((entry) => {
			if (entry.device.sendTokenCiphertext === "") return [];
			const { due: isDue, date } = digestDue(entry.device, nowMs);
			return isDue && this.digestDone.get(entry.device.id) !== date ? [{ entry, date }] : [];
		});
		if (due.length === 0) return;

		const mode = await this.ports.mode();
		const toSend = new Map<string, PushDevice[]>();
		for (const { entry, date } of due) {
			const target = await this.settledTarget(entry, mode, now);
			if (target === "gone") continue;
			if (target === "empty") {
				await this.finishDigest(entry.device.id, date);
				continue;
			}
			toSend.set(date, [...(toSend.get(date) ?? []), target]);
		}
		for (const [date, targets] of toSend) {
			const outcomes = await this.ports.sendToDevices(targets, {
				type: "daily_digest",
				digestDate: date,
			});
			for (const outcome of outcomes) {
				const retryable =
					REFUNDED_OUTCOMES.has(outcome.status) && !AMBIGUOUS_OUTCOMES.has(outcome.status);
				if (!retryable) await this.finishDigest(outcome.deviceId, date);
			}
		}
	}

	/**
	 * The device as it stands right now, if it should get a digest: judged afresh (it may have been revoked, its
	 * user disabled or demoted since the pass began), and counted for its present role. `gone` when it may not be
	 * sent to at all, `empty` when its owner reads no sessions in the window.
	 */
	private async settledTarget(
		entry: EligibleDevice,
		mode: "solo" | "team",
		now: Date,
	): Promise<PushDevice | "gone" | "empty"> {
		const fresh = await this.ports.eligibleDevice(entry.device.id);
		if (!fresh || fresh.device.sendTokenCiphertext === "") return "gone";
		if (!digestDue(fresh.device, now.getTime()).due) return "gone"; // its prefs changed, or another replica sent it
		if ((await this.ports.digestSessionCount(fresh, mode, now)) === 0) return "empty";
		return fresh.device;
	}

	private async finishDigest(deviceId: string, date: string): Promise<void> {
		this.digestDone.set(deviceId, date);
		try {
			await this.ports.markDigestSent(deviceId, date);
		} catch (err) {
			this.logger.warn("digest marker not saved", {
				device: deviceId,
				error: err instanceof Error ? err.name : "unknown",
			});
		}
	}
}
