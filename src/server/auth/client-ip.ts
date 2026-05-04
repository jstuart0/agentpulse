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

/**
 * Returns true if `addr` is a syntactically valid IPv4 address.
 */
export function isValidIp(addr: string): boolean {
	// Only IPv4 is supported by the CIDR parser below; accept IPv6 as valid
	// passthrough (no XFF trust evaluation for IPv6 peers).
	if (addr.includes(":")) return true; // IPv6 — pass through
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
 * Returns true if `addr` (IPv4 dotted-decimal) falls within any of the
 * provided parsed CIDRs. IPv6 peers never match an IPv4 CIDR.
 */
export function isTrustedProxy(addr: string, cidrs: ParsedCidr[]): boolean {
	// IPv6 peers cannot match IPv4 CIDRs.
	if (addr.includes(":")) return false;
	const n = ipv4ToUint32(addr);
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
