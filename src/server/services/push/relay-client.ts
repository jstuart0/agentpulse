/**
 * The server's side of the push relay's `POST /v1/push`.
 *
 * The relay holds the one APNs key; this server holds a per-phone send token
 * and sealed payloads it cannot be tricked into leaking. So the client does
 * four things and nothing else: it posts exactly the members the relay allows,
 * it authenticates with the send token, it turns each answer into a result the
 * push service can act on, and it stops hammering a relay that is down.
 *
 * Safety rules: the configured URL is canonicalized once (https, no userinfo,
 * query or fragment; loopback only outside production). The URL is operator-trusted: it comes from the
 * server's own configuration, never from a client or a stored record, and the relay it names is sent
 * every device id, send token and sealed envelope. A redirect is never
 * followed; every request has a timeout; the send token, the envelope and the
 * response body are never logged.
 */
import type { RelayEnvelope } from "./hpke-seal.js";
import {
	type Clock,
	type PushLogger,
	type RelayPriority,
	consolePushLogger,
	systemClock,
} from "./types.js";

export const RELAY_URL_ENV = "AGENTPULSE_PUSH_RELAY_URL";
export const RELAY_TIMEOUT_MS = 5_000;
export const BREAKER_FAILURE_THRESHOLD = 5;
export const BREAKER_OPEN_MS = 60_000;
/** The longest Retry-After the client will relay to callers, in seconds. */
const MAX_RETRY_AFTER_SEC = 3600;
const MAX_RESPONSE_BYTES = 16 * 1024;
const ENVELOPE_KEYS = ["c", "d", "e", "p", "v"];

export class RelayUrlError extends Error {
	override readonly name = "RelayUrlError";
}

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/**
 * The relay URL, canonicalized to `origin + path` with no trailing slash. https
 * only; plain http is accepted for loopback, and loopback itself only when
 * `allowLoopback` (outside production). Userinfo, query and fragment are refused
 * rather than stripped: a URL that carries them is a mistake worth surfacing.
 */
export function canonicalizeRelayUrl(raw: string, options: { allowLoopback: boolean }): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new RelayUrlError(`${RELAY_URL_ENV} is not a valid URL`);
	}
	if (url.username || url.password)
		throw new RelayUrlError(`${RELAY_URL_ENV} must not contain credentials`);
	if (url.search || url.hash)
		throw new RelayUrlError(`${RELAY_URL_ENV} must not contain a query or fragment`);
	const loopback = LOOPBACK_HOST.test(url.hostname);
	if (loopback && !options.allowLoopback) {
		throw new RelayUrlError(`${RELAY_URL_ENV} must not point at a loopback address in production`);
	}
	if (url.protocol === "http:" && !loopback) {
		throw new RelayUrlError(`${RELAY_URL_ENV} must use https`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new RelayUrlError(`${RELAY_URL_ENV} must use https`);
	}
	return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The configured relay URL, or null when push is not set up. A set but invalid value throws: that is a misconfiguration, not "off". */
export function loadRelayUrl(env: Record<string, string | undefined> = process.env): string | null {
	const raw = env[RELAY_URL_ENV];
	if (raw === undefined || raw.trim() === "") return null;
	return canonicalizeRelayUrl(raw, { allowLoopback: env.NODE_ENV !== "production" });
}

export interface AlertRequest {
	envelope: RelayEnvelope;
	priority: RelayPriority;
	collapseId?: string;
}

export interface LiveActivityRequest {
	slot: string;
	generation: number;
	event: "update" | "end";
	contentState: Record<string, unknown>;
	staleDate?: number;
	dismissalDate?: number;
}

export type FailureReason = "network" | "timeout" | "redirect" | "server_error";

/** What a post came to. The push service branches on `kind`; nothing here throws for a relay answer. */
export type RelayResult =
	| { kind: "accepted"; pushId: string | null }
	/** 410: the device (or one Live Activity slot) is gone at APNs. */
	| { kind: "gone"; gone: "device" | "activity" }
	/** 429: a relay budget is spent. Alerts and activities have separate budgets. */
	| { kind: "budget"; budget: "alert" | "activity"; retryAfterSec: number | null }
	/** 401: the send token is revoked or wrong. Stop using it. */
	/** 401. `confirmed` is true only when the body is the relay's own `{error:"unauthorized"}`; a proxy or SSO 401 is not. */
	| { kind: "unauthorized"; confirmed: boolean }
	/** Any other 4xx: this request will not succeed as sent. */
	| { kind: "rejected"; status: number; error: string | null }
	/** Network error, timeout, redirect, or 5xx. Counts toward the breaker. */
	| {
			kind: "unavailable";
			reason: FailureReason;
			status: number | null;
			retryAfterSec: number | null;
	  }
	/** The breaker is open: nothing was sent. */
	| { kind: "circuit_open"; retryAfterSec: number };

export interface RelayClientOptions {
	/** Already canonical (see `canonicalizeRelayUrl`). */
	relayUrl: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
	failureThreshold?: number;
	openMs?: number;
	clock?: Clock;
	logger?: PushLogger;
}

export class RelayClient {
	private readonly relayUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly failureThreshold: number;
	private readonly openMs: number;
	private readonly clock: Clock;
	private readonly logger: PushLogger;
	private consecutiveFailures = 0;
	private openUntil = 0;
	private probing = false;

	constructor(options: RelayClientOptions) {
		this.relayUrl = options.relayUrl;
		this.fetchImpl = options.fetch ?? fetch;
		this.timeoutMs = options.timeoutMs ?? RELAY_TIMEOUT_MS;
		this.failureThreshold = options.failureThreshold ?? BREAKER_FAILURE_THRESHOLD;
		this.openMs = options.openMs ?? BREAKER_OPEN_MS;
		this.clock = options.clock ?? systemClock;
		this.logger = options.logger ?? consolePushLogger;
	}

	postAlert(sendToken: string, request: AlertRequest): Promise<RelayResult> {
		const keys = Object.keys(request.envelope).sort();
		if (keys.join() !== ENVELOPE_KEYS.join()) {
			throw new Error("relay envelope must have exactly the members v, e, c, d, p");
		}
		const body: Record<string, unknown> = {
			kind: "alert",
			envelope: request.envelope,
			priority: request.priority,
		};
		if (request.collapseId !== undefined) body.collapseId = request.collapseId;
		return this.post(sendToken, body, "alert");
	}

	postLiveActivity(sendToken: string, request: LiveActivityRequest): Promise<RelayResult> {
		const body: Record<string, unknown> = {
			kind: "liveactivity",
			slot: request.slot,
			generation: request.generation,
			event: request.event,
			contentState: request.contentState,
		};
		if (request.staleDate !== undefined) body.staleDate = request.staleDate;
		if (request.dismissalDate !== undefined) body.dismissalDate = request.dismissalDate;
		return this.post(sendToken, body, "activity");
	}

	/** True while the breaker is refusing sends. */
	get circuitOpen(): boolean {
		return this.clock.now() < this.openUntil;
	}

	private async post(
		sendToken: string,
		body: Record<string, unknown>,
		budget: "alert" | "activity",
	): Promise<RelayResult> {
		const admission = this.admit();
		if (admission !== null) return { kind: "circuit_open", retryAfterSec: admission };

		let response: Response;
		try {
			response = await this.fetchImpl(`${this.relayUrl}/v1/push`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${sendToken}`,
					"content-type": "application/json",
					accept: "application/json",
				},
				body: JSON.stringify(body),
				// "manual" so a redirect arrives as a 3xx we can name; it is never followed.
				redirect: "manual",
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (err) {
			const reason: FailureReason = isTimeout(err) ? "timeout" : "network";
			return this.failed({ kind: "unavailable", reason, status: null, retryAfterSec: null });
		}

		const status = response.status;
		if (status >= 300 && status < 400) {
			await response.body?.cancel().catch(() => undefined);
			return this.failed({ kind: "unavailable", reason: "redirect", status, retryAfterSec: null });
		}
		const read = await readJson(response);
		// A body that stalls or is cut mid-read says nothing about what the relay meant; only a 202 stands without it.
		if (read === null && status !== 202) {
			return this.failed({ kind: "unavailable", reason: "timeout", status, retryAfterSec: null });
		}
		const parsed = read ?? {};
		const retryAfterSec = parseRetryAfter(response.headers.get("retry-after"));

		if (status >= 500) {
			return this.failed({ kind: "unavailable", reason: "server_error", status, retryAfterSec });
		}
		// An answer from the relay, whatever it says, proves the relay is up.
		this.succeeded();

		if (status === 202) {
			return { kind: "accepted", pushId: typeof parsed.pushId === "string" ? parsed.pushId : null };
		}
		if (status === 410 && (parsed.gone === "device" || parsed.gone === "activity")) {
			return { kind: "gone", gone: parsed.gone };
		}
		if (status === 429) {
			const which =
				parsed.budget === "alert" || parsed.budget === "activity" ? parsed.budget : budget;
			this.logger.warn("relay budget spent", { budget: which, retryAfterSec: retryAfterSec ?? -1 });
			return { kind: "budget", budget: which, retryAfterSec };
		}
		if (status === 401) return { kind: "unauthorized", confirmed: parsed.error === "unauthorized" };
		return {
			kind: "rejected",
			status,
			error:
				typeof parsed.error === "string" && /^[a-z0-9_]{1,40}$/.test(parsed.error)
					? parsed.error
					: null,
		};
	}

	/** Null to proceed; otherwise the seconds until the breaker will admit a probe. */
	private admit(): number | null {
		const now = this.clock.now();
		if (this.consecutiveFailures < this.failureThreshold) return null;
		if (now < this.openUntil) return Math.max(1, Math.ceil((this.openUntil - now) / 1000));
		if (this.probing) return 1;
		this.probing = true;
		return null;
	}

	private failed(result: Extract<RelayResult, { kind: "unavailable" }>): RelayResult {
		const wasOpen = this.consecutiveFailures >= this.failureThreshold;
		this.consecutiveFailures += 1;
		this.probing = false;
		if (this.consecutiveFailures >= this.failureThreshold) {
			this.openUntil = this.clock.now() + this.openMs;
			// Said once when it opens, and again only if a probe fails and it reopens.
			this.logger.warn(wasOpen ? "relay circuit reopened" : "relay circuit open", {
				failures: this.consecutiveFailures,
				openSec: this.openMs / 1000,
			});
		}
		this.logger.warn("relay request failed", {
			reason: result.reason,
			...(result.status !== null ? { status: result.status } : {}),
		});
		return result;
	}

	private succeeded(): void {
		if (this.consecutiveFailures >= this.failureThreshold) this.logger.info("relay circuit closed");
		this.consecutiveFailures = 0;
		this.probing = false;
	}
}

function isTimeout(err: unknown): boolean {
	return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** Whole seconds from a Retry-After header, or null for anything else (an HTTP date, junk, a negative). */
function parseRetryAfter(value: string | null): number | null {
	if (value === null || !/^\d{1,6}$/.test(value.trim())) return null;
	return Math.min(MAX_RETRY_AFTER_SEC, Number(value.trim()));
}

/** The body as an object ({} when it isn't one or is too big), or null when reading it failed or was cut off. */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
	const bytes = await readCapped(response);
	if (bytes === null) return null;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** The body bytes, an empty array when it is over the cap (cancelled), or null when reading failed. */
async function readCapped(response: Response): Promise<Uint8Array | null> {
	try {
		const reader = response.body?.getReader();
		if (!reader) return new Uint8Array();
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				return new Uint8Array();
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks);
	} catch {
		return null;
	}
}
