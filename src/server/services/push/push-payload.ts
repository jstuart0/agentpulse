/**
 * Shapes one push event into the sealed plaintext for one device.
 *
 * The plaintext is `push-payload.schema.json` (v1): ids and short labels. What a
 * device sees depends on its prefs: names, agent and machine only with "Show
 * content" (default on); redacted agent text only with "Include agent text"
 * (default off). Which categories a device wants, and whether quiet hours turn
 * an alert down, are decided here too, because only the server knows the
 * category: the relay sees nothing but the priority class.
 *
 * The Free/Pro split is not made here. A Free phone downgrades the decision
 * categories to their view-only variants itself, from the entitlement snapshot;
 * the server never learns the tier and always sends the base category.
 *
 * A push is only a hint. Nothing in the payload is authority for an action: the
 * ids (`hitlId`, `proposalId`, `actionRequestId`) say what to go and fetch, and
 * `promptHash` lets the phone check that what it fetched is what was announced.
 * The phone re-reads the thing from the server before offering any decision.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { PushPayload } from "./hpke-seal.js";
import {
	type DevicePrefs,
	type InterruptionLevel,
	PUSH_CATEGORIES,
	type PushCategory,
	type PushDevice,
	type PushEvent,
	type RelayPriority,
} from "./types.js";

/** Longest agent text the phone is sent, in characters. */
export const MAX_TEXT_CHARS = 180;

interface CategoryRule {
	category: PushCategory;
	level: InterruptionLevel;
	/** Whether a device that never touched this category's toggle gets it. */
	defaultOn: boolean;
}

const RULES: Record<PushEvent["type"], CategoryRule> = {
	turn_completed: { category: "NEEDS_YOU_TURN", level: "time-sensitive", defaultOn: true },
	permission_wait: { category: "NEEDS_YOU_PERMISSION", level: "time-sensitive", defaultOn: true },
	session_failed: { category: "SESSION_FAILED", level: "active", defaultOn: true },
	session_completed: { category: "SESSION_COMPLETED", level: "passive", defaultOn: false },
	hitl_opened: { category: "WATCHER_HITL", level: "time-sensitive", defaultOn: true },
	action_request_opened: { category: "ACTION_REQUEST", level: "active", defaultOn: true },
	launch_status: { category: "LAUNCH_STATUS", level: "passive", defaultOn: false },
	ask_reply: { category: "ASK_REPLY", level: "active", defaultOn: true },
	stuck: { category: "STUCK", level: "active", defaultOn: true },
	risky: { category: "RISKY", level: "time-sensitive", defaultOn: true },
	// The trigger overrides this base rule: see categoryFor and baseLevelFor.
	alert_rule_fired: { category: "STUCK", level: "active", defaultOn: true },
	daily_digest: { category: "DIGEST", level: "passive", defaultOn: false },
	device_test: { category: "GENERIC_OPEN", level: "active", defaultOn: true },
};

export function categoryFor(event: PushEvent): PushCategory {
	if (event.type === "alert_rule_fired") {
		if (event.trigger === "failed") return "SESSION_FAILED";
		if (event.trigger === "completed") return "SESSION_COMPLETED";
	}
	return RULES[event.type].category;
}

/** The interruption level before quiet hours. A failed launch is the one event that rises above its category. */
export function baseLevelFor(event: PushEvent): InterruptionLevel {
	if (event.type === "launch_status" && event.failed) return "active";
	if (event.type === "alert_rule_fired" && event.trigger === "completed") return "passive";
	return RULES[event.type].level;
}

export function isCategoryEnabled(prefs: DevicePrefs, category: PushCategory): boolean {
	// The generic category is the test button's: pressing it is the request, so no toggle can refuse it.
	if (category === "GENERIC_OPEN") return true;
	const explicit = prefs.categories?.[category];
	if (typeof explicit === "boolean") return explicit;
	const rule = Object.values(RULES).find((r) => r.category === category);
	return rule?.defaultOn ?? false;
}

export function relayPriorityFor(level: InterruptionLevel): RelayPriority {
	return level === "time-sensitive" ? "needs-you" : level === "active" ? "normal" : "quiet";
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOfDay(hhmm: string): number | null {
	const m = HHMM.exec(hhmm);
	return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function localMinutes(nowMs: number, timeZone: string | undefined): number {
	const at = (zone: string) => {
		const parts = new Intl.DateTimeFormat("en-GB", {
			timeZone: zone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).formatToParts(new Date(nowMs));
		const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
		return get("hour") * 60 + get("minute");
	};
	try {
		return at(timeZone || "UTC");
	} catch {
		return at("UTC"); // an unknown zone name falls back to UTC rather than failing the push
	}
}

/**
 * True when `nowMs` falls inside the device's quiet hours in its own zone. The
 * window is [start, end) and may wrap midnight; start equal to end is no window.
 */
export function inQuietHours(prefs: DevicePrefs, nowMs: number): boolean {
	const q = prefs.quietHours;
	if (!q?.enabled) return false;
	const start = minutesOfDay(q.start);
	const end = minutesOfDay(q.end);
	if (start === null || end === null || start === end) return false;
	const now = localMinutes(nowMs, prefs.timezone);
	return start < end ? now >= start && now < end : now >= start || now < end;
}

/** The id the 60-second dedupe keys on: the thing the event is about. */
/** What a per-session limit counts by: the session when the event has one, else the thing the event is about. */
export function sessionKeyFor(event: PushEvent): string {
	if (event.type === "ask_reply") return event.threadId;
	return "sessionId" in event && event.sessionId ? event.sessionId : primaryIdFor(event);
}

/**
 * What "the same event" means for dedupe. Failure and completion are one thing to
 * the person however they were detected (the session ending, an alert rule on
 * it), so they share a key per session and the first in a window wins. Everything
 * else is its own type and thing. A launch status is a separate opt-in push and
 * never merges with them.
 */
export function dedupeKeyFor(event: PushEvent): string {
	const category = categoryFor(event);
	if (category === "SESSION_FAILED" || category === "SESSION_COMPLETED") {
		return `${category}|${sessionKeyFor(event)}`;
	}
	return `${event.type}|${primaryIdFor(event)}`;
}

export function primaryIdFor(event: PushEvent): string {
	switch (event.type) {
		case "hitl_opened":
			return event.hitlId;
		case "action_request_opened":
			return event.actionRequestId;
		case "launch_status":
			return event.launchId;
		case "ask_reply":
			return event.assistantMessageId;
		case "daily_digest":
			return event.digestDate;
		case "device_test":
			return event.testId;
		default:
			return event.sessionId;
	}
}

/** A stable, opaque key so a newer alert for the same thing replaces the older one on the phone without the relay learning the session id or category. */
export function collapseIdFor(event: PushEvent, category: PushCategory): string {
	return createHash("sha256")
		.update(`${sessionKeyFor(event)}|${category}`)
		.digest("hex")
		.slice(0, 32);
}

const shortId = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);
const optionalId = z.string().max(64);

/** The schema's closed member list, as a zod object. The test suite keeps it identical to `push-payload.schema.json`. */
export const PushPayloadSchema = z
	.object({
		v: z.literal(1),
		kid: shortId,
		pid: shortId,
		ts: z.number().int().min(1_700_000_000),
		ref: shortId,
		t: z.string().min(1).max(64),
		cat: z.enum(PUSH_CATEGORIES),
		il: z.enum(["passive", "active", "time-sensitive"]),
		sid: z.string().min(1).max(128).optional(),
		sname: z.string().max(200).optional(),
		agent: z.string().max(64).optional(),
		machine: z.string().max(128).optional(),
		status: z.enum(["waiting", "working", "error", "idle", "completed"]).optional(),
		pending: z.number().int().min(0).max(100_000).optional(),
		hitlId: optionalId.optional(),
		proposalId: optionalId.optional(),
		promptHash: z
			.string()
			.regex(/^[0-9a-f]{64}$/)
			.optional(),
		actionRequestId: optionalId.optional(),
		actionKind: optionalId.optional(),
		launchId: optionalId.optional(),
		threadId: optionalId.optional(),
		assistantMessageId: optionalId.optional(),
		durationSec: z.number().int().min(0).max(31_536_000).optional(),
		toolCount: z.number().int().min(0).max(1_000_000).optional(),
		text: z.string().max(MAX_TEXT_CHARS).optional(),
	})
	.strict();

/** The first `max` characters of `value` (whole code points), or undefined for empty input. */
function clip(value: string | null | undefined, max: number): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	const points = Array.from(value);
	return points.length <= max ? value : points.slice(0, max).join("");
}

const clampInt = (value: number | undefined, min: number, max: number): number | undefined =>
	typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(min, Math.trunc(value)))
		: undefined;

export type BuildFailure = "invalid_device_identity" | "invalid_payload";

export interface BuildOptions {
	event: PushEvent;
	device: PushDevice;
	pushId: string;
	nowMs: number;
	/** Redacts agent text. Applied before truncation, so a secret cut in half is still caught. */
	redact: (text: string) => string;
	/** The level after quiet hours. */
	level: InterruptionLevel;
}

/**
 * The sealed plaintext for one device, or the reason there isn't one. Optional
 * members that don't meet the schema are left out rather than failing the push;
 * the required ones (the device's kid and reference, the push id) are not
 * negotiable.
 */
export function buildPushPayload(
	options: BuildOptions,
): { ok: true; payload: PushPayload } | { ok: false; reason: BuildFailure } {
	const { event, device, pushId, nowMs, redact, level } = options;
	const prefs = device.prefs;
	const showContent = prefs.showContent !== false;
	const includeText = prefs.includeAgentText === true;

	const session = "sessionId" in event ? event : undefined;
	// Names, agent and machine come from the agent's side too, so they go through the same redactor.
	const label = (value: string | null | undefined, max: number) =>
		typeof value !== "string" ? undefined : clip(redact(value), max);
	const text =
		includeText && "text" in event && typeof event.text === "string" && event.text.length > 0
			? clip(redact(event.text), MAX_TEXT_CHARS)
			: undefined;

	const candidate: Record<string, unknown> = {
		v: 1,
		kid: device.kid,
		pid: pushId,
		ts: Math.floor(nowMs / 1000),
		ref: device.clientServerRef,
		t: event.type,
		cat: categoryFor(event),
		il: level,
		sid: session?.sessionId || undefined,
		sname: showContent
			? label(session && "sessionName" in session ? session.sessionName : undefined, 200)
			: undefined,
		agent: showContent
			? label(session && "agent" in session ? session.agent : undefined, 64)
			: undefined,
		machine: showContent
			? label(session && "machine" in session ? session.machine : undefined, 128)
			: undefined,
		status: session && "status" in session ? session.status : undefined,
		pending: session && "pending" in session ? clampInt(session.pending, 0, 100_000) : undefined,
		hitlId: event.type === "hitl_opened" ? event.hitlId : undefined,
		proposalId: event.type === "hitl_opened" ? event.proposalId : undefined,
		promptHash: event.type === "hitl_opened" ? event.promptHash : undefined,
		actionRequestId: event.type === "action_request_opened" ? event.actionRequestId : undefined,
		actionKind: event.type === "action_request_opened" ? event.actionKind : undefined,
		launchId: event.type === "launch_status" ? event.launchId : undefined,
		threadId: event.type === "ask_reply" ? event.threadId : undefined,
		assistantMessageId: event.type === "ask_reply" ? event.assistantMessageId : undefined,
		durationSec:
			event.type === "session_failed" || event.type === "session_completed"
				? clampInt(event.durationSec, 0, 31_536_000)
				: undefined,
		toolCount:
			event.type === "session_failed" || event.type === "session_completed"
				? clampInt(event.toolCount, 0, 1_000_000)
				: undefined,
		text,
	};
	for (const key of Object.keys(candidate)) if (candidate[key] === undefined) delete candidate[key];

	const required = z.object({ kid: shortId, pid: shortId, ref: shortId }).safeParse(candidate);
	if (!required.success) return { ok: false, reason: "invalid_device_identity" };

	// Drop optional members that don't meet the schema, then require the whole to.
	const whole = PushPayloadSchema.safeParse(candidate);
	if (whole.success) return { ok: true, payload: whole.data as PushPayload };
	for (const issue of whole.error.issues) {
		const key = issue.path[0];
		if (
			typeof key === "string" &&
			!["v", "kid", "pid", "ts", "ref", "t", "cat", "il"].includes(key)
		)
			delete candidate[key];
	}
	const retried = PushPayloadSchema.safeParse(candidate);
	return retried.success
		? { ok: true, payload: retried.data as PushPayload }
		: { ok: false, reason: "invalid_payload" };
}
