/**
 * Which Origins a request may come from, for the routes that refuse a foreign
 * one (the admin routes' mutations) and for the WebSocket upgrade: the
 * configured allowlist (PUBLIC_URL, plus any dev origins), or the request's own
 * origin. The second is what lets a default install work when it is reached on
 * an address other than its configured public URL.
 */
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
function isSameOrigin(origin: string, hostHeader: string | undefined): boolean {
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
	return hostAndPort(url.host, url.protocol) === hostAndPort(hostHeader, url.protocol);
}

/** Is this Origin on the configured allowlist, or the request's own? */
export function isAcceptedOrigin(origin: string, hostHeader: string | undefined): boolean {
	return config.allowedOrigins.includes(origin) || isSameOrigin(origin, hostHeader);
}

/** The hostname of a Host header: lower-cased, without the port, IPv6 brackets kept. */
function hostnameOf(hostHeader: string): string {
	const lowered = hostHeader.toLowerCase();
	if (lowered.startsWith("[")) return lowered.slice(0, lowered.indexOf("]") + 1);
	return lowered.replace(/:[0-9]+$/, "");
}

const IPV4_LOOPBACK =
	/^127\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$/;

/** localhost, anything in 127.0.0.0/8, or ::1. */
function isLoopbackHost(hostHeader: string): boolean {
	const hostname = hostnameOf(hostHeader);
	return hostname === "localhost" || hostname === "[::1]" || IPV4_LOOPBACK.test(hostname);
}

/** Is the Host one of the names on the configured allowlist? */
function isAllowlistedHost(hostHeader: string): boolean {
	const hostname = hostnameOf(hostHeader);
	return config.allowedOrigins.some((allowed) => new URL(allowed).hostname === hostname);
}

/**
 * Which Origins may open the live-update socket. The configured allowlist is
 * accepted. Beyond it an Origin equal to the request's own is accepted too, so
 * an install reached on another address still gets live updates, but with
 * authentication off that rule would let any page whose name resolves to this
 * machine in (DNS rebinding), so there it holds only when the Host is a
 * loopback address or an allowlisted name. A request with no Host is refused.
 */
export function isAcceptedSocketOrigin(origin: string, hostHeader: string | undefined): boolean {
	if (!hostHeader) return false;
	if (config.allowedOrigins.includes(origin)) return true;
	if (!isSameOrigin(origin, hostHeader)) return false;
	if (!config.disableAuth) return true;
	return isLoopbackHost(hostHeader) || isAllowlistedHost(hostHeader);
}
