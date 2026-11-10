/**
 * Which Hosts and Origins a request may come from.
 *
 * With authentication off (AGEN-92), `authOffRequestGate()` is mounted first on
 * every /api and /app-api request. It refuses a Host that couldn't be an
 * address the user opened (DNS rebinding) and a request a browser marks as
 * coming from another site. The WebSocket upgrade is a separate enforcement
 * point (`ws/ws-auth.ts`) that shares the Host and Origin rules below.
 *
 * For the routes that refuse a foreign Origin (the admin routes' mutations) and
 * for the upgrade: the configured allowlist (PUBLIC_URL, plus any dev origins),
 * or the request's own origin. The second is what lets a default install work
 * when it is reached on an address other than its configured public URL.
 */
import type { Context, MiddlewareHandler } from "hono";
import { config } from "../config.js";

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/** "host:port" with the scheme's default port made explicit, lower-cased, for comparing an Origin with a Host header. */
function hostAndPort(host: string, protocol: string): string {
	const lowered = host.toLowerCase();
	return /:[0-9]+$/.test(lowered) ? lowered : `${lowered}:${DEFAULT_PORTS[protocol] ?? ""}`;
}

/**
 * Is this Origin the request's own (plain same-origin)? Its host and port must
 * equal the Host header, and it must be a bare origin: a path, query, fragment
 * or userinfo makes it something else, however much it looks like the host.
 * The literal "null" (sandboxed or cross-origin redirects) never is.
 */
function isSameOrigin(
	origin: string,
	hostHeader: string | undefined,
	requestScheme?: string,
): boolean {
	if (!hostHeader) return false;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	const bare = url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
	if (!bare || origin.endsWith("/") || /[?#@]/.test(origin)) return false;
	if (!config.disableAuth) {
		return hostAndPort(url.host, url.protocol) === hostAndPort(hostHeader, url.protocol);
	}
	// Authentication off (AGEN-92): the scheme counts. The Host header names no scheme, so the request's own
	// (from its URL: nothing here trusts X-Forwarded-Proto) supplies it and the default port. An unknown
	// scheme fails closed, and so does an Origin of the other scheme (http://h against https://h).
	if (requestScheme !== "http:" && requestScheme !== "https:") return false;
	if (url.protocol !== requestScheme) return false;
	const host = parseHost(hostHeader);
	if (!host) return false;
	const originHost = parseHost(url.host);
	if (!originHost || originHost.hostname !== host.hostname) return false;
	const defaultPort = DEFAULT_PORTS[requestScheme];
	return (originHost.port ?? defaultPort) === (host.port ?? defaultPort);
}

/** The scheme of a request URL ("http:" or "https:"), or undefined when it can't be read. */
export function schemeOfRequestUrl(url: string): string | undefined {
	try {
		return new URL(url).protocol;
	} catch {
		return undefined;
	}
}

/**
 * An HTTP request's Origin: the configured allowlist always passes (a request
 * with no Host included), anything else by the socket rule, so the same-origin
 * shortcut is closed to DNS rebinding when authentication is off.
 */
export function isAcceptedRequestOrigin(
	origin: string,
	hostHeader: string | undefined,
	requestScheme?: string,
): boolean {
	return isAllowedOrigin(origin) || isAcceptedSocketOrigin(origin, hostHeader, requestScheme);
}

const IPV4_QUAD =
	/^(?:(?:0|[1-9][0-9]?|1[0-9][0-9]|2[0-4][0-9]|25[0-5])\.){3}(?:0|[1-9][0-9]?|1[0-9][0-9]|2[0-4][0-9]|25[0-5])$/;
const LDH_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const PORT = /^[0-9]{1,5}$/;
const VITE_DEV_PORT = "5173";

export interface ParsedHost {
	/** Lower-cased, one trailing dot dropped, IPv6 in brackets. */
	hostname: string;
	port: string | null;
}

function validPort(port: string | undefined): string | null | false {
	if (port === undefined) return null;
	if (!PORT.test(port)) return false;
	const n = Number(port);
	return n >= 1 && n <= 65535 ? port : false;
}

/**
 * A Host header, parsed as a whole string: `hostname[:port]` or
 * `[IPv6][:port]`. Hostnames are LDH labels joined by dots (one trailing dot
 * allowed and dropped); anything else (a suffix after `]`, a zone id, stray
 * colons, spaces, an empty string) is null, never a best-effort guess.
 */
export function parseHost(hostHeader: string): ParsedHost | null {
	const lowered = hostHeader.toLowerCase();
	if (lowered.startsWith("[")) {
		const match = /^\[([0-9a-f:.]+)\](?::([0-9]+))?$/.exec(lowered);
		if (!match) return null;
		const port = validPort(match[2]);
		if (port === false) return null;
		// Canonicalise through URL ([0:0:0:0:0:0:0:1] and [::1] are one address); the regex above has
		// already limited the input to hex digits, colons and dots.
		try {
			return { hostname: new URL(`http://[${match[1]}]/`).hostname, port };
		} catch {
			return null;
		}
	}
	const match = /^([^:]*)(?::([0-9]+))?$/.exec(lowered);
	if (!match) return null;
	const port = validPort(match[2]);
	if (port === false) return null;
	const name = (match[1] as string).replace(/\.$/, "");
	if (!LDH_NAME.test(name)) return null;
	return { hostname: name, port };
}

function isIpLiteral(hostname: string): boolean {
	return hostname.startsWith("[") || IPV4_QUAD.test(hostname);
}

function isLoopbackHostname(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	return IPV4_QUAD.test(hostname) && hostname.startsWith("127.");
}

interface AllowList {
	origins: string[];
	hostnames: Set<string>;
	malformed: string[];
}

let allowListCache: { raw: string; value: AllowList } | null = null;

/** PUBLIC_URL parsed entry by entry, memoised on the raw string. A malformed entry is skipped and listed, never thrown. */
function allowList(): AllowList {
	const raw = process.env.PUBLIC_URL || "http://localhost:3000";
	if (allowListCache?.raw === raw) return allowListCache.value;
	const value: AllowList = { origins: [], hostnames: new Set(), malformed: [] };
	for (const entry of raw
		.split(",")
		.map((u) => u.trim())
		.filter(Boolean)) {
		try {
			const url = new URL(entry);
			const parsed = parseHost(url.host);
			if (!parsed || url.origin === "null") throw new Error("not an origin");
			value.origins.push(url.origin);
			value.hostnames.add(parsed.hostname);
		} catch {
			value.malformed.push(entry);
		}
	}
	allowListCache = { raw, value };
	return value;
}

/** The hostnames named by PUBLIC_URL, normalised like a parsed Host. */
export function allowedHostnames(): ReadonlySet<string> {
	return allowList().hostnames;
}

function isAllowedOrigin(origin: string): boolean {
	return allowList().origins.includes(origin);
}

/** Is the Host one of the names on the configured allowlist? */
function isAllowlistedHost(hostHeader: string): boolean {
	const parsed = parseHost(hostHeader);
	return parsed !== null && allowList().hostnames.has(parsed.hostname);
}

/**
 * With authentication off, is this Host one the page could legitimately have
 * been loaded from: a loopback address, an IP literal (only a page served at
 * that address sends it) or an allowlisted name? A page reached through DNS
 * rebinding has Origin equal to Host and a Host that is the attacker's name,
 * so "same origin" alone proves nothing there.
 */
export function isTrustedHostWhenAuthOff(hostHeader: string | undefined): boolean {
	if (!hostHeader) return false;
	const parsed = parseHost(hostHeader);
	if (!parsed) return false;
	return (
		isLoopbackHostname(parsed.hostname) ||
		isIpLiteral(parsed.hostname) ||
		isAllowlistedHost(hostHeader)
	);
}

/** Is this Content-Type `application/json` (parameters allowed)? A cross-site form post can't send it. */
export function isJsonContentType(value: string | undefined): boolean {
	return value !== undefined && /^application\/json\s*(;|$)/i.test(value.trim());
}

/** Is the Host a loopback address (a client on this machine)? */
export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
	if (!hostHeader) return false;
	const parsed = parseHost(hostHeader);
	return parsed !== null && isLoopbackHostname(parsed.hostname);
}

/**
 * Is this Origin a bare http(s) origin on a loopback address (any port)? A
 * whole-string match: no path, userinfo, query, fragment or trailing dot, and
 * no name that merely starts with "localhost" or "127.".
 */
export function isLoopbackOrigin(origin: string): boolean {
	const match =
		/^(https?):\/\/(localhost|\[::1\]|[0-9]{1,3}(?:\.[0-9]{1,3}){3})(:[0-9]{1,5})?$/i.exec(origin);
	if (!match) return false;
	if (!isLoopbackHostHeader(`${match[2]}${match[3] ?? ""}`)) return false;
	const defaultPort = DEFAULT_PORTS[`${(match[1] as string).toLowerCase()}:`];
	const port = match[3] ? (match[3] as string).slice(1) : defaultPort;
	// The server's own port, and (outside production) the Vite dev server's.
	return port === String(config.port) || (!config.isProduction && port === VITE_DEV_PORT);
}

/**
 * Which Origins may open the live-update socket. The configured allowlist is
 * accepted. Beyond it an Origin equal to the request's own is accepted too, so
 * an install reached on another address still gets live updates, but with
 * authentication off that rule would let any page whose name resolves to this
 * machine in (DNS rebinding), so there it holds only when the Host is a
 * loopback address, an IP literal or an allowlisted name. A request with no
 * Host is refused.
 */
export function isAcceptedSocketOrigin(
	origin: string,
	hostHeader: string | undefined,
	requestScheme?: string,
): boolean {
	if (!hostHeader) return false;
	if (isAllowedOrigin(origin)) return true;
	if (!isSameOrigin(origin, hostHeader, requestScheme)) return false;
	if (!config.disableAuth) return true;
	return isTrustedHostWhenAuthOff(hostHeader);
}

export const HOST_REFUSED_MESSAGE =
	"With authentication off, AgentPulse answers only on localhost, an IP address, or a name listed in PUBLIC_URL.";
export const CROSS_SITE_REFUSED_MESSAGE =
	"With authentication off, AgentPulse refuses requests from other websites.";

// ---- log limiter (D9) ----

const LOG_WINDOW_MS = 60_000;
const LOG_LINES_PER_WINDOW = 5;
const LOG_DISTINCT_CAP = 64;
const LOG_VALUE_CAP = 128;
// Quotes, then control and format characters. Built from a string: a quote inside a regex literal confuses the seam-leak scanner.
// biome-ignore lint/complexity/useRegexLiterals: a literal here trips the seam-leak scanner
const LOG_STRIP = new RegExp("[\"'`\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]", "gu");

type RefusalKind = "host" | "cross";

interface KindState {
	windowStart: number;
	printed: number;
	suppressed: number;
	seen: Set<string>;
	distinct: Set<string>;
}

let logClock: () => number = () => Date.now();
const kindStates = new Map<RefusalKind, KindState>();
let summaryTimer: ReturnType<typeof setTimeout> | null = null;

/** For tests: the limiter's clock, and a clean slate. */
export function __resetAuthOffGateLogForTests(clock?: () => number): void {
	logClock = clock ?? (() => Date.now());
	kindStates.clear();
	if (summaryTimer) clearTimeout(summaryTimer);
	summaryTimer = null;
}

/** Quotes, control, format and line or paragraph separator characters out, 128 characters at most. */
function cleanForLog(value: string): string {
	return value.replace(LOG_STRIP, "").slice(0, LOG_VALUE_CAP);
}

function flushSummary(kind: RefusalKind, state: KindState): void {
	if (state.suppressed === 0) return;
	const noun = kind === "host" ? "Hosts" : "Origins";
	console.warn(
		`[auth] ${state.suppressed} more requests refused in the last minute (${state.distinct.size} distinct ${noun})`,
	);
}

function flushAllExpired(): void {
	const now = logClock();
	for (const [kind, state] of kindStates) {
		if (now - state.windowStart >= LOG_WINDOW_MS) {
			flushSummary(kind, state);
			kindStates.delete(kind);
		}
	}
	summaryTimer = null;
}

function logRefusal(kind: RefusalKind, rawValue: string): void {
	const now = logClock();
	let state = kindStates.get(kind);
	if (state && now - state.windowStart >= LOG_WINDOW_MS) {
		flushSummary(kind, state);
		state = undefined;
	}
	if (!state) {
		state = { windowStart: now, printed: 0, suppressed: 0, seen: new Set(), distinct: new Set() };
		kindStates.set(kind, state);
	}
	const value = cleanForLog(rawValue);
	if (state.distinct.size < LOG_DISTINCT_CAP) state.distinct.add(value);
	if (state.printed < LOG_LINES_PER_WINDOW && !state.seen.has(value)) {
		state.printed += 1;
		state.seen.add(value);
		console.warn(
			kind === "host"
				? `[auth] refused a request: Host ${value} is not localhost, an IP address, or a PUBLIC_URL name (authentication is off). If you opened AgentPulse at this name on purpose, see README "Opening an auth-off server by name".`
				: `[auth] refused a cross-site request from Origin ${value} (authentication is off).`,
		);
	} else {
		state.suppressed += 1;
	}
	if (!summaryTimer) {
		summaryTimer = setTimeout(flushAllExpired, LOG_WINDOW_MS + 50);
		summaryTimer.unref?.();
	}
}

/** Boot: say once what the gate accepts, and name any PUBLIC_URL entry it couldn't read. */
export function logAuthOffBootRule(): void {
	const { hostnames, malformed } = allowList();
	console.warn(
		`[auth] With authentication off, requests are accepted only for localhost, an IP address, or these PUBLIC_URL names: ${[...hostnames].join(", ") || "(none)"}. Requests from other websites are refused.`,
	);
	for (const entry of malformed) {
		console.warn(`[auth] PUBLIC_URL entry ignored (not a URL): ${cleanForLog(entry)}`);
	}
}

function refusal(c: Context, message: string): Response {
	return c.json({ error: "bad_origin", message }, 403);
}

/**
 * With authentication off, refuses (403 bad_origin) a request whose Host
 * couldn't be an address the user opened, and a request a browser marks as
 * cross-site. Mount it first on /api and /app-api. With authentication on it
 * returns before reading any header.
 *
 * No Host header passes (a browser always sends one; HTTP/1.0 tools and
 * in-process tests don't). No Origin and no Sec-Fetch-Site passes (curl, the
 * relay, the supervisor, MCP, hooks). An Origin must be allowlisted, the
 * request's own on a trusted Host, or a loopback origin on any port;
 * `Origin: null` is refused. Sec-Fetch-Site: cross-site is refused unless the
 * Origin is allowlisted.
 */
export function authOffRequestGate(): MiddlewareHandler {
	return async (c, next) => {
		if (!config.disableAuth) return next();
		const host = c.req.header("Host");
		if (host !== undefined && !isTrustedHostWhenAuthOff(host)) {
			logRefusal("host", host);
			return refusal(c, HOST_REFUSED_MESSAGE);
		}
		const origin = c.req.header("Origin");
		const allowlisted = origin !== undefined && isAllowedOrigin(origin);
		if (c.req.header("Sec-Fetch-Site") === "cross-site" && !allowlisted) {
			logRefusal("cross", origin ?? "(none)");
			return refusal(c, CROSS_SITE_REFUSED_MESSAGE);
		}
		if (
			origin !== undefined &&
			!allowlisted &&
			!(host !== undefined && isSameOrigin(origin, host, schemeOfRequestUrl(c.req.url))) &&
			!isLoopbackOrigin(origin)
		) {
			logRefusal("cross", origin);
			return refusal(c, CROSS_SITE_REFUSED_MESSAGE);
		}
		return next();
	};
}
