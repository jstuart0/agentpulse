/**
 * Trusted client IP resolution.
 *
 * Uses Hono's `getConnInfo` (backed by `Bun.serve`'s `server.requestIP()`)
 * to read the TCP peer address, then conditionally trusts the leftmost
 * `X-Forwarded-For` entry only when the peer falls within a trusted CIDR
 * from `AGENTPULSE_TRUSTED_PROXIES`.
 *
 * Plan B (future): if the Hono bun adapter import path changes in a Hono
 * minor, stash `server.requestIP(req).address` on context in the `Bun.serve`
 * fetch handler (`c.set("peerIp", ...)`) before any route handler runs.
 * The `package.json` Hono pin (P15) bounds this risk.
 */

import type { Context } from "hono";
import { getConnInfo } from "hono/bun";

// ── CIDR types ──────────────────────────────────────────────────────────────

export interface ParsedCidr {
	/** The network address as a 32-bit unsigned integer (IPv4 only). */
	network: number;
	/** The subnet mask as a 32-bit unsigned integer. */
	mask: number;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Parse a dotted-decimal IPv4 string into a 32-bit unsigned integer.
 * Returns null if the string is not a valid IPv4 address.
 */
function ipv4ToUint32(addr: string): number | null {
	const parts = addr.split(".");
	if (parts.length !== 4) return null;
	let result = 0;
	for (const part of parts) {
		const n = Number(part);
		if (!Number.isInteger(n) || n < 0 || n > 255 || part === "") return null;
		result = (result * 256 + n) >>> 0;
	}
	return result;
}

// Allowlist of characters that can appear in an IP address string.
// Accepts IPv4 dotted-decimal and IPv6 (including bracket notation for
// hosts in URLs). Anything else — especially shell metacharacters — is
// rejected so that XFF values with injected commands cannot reach callers.
const SAFE_IP_CHARS = /^[0-9a-fA-F:.[\]]+$/;

/**
 * Returns true if `addr` is a syntactically valid IPv4 or IPv6 address.
 *
 * For IPv6: only character-class validation is performed (no full RFC 4291
 * parse) since the CIDR-match path below rejects IPv6 anyway. The check
 * prevents XFF values that contain shell metacharacters or other injection
 * payloads from reaching callers.
 */
export function isValidIp(addr: string): boolean {
	if (!addr || !SAFE_IP_CHARS.test(addr)) return false;
	// IPv6 — pass through after character validation.
	if (addr.includes(":")) return true;
	return ipv4ToUint32(addr) !== null;
}

/**
 * The key a client counts under in a per-client limit. IPv4 is itself. An IPv6
 * address is reduced to its /64, because one subscriber is routinely given a whole
 * /64 and could otherwise rotate through 2^64 addresses; an IPv4-mapped IPv6
 * address counts as the IPv4 address. Anything that doesn't parse is its own key.
 */
export function rateLimitKeyForIp(addr: string): string {
	const bare = addr
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/%.*$/, "");
	const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	if (mapped) return mapped[1] as string;
	if (!bare.includes(":")) return bare;

	const halves = bare.split("::");
	if (halves.length > 2) return bare;
	const head = halves[0] ? (halves[0] as string).split(":") : [];
	const tail = halves.length === 2 && halves[1] ? (halves[1] as string).split(":") : [];
	const missing = 8 - head.length - tail.length;
	if (halves.length === 1 ? head.length !== 8 : missing < 1) return bare;
	const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
	if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return bare;
	return `${groups
		.slice(0, 4)
		.map((g) => g.padStart(4, "0"))
		.join(":")}::/64`;
}

/**
 * Parse a comma-separated list of CIDR strings into `ParsedCidr` objects.
 * Entries that cannot be parsed are silently skipped (logged at debug level).
 */
export function parseCidrList(raw: string): ParsedCidr[] {
	if (!raw.trim()) return [];
	const result: ParsedCidr[] = [];
	for (const entry of raw.split(",")) {
		const cidr = entry.trim();
		if (!cidr) continue;
		const slash = cidr.indexOf("/");
		if (slash === -1) {
			// Host address without prefix — treat as /32.
			const n = ipv4ToUint32(cidr);
			if (n !== null) result.push({ network: n, mask: 0xffffffff });
			else console.warn(JSON.stringify({ kind: "trusted_proxy_parse_error", cidr }));
			continue;
		}
		const host = cidr.slice(0, slash);
		const prefix = Number(cidr.slice(slash + 1));
		if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
			console.warn(JSON.stringify({ kind: "trusted_proxy_parse_error", cidr }));
			continue;
		}
		const n = ipv4ToUint32(host);
		if (n === null) {
			console.warn(JSON.stringify({ kind: "trusted_proxy_parse_error", cidr }));
			continue;
		}
		const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
		result.push({ network: (n & mask) >>> 0, mask });
	}
	return result;
}

// ── Exported API ─────────────────────────────────────────────────────────────

/**
 * Returns true if `addr` (IPv4 dotted-decimal or IPv4-mapped IPv6) falls
 * within any of the provided parsed CIDRs.
 *
 * IPv4-mapped IPv6 addresses (`::ffff:10.x.y.z`) are stripped of their
 * prefix before CIDR matching so that a Traefik or Nginx peer presenting
 * the mapped form is still recognised as a trusted proxy. Plain IPv6
 * addresses (without the `::ffff:` prefix) never match an IPv4 CIDR.
 */
export function isTrustedProxy(addr: string, cidrs: ParsedCidr[]): boolean {
	// Strip IPv4-mapped IPv6 prefix (case-insensitive) before CIDR matching.
	const candidate = addr.replace(/^::ffff:/i, "");
	// Pure IPv6 (still contains `:`) cannot match IPv4 CIDRs.
	if (candidate.includes(":")) return false;
	const n = ipv4ToUint32(candidate);
	if (n === null) return false;
	return cidrs.some((cidr) => (n & cidr.mask) >>> 0 === cidr.network);
}

// ── Misconfiguration check ───────────────────────────────────────────────────

/** Requests (not from loopback) watched before judging a configured AGENTPULSE_TRUSTED_PROXIES. */
export const TRUSTED_PROXY_CHECK_SAMPLES = 25;

const proxyCheck = { samples: 0, trustedPeers: 0, done: false };

function isLoopbackPeer(peer: string): boolean {
	return peer === "::1" || peer.replace(/^::ffff:/i, "").startsWith("127.");
}

/**
 * With AGENTPULSE_TRUSTED_PROXIES set, the first requests should show it working:
 * a peer inside the range that sends X-Forwarded-For. One that does ends the check.
 * If TRUSTED_PROXY_CHECK_SAMPLES requests go by without it, say once (a warning,
 * never a refusal) which half is missing: either no request came from the range, so
 * it doesn't contain the ingress pods, or the ingress isn't forwarding the client
 * address. Either way every client would otherwise count as the ingress.
 */
function checkTrustedProxySetup(peer: string, peerIsTrusted: boolean, forwarded: boolean): void {
	if (proxyCheck.done || isLoopbackPeer(peer)) return;
	if (peerIsTrusted && forwarded) {
		proxyCheck.done = true;
		return;
	}
	proxyCheck.samples++;
	if (peerIsTrusted) proxyCheck.trustedPeers++;
	if (proxyCheck.samples < TRUSTED_PROXY_CHECK_SAMPLES) return;
	proxyCheck.done = true;
	console.warn(
		JSON.stringify({
			kind: "trusted_proxies_unverified",
			level: "warn",
			samples: proxyCheck.samples,
			trustedPeers: proxyCheck.trustedPeers,
			detail:
				proxyCheck.trustedPeers === 0
					? "no request came from a peer inside AGENTPULSE_TRUSTED_PROXIES; the range probably does not contain the ingress pods"
					: "requests came from a trusted peer but none carried X-Forwarded-For; the ingress is not forwarding the client address",
		}),
	);
}

let warnedUnparseable = false;

/** A value that is set but yields no CIDR (an unreplaced placeholder, a typo) behaves like "unset"; say so once. */
function warnOnceIfProxiesUnparseable(raw: string): void {
	if (warnedUnparseable || !raw.trim() || raw.trim() === "undefined") return;
	warnedUnparseable = true;
	console.warn(
		JSON.stringify({
			kind: "trusted_proxies_invalid",
			level: "warn",
			detail:
				"AGENTPULSE_TRUSTED_PROXIES is set but holds no valid CIDR, so X-Forwarded-For is ignored; replace the placeholder with the ingress pods' CIDR",
		}),
	);
}

/** Starts the misconfiguration check over. */
export function _resetTrustedProxyCheckForTest(): void {
	proxyCheck.samples = 0;
	proxyCheck.trustedPeers = 0;
	proxyCheck.done = false;
	warnedUnparseable = false;
}

/**
 * Resolve the trusted client IP from a Hono context.
 *
 * 1. Reads the TCP peer address via `getConnInfo(c).remote.address`.
 * 2. If the peer is in `AGENTPULSE_TRUSTED_PROXIES`, takes the leftmost
 *    syntactically valid entry from `X-Forwarded-For` as the client IP.
 * 3. Malformed or absent XFF from a trusted peer falls back to the peer
 *    address with a structured warning.
 * 4. If no proxies are configured (default), XFF is always ignored.
 *
 * The function never returns undefined or an empty string — it falls back
 * to "0.0.0.0" only when `getConnInfo` cannot read the peer (e.g., in test
 * contexts that do not provide the Bun server handle).
 */
export function getTrustedClientIp(c: Context): string {
	let peer: string;
	try {
		peer = getConnInfo(c).remote.address ?? "0.0.0.0";
	} catch {
		// getConnInfo requires c.env.server (the Bun server handle).
		// In test contexts it is not available; fall back to "0.0.0.0".
		// Callers that need real IP resolution in tests should inject
		// peerIp via c.set() (see Plan B comment at top of file).
		peer = (c.get("peerIp") as string | undefined) ?? "0.0.0.0";
	}

	const rawProxies = process.env.AGENTPULSE_TRUSTED_PROXIES ?? "";
	const trustedCidrs = parseCidrList(rawProxies);

	if (trustedCidrs.length === 0) {
		warnOnceIfProxiesUnparseable(rawProxies);
		return peer;
	}

	const peerIsTrusted = isTrustedProxy(peer, trustedCidrs);
	const xff = peerIsTrusted ? c.req.header("X-Forwarded-For") : undefined;
	const leftmost = xff?.split(",")[0]?.trim();
	const forwarded = leftmost !== undefined && isValidIp(leftmost);
	checkTrustedProxySetup(peer, peerIsTrusted, forwarded);
	if (forwarded) return leftmost as string;
	// Malformed XFF from a trusted peer: fall back to peer + warn.
	if (xff) console.warn(JSON.stringify({ kind: "trusted_xff_malformed", peer, xff }));

	return peer;
}
