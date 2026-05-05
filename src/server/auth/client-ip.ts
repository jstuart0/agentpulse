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

	const trustedCidrs = parseCidrList(process.env.AGENTPULSE_TRUSTED_PROXIES ?? "");

	if (trustedCidrs.length > 0 && isTrustedProxy(peer, trustedCidrs)) {
		const xff = c.req.header("X-Forwarded-For");
		if (xff) {
			const leftmost = xff.split(",")[0]?.trim();
			if (leftmost && isValidIp(leftmost)) return leftmost;
			// Malformed XFF from a trusted peer: fall back to peer + warn.
			console.warn(JSON.stringify({ kind: "trusted_xff_malformed", peer, xff }));
		}
	}

	return peer;
}
