import { describe, expect, test } from "bun:test";
import {
	NOW,
	TEST_KEYS,
	TEST_KEY_LIST,
	envelopeFor,
	testPayload,
	testRelease,
} from "./__fixtures__/release-test-signer.js";
import {
	type LastSeen,
	MAX_ENVELOPE_BYTES,
	type Manifest,
	type VerifyContext,
	type VerifyFailureCode,
	releaseFor,
	updateState,
	verifyManifest,
} from "./release-manifest.js";

const ctx = (over: Partial<VerifyContext> = {}): VerifyContext => ({
	keys: TEST_KEY_LIST,
	revoked: new Set(),
	now: NOW,
	last: null,
	...over,
});

async function code(text: string, c: VerifyContext = ctx()): Promise<VerifyFailureCode | "ok"> {
	const r = await verifyManifest(text, c);
	return r.ok ? "ok" : r.code;
}

const b64u = (s: string) => Buffer.from(s).toString("base64url");

describe("verifyManifest: the accepted path", () => {
	test("a payload signed by the active key verifies and comes back cleaned", async () => {
		const r = await verifyManifest(envelopeFor(testPayload()), ctx());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.manifest.latest).toBe("0.12.0");
		expect(r.manifest.releases).toHaveLength(2);
		expect(r.fingerprint).toMatch(/^[0-9a-f]{64}$/);
		expect(r.stale).toBe(false);
		expect(r.next).toEqual({
			seq: 100,
			issuedAt: "2026-11-19T11:00:00.000Z",
			fingerprint: r.fingerprint,
		});
		expect(r.revoked).toEqual([]);
	});

	test("unknown payload keys are ignored and not carried into the manifest", async () => {
		const payload = { ...testPayload(), command: "rm -rf /", url: "https://evil.example" };
		(payload.releases[0] as unknown as Record<string, unknown>).note = "free text";
		const r = await verifyManifest(envelopeFor(payload), ctx());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(JSON.stringify(r.manifest)).not.toContain("rm -rf");
		expect(JSON.stringify(r.manifest)).not.toContain("free text");
	});
});

describe("verifyManifest: the envelope", () => {
	test("an envelope over 32 KiB is too_large", async () => {
		expect(await code("x".repeat(MAX_ENVELOPE_BYTES + 1))).toBe("too_large");
	});

	const bad = (over: Record<string, unknown>) => {
		const env = JSON.parse(envelopeFor(testPayload()));
		return JSON.stringify({ ...env, ...over });
	};
	const cases: [string, () => string][] = [
		["not JSON", () => "nope"],
		["a JSON array", () => "[]"],
		["v: 2", () => bad({ v: 2 })],
		["no keyId", () => bad({ keyId: undefined })],
		["keyId with a slash", () => bad({ keyId: "k/../x" })],
		["padded payload (non-canonical base64url)", () => bad({ payload: `${b64u("{}")}==` })],
		["payload with a +", () => bad({ payload: "ab+c" })],
		["signature of the wrong length", () => bad({ sig: Buffer.alloc(63).toString("base64url") })],
		[
			"signature with stray trailing bits",
			() => {
				const env = JSON.parse(envelopeFor(testPayload()));
				const sig: string = env.sig;
				// 64 bytes encode to 86 chars whose last char carries 4 unused bits: flip one of them.
				const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(
					sig.at(-1) as string,
				);
				const flipped = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[
					last ^ 1
				];
				return JSON.stringify({ ...env, sig: sig.slice(0, -1) + flipped });
			},
		],
	];
	for (const [name, make] of cases) {
		test(`bad_envelope: ${name}`, async () => {
			expect(await code(make())).toBe("bad_envelope");
		});
	}
});

describe("verifyManifest: keys and signatures", () => {
	test("a key the client doesn't hold is unknown_key", async () => {
		expect(await code(envelopeFor(testPayload(), "unknown"))).toBe("unknown_key");
	});

	test("__proto__ and constructor as keyId are unknown_key, not a prototype hit", async () => {
		for (const keyId of ["__proto__", "constructor", "toString"]) {
			expect(await code(envelopeFor(testPayload(), "active", { keyId })), keyId).toBe(
				"unknown_key",
			);
		}
	});

	test("a key in the client's revoked set is revoked_key", async () => {
		const revoked = new Set([TEST_KEYS.active.keyId]);
		expect(await code(envelopeFor(testPayload()), ctx({ revoked }))).toBe("revoked_key");
	});

	test("a changed payload byte is bad_signature", async () => {
		const env = JSON.parse(envelopeFor(testPayload()));
		const payload = Buffer.from(env.payload, "base64url").toString();
		env.payload = b64u(payload.replace('"seq":100', '"seq":101'));
		expect(await code(JSON.stringify(env))).toBe("bad_signature");
	});

	test("a signature by another key under the active keyId is bad_signature", async () => {
		const env = JSON.parse(envelopeFor(testPayload(), "unknown"));
		env.keyId = TEST_KEYS.active.keyId;
		expect(await code(JSON.stringify(env))).toBe("bad_signature");
	});

	test("an empty key list refuses everything, and that reads as unverified", async () => {
		const r = await verifyManifest(envelopeFor(testPayload()), ctx({ keys: [] }));
		expect(r).toEqual({ ok: false, code: "unknown_key" });
		expect(updateState("0.11.0", null, { now: NOW }).state).toBe("unverified");
	});
});

describe("verifyManifest: freshness and replay", () => {
	const last = (over: Partial<LastSeen> = {}): LastSeen => ({
		seq: 100,
		issuedAt: "2026-11-19T11:00:00.000Z",
		fingerprint: "f".repeat(64),
		...over,
	});

	test("seq one lower than last.seq is replayed (named member)", async () => {
		expect(await code(envelopeFor(testPayload({ seq: 99 })), ctx({ last: last() }))).toBe(
			"replayed",
		);
	});

	test("a higher seq is accepted", async () => {
		expect(await code(envelopeFor(testPayload({ seq: 101 })), ctx({ last: last() }))).toBe("ok");
	});

	test("equal seq and issuedAt: identical bytes accepted, different bytes refused", async () => {
		const first = await verifyManifest(envelopeFor(testPayload()), ctx());
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const same = ctx({ last: first.next });
		expect(await code(envelopeFor(testPayload()), same)).toBe("ok");
		const different = testPayload({ minSupported: "0.10.0" });
		expect(await code(envelopeFor(different), same)).toBe("replayed");
	});

	test("equal seq with an earlier issuedAt is older: a valid envelope that is a no-op, not unverified", async () => {
		const earlier = testPayload({
			issuedAt: "2026-11-19T10:00:00.000Z",
			expiresAt: "2026-11-29T10:00:00.000Z",
		});
		expect(await code(envelopeFor(earlier), ctx({ last: last() }))).toBe("older");
	});

	test("equal seq with a later issuedAt (a cron re-sign of the same commit) is accepted", async () => {
		const later = testPayload({
			issuedAt: "2026-11-19T11:30:00.000Z",
			expiresAt: "2026-11-29T11:30:00.000Z",
		});
		expect(await code(envelopeFor(later), ctx({ last: last() }))).toBe("ok");
	});

	test("issuedAt at now+24h is accepted and one second more is future", async () => {
		const at = (ms: number) => {
			const issued = new Date(ms).toISOString();
			return testPayload({
				issuedAt: issued,
				expiresAt: new Date(ms + 10 * 86_400_000).toISOString(),
			});
		};
		expect(await code(envelopeFor(at(NOW + 24 * 3_600_000)))).toBe("ok");
		expect(await code(envelopeFor(at(NOW + 24 * 3_600_000 + 1000)))).toBe("future");
	});

	test("the stored issuedAt is never ratcheted past now", async () => {
		const ahead = new Date(NOW + 3_600_000);
		const r = await verifyManifest(
			envelopeFor(
				testPayload({
					issuedAt: ahead.toISOString(),
					expiresAt: new Date(ahead.getTime() + 10 * 86_400_000).toISOString(),
				}),
			),
			ctx(),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.next.issuedAt).toBe(new Date(NOW).toISOString());
	});

	test("an expired manifest still verifies, flagged stale", async () => {
		const r = await verifyManifest(
			envelopeFor(testPayload()),
			ctx({ now: Date.parse("2026-12-30T00:00:00.000Z") }),
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.stale).toBe(true);
	});
});

describe("verifyManifest: the payload schema", () => {
	const many = (n: number) => Array.from({ length: n }, (_, i) => testRelease(`0.${100 - i}.0`));
	const cases: [string, Partial<Manifest> | ((p: Manifest) => unknown)][] = [
		["schema 2", { schema: 2 as never }],
		["seq 0", { seq: 0 }],
		["seq 1.5", { seq: 1.5 }],
		["seq as a string", { seq: "100" as never }],
		["sourceCommit not hex", { sourceCommit: "z".repeat(40) }],
		["sourceCommit 39 chars", { sourceCommit: "a".repeat(39) }],
		["issuedAt not ISO", { issuedAt: "yesterday" }],
		["expiresAt before issuedAt", { expiresAt: "2026-11-19T10:00:00.000Z" }],
		["latest absent from releases", { latest: "0.13.0" }],
		["latest not a version", { latest: "latest" }],
		["duplicate versions", { releases: [testRelease("0.12.0"), testRelease("0.12.0")] }],
		["31 releases", { releases: many(31), latest: "0.100.0", minSupported: "0.70.0" }],
		["no releases", { releases: [] }],
		[
			"commit not hex",
			{ releases: [testRelease("0.12.0", { commit: "g".repeat(40) }), testRelease("0.11.0")] },
		],
		["minSupported above latest", { minSupported: "0.13.0" }],
		[
			"digest of 63 chars",
			{
				releases: [
					testRelease("0.12.0", {
						clients: {
							relay: "1".repeat(63),
							statusline: "2".repeat(64),
							excludeCheck: "3".repeat(64),
						},
					}),
					testRelease("0.11.0"),
				],
			},
		],
		[
			"severity other than the two",
			{ releases: [testRelease("0.12.0", { severity: "urgent" as never }), testRelease("0.11.0")] },
		],
		[
			"pulledReason with free text",
			{
				releases: [
					testRelease("0.12.0", { pulled: true, pulledReason: "it was bad, sorry" }),
					testRelease("0.11.0"),
				],
			},
		],
		[
			"a pulled latest",
			{
				releases: [
					testRelease("0.12.0", { pulled: true, pulledReason: "bad_build" }),
					testRelease("0.11.0"),
				],
			},
		],
		[
			"a pre-release latest",
			{
				latest: "0.13.0-rc.1",
				releases: [testRelease("0.13.0-rc.1"), testRelease("0.12.0")],
			},
		],
		[
			"validity of 11 days and one second",
			{ issuedAt: "2026-11-19T11:00:00.000Z", expiresAt: "2026-11-30T11:00:01.000Z" },
		],
		["revokedKeyIds not an array", { revokedKeyIds: "k-x" as never }],
		["a revokedKeyId that is not a key id", { revokedKeyIds: ["../x"] }],
		["releases that is not an array", { releases: "no" as never }],
	];
	for (const [name, over] of cases) {
		test(`bad_payload: ${name}`, async () => {
			const payload = typeof over === "function" ? over(testPayload()) : testPayload(over);
			expect(await code(envelopeFor(payload))).toBe("bad_payload");
		});
	}

	test("a payload that is not an object is bad_payload", async () => {
		expect(await code(envelopeFor("[1,2,3]"))).toBe("bad_payload");
		expect(await code(envelopeFor("not json"))).toBe("bad_payload");
	});
});

describe("verifyManifest: revocation is a standby key's power only (xander R4)", () => {
	test("a standby-signed envelope revokes the active key, and the next active-signed one is revoked_key", async () => {
		const revoking = testPayload({ revokedKeyIds: [TEST_KEYS.active.keyId] });
		const r = await verifyManifest(envelopeFor(revoking, "standby"), ctx());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.revoked).toEqual([TEST_KEYS.active.keyId]);
		const afterwards = ctx({ revoked: new Set(r.revoked) });
		expect(await code(envelopeFor(testPayload({ seq: 101 }), "active"), afterwards)).toBe(
			"revoked_key",
		);
	});

	test("an active-signed envelope's revokedKeyIds is ignored: the standby key stays usable (named member)", async () => {
		const hostile = testPayload({ revokedKeyIds: [TEST_KEYS.standby.keyId] });
		const r = await verifyManifest(envelopeFor(hostile, "active"), ctx());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.revoked).toEqual([]);
		expect(
			await code(
				envelopeFor(testPayload({ seq: 101 }), "standby"),
				ctx({ revoked: new Set(r.revoked) }),
			),
		).toBe("ok");
	});

	test("an envelope revoking its own signer is bad_payload", async () => {
		const suicidal = testPayload({ revokedKeyIds: [TEST_KEYS.standby.keyId] });
		expect(await code(envelopeFor(suicidal, "standby"))).toBe("bad_payload");
	});

	test("a revoked set is carried forward as a union", async () => {
		const prior = new Set(["k-aaaaaaaaaaaa"]);
		const r = await verifyManifest(
			envelopeFor(testPayload({ revokedKeyIds: [TEST_KEYS.active.keyId] }), "standby"),
			ctx({ revoked: prior }),
		);
		expect(r.ok).toBe(true);
		if (r.ok)
			expect([...r.revoked].sort()).toEqual(["k-aaaaaaaaaaaa", TEST_KEYS.active.keyId].sort());
	});
});

describe("releaseFor", () => {
	test("finds a version and returns null for an absent or malformed one", () => {
		const m = testPayload();
		expect(releaseFor(m, "0.11.0")?.version).toBe("0.11.0");
		expect(releaseFor(m, "0.9.0")).toBeNull();
		expect(releaseFor(m, "__proto__")).toBeNull();
	});
});

describe("updateState precedence", () => {
	const manifest = (over: Partial<Manifest> = {}): Manifest => testPayload(over);
	const state = (current: string, m: Manifest | null, disabled = false) =>
		updateState(current, m, { now: NOW, disabled }).state;

	test("disabled beats everything, even a missing manifest", () => {
		expect(state("0.11.0", null, true)).toBe("disabled");
		expect(state("0.11.0", manifest(), true)).toBe("disabled");
	});

	test("no manifest is unverified", () => {
		expect(state("0.11.0", null)).toBe("unverified");
	});

	test("a pulled current version beats below_minimum, security and available", () => {
		const m = manifest({
			minSupported: "0.12.0",
			releases: [
				testRelease("0.12.0", { severity: "security" }),
				testRelease("0.11.0", { pulled: true, pulledReason: "data_loss" }),
			],
		});
		expect(state("0.11.0", m)).toBe("current_pulled");
	});

	test("below minSupported beats security and available", () => {
		const m = manifest({
			minSupported: "0.12.0",
			releases: [testRelease("0.12.0", { severity: "security" }), testRelease("0.10.0")],
		});
		expect(state("0.10.0", m)).toBe("below_minimum");
	});

	test("an intermediate security release under a normal latest is still security", () => {
		const m = manifest({
			latest: "0.13.0",
			minSupported: "0.10.0",
			releases: [
				testRelease("0.13.0"),
				testRelease("0.12.0", { severity: "security" }),
				testRelease("0.11.0"),
			],
		});
		expect(state("0.11.0", m)).toBe("security");
	});

	test("a pulled security release is not a reason to say security", () => {
		const m = manifest({
			latest: "0.13.0",
			minSupported: "0.10.0",
			releases: [
				testRelease("0.13.0"),
				testRelease("0.12.0", { severity: "security", pulled: true, pulledReason: "bad_build" }),
				testRelease("0.11.0"),
			],
		});
		expect(state("0.11.0", m)).toBe("available");
	});

	test("a newer latest is available; the same is current; ahead of latest is current", () => {
		const m = manifest({ minSupported: "0.10.0" });
		expect(state("0.11.0", m)).toBe("available");
		expect(state("0.12.0", m)).toBe("current");
		expect(state("0.12.1", m)).toBe("current");
	});

	test("a pre-release current compares by precedence", () => {
		const m = manifest({ minSupported: "0.10.0" });
		expect(state("0.12.0-rc.1", m)).toBe("available");
		expect(state("0.13.0-rc.1", m)).toBe("current");
	});

	test("a current version absent from releases is compared by version only", () => {
		const m = manifest({ minSupported: "0.10.0" });
		expect(state("0.11.5", m)).toBe("available");
		expect(state("0.9.0", m)).toBe("below_minimum");
	});

	test("a current that isn't a release version is unverified, never interpolated", () => {
		expect(state("not-a-version", manifest())).toBe("unverified");
	});

	test("stale rides alongside the state", () => {
		const late = updateState("0.11.0", manifest(), { now: Date.parse("2026-12-30T00:00:00.000Z") });
		expect(late).toMatchObject({ state: "available", stale: true, latest: "0.12.0" });
		expect(updateState("0.11.0", manifest(), { now: NOW }).stale).toBe(false);
	});
});

describe("verifyManifest: validity bound and hostile payload keys", () => {
	test("a validity of exactly 11 days is accepted", async () => {
		const p = testPayload({
			issuedAt: "2026-11-19T11:00:00.000Z",
			expiresAt: "2026-11-30T11:00:00.000Z",
		});
		expect(await code(envelopeFor(p))).toBe("ok");
	});

	test("a __proto__ key in the payload is ignored, never merged", async () => {
		const raw = JSON.stringify(testPayload()).replace(
			'{"schema":1,',
			'{"__proto__":{"polluted":true},"constructor":{"x":1},"schema":1,',
		);
		expect(raw).toContain('"__proto__"');
		const r = await verifyManifest(envelopeFor(raw), ctx());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(Object.keys(r.manifest)).not.toContain("__proto__");
		expect(Object.getPrototypeOf(r.manifest)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect((r.manifest as unknown as Record<string, unknown>).polluted).toBeUndefined();
	});
});
