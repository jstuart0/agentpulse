/**
 * Strict parsing of the watcher config PUT body. The handler used to spread
 * the raw body into the upsert, so any field (including `policy: "auto"`) was
 * accepted from any manage-scoped key. Now the shape is checked here: unknown
 * keys are refused, every value has a type and a range, and the pieces that
 * need the database (the provider, the channel) are checked by the handler
 * with the values this returns.
 */
import { WATCHER_POLICIES } from "../../shared/types.js";
import type { WatcherPolicy } from "../services/ai/watcher-config-service.js";

export const WATCHER_SYSTEM_PROMPT_MAX_CHARS = 4_000;
export const WATCHER_MAX_CONTINUATIONS_LIMIT = 50;

const ALLOWED_KEYS = [
	"enabled",
	"notifyEnabled",
	"continueEnabled",
	"providerId",
	"policy",
	"channelId",
	"maxContinuations",
	"maxDailyCents",
	"systemPrompt",
	"resetContinuations",
] as const;

export interface ParsedWatcherUpdate {
	enabled?: boolean;
	notifyEnabled?: boolean;
	continueEnabled?: boolean;
	providerId?: string;
	policy?: WatcherPolicy;
	channelId?: string | null;
	maxContinuations?: number;
	maxDailyCents?: number | null;
	systemPrompt?: string | null;
	/** Always true when present: false is the same as omitting it. */
	resetContinuations?: true;
}

export type WatcherUpdateParse =
	| { ok: true; value: ParsedWatcherUpdate }
	| { ok: false; error: "invalid_body" | "unknown_field" | "invalid_field"; field?: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWatcherUpdate(body: unknown): WatcherUpdateParse {
	if (!isPlainObject(body)) return { ok: false, error: "invalid_body" };
	for (const key of Object.keys(body)) {
		if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
			return { ok: false, error: "unknown_field", field: key };
		}
	}

	const value: ParsedWatcherUpdate = {};
	const invalid = (field: string): WatcherUpdateParse => ({
		ok: false,
		error: "invalid_field",
		field,
	});

	for (const key of ["enabled", "notifyEnabled", "continueEnabled"] as const) {
		if (body[key] === undefined) continue;
		if (typeof body[key] !== "boolean") return invalid(key);
		value[key] = body[key];
	}
	if (body.resetContinuations !== undefined) {
		if (typeof body.resetContinuations !== "boolean") return invalid("resetContinuations");
		if (body.resetContinuations) value.resetContinuations = true;
	}
	if (body.providerId !== undefined) {
		if (typeof body.providerId !== "string" || body.providerId === "") return invalid("providerId");
		value.providerId = body.providerId;
	}
	if (body.policy !== undefined) {
		if (!(WATCHER_POLICIES as readonly unknown[]).includes(body.policy)) return invalid("policy");
		value.policy = body.policy as WatcherPolicy;
	}
	if (body.channelId !== undefined) {
		if (body.channelId !== null && (typeof body.channelId !== "string" || body.channelId === "")) {
			return invalid("channelId");
		}
		value.channelId = body.channelId as string | null;
	}
	if (body.maxContinuations !== undefined) {
		const n = body.maxContinuations;
		if (
			!Number.isInteger(n) ||
			(n as number) < 0 ||
			(n as number) > WATCHER_MAX_CONTINUATIONS_LIMIT
		) {
			return invalid("maxContinuations");
		}
		value.maxContinuations = n as number;
	}
	if (body.maxDailyCents !== undefined) {
		const n = body.maxDailyCents;
		if (n !== null && (!Number.isInteger(n) || (n as number) < 0)) return invalid("maxDailyCents");
		value.maxDailyCents = n as number | null;
	}
	if (body.systemPrompt !== undefined) {
		const text = body.systemPrompt;
		if (
			text !== null &&
			(typeof text !== "string" || text.length > WATCHER_SYSTEM_PROMPT_MAX_CHARS)
		) {
			return invalid("systemPrompt");
		}
		value.systemPrompt = text as string | null;
	}
	return { ok: true, value };
}
