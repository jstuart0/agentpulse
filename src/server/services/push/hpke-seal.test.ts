import { describe, expect, test } from "bun:test";
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import vector from "./__fixtures__/p256-vector.json";
import {
	HPKE_INFO,
	MAX_PLAINTEXT_BYTES,
	type PushPayload,
	SealError,
	fitPayload,
	isValidDevicePublicKey,
	pushAad,
	sealBytes,
	sealPushPayload,
} from "./hpke-seal.js";

const suite = new CipherSuite({
	kem: new DhkemP256HkdfSha256(),
	kdf: new HkdfSha256(),
	aead: new Aes256Gcm(),
});
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const fromBytes = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** Opens like the phone would: HPKE base mode, the fixed info, the AAD from the row. */
async function open(
	row: { enc: string; ct: string; aad: string },
	privateKey: string,
): Promise<string> {
	const recipientKey = await suite.kem.deserializePrivateKey(b64(privateKey));
	const pt = await suite.open(
		{ recipientKey, enc: b64(row.enc), info: encoder.encode(HPKE_INFO) },
		b64(row.ct),
		encoder.encode(row.aad),
	);
	return decoder.decode(pt);
}

async function freshRecipient() {
	const pair = await suite.kem.generateKeyPair();
	return {
		pair,
		publicKey: fromBytes(new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey))),
	};
}

const payload = (over: Partial<PushPayload> = {}): PushPayload => ({
	v: 1,
	kid: "kid-1",
	pid: "push-1",
	ts: 1_760_000_000,
	ref: "srv-1",
	t: "permission_wait",
	cat: "NEEDS_YOU_PERMISSION",
	il: "time-sensitive",
	sid: "sess-1",
	...over,
});
const size = (p: PushPayload) => encoder.encode(JSON.stringify(p)).length;

describe("cross-implementation vector (p256-vector.json)", () => {
	const rows = vector.rows as {
		name: string;
		sealedBy: string;
		expect: string;
		deviceId: string;
		pushId: string;
		aad: string;
		plaintext: string;
		enc: string;
		ct: string;
		openWithTestOnlyPrivateKey?: string;
		reject?: string;
		registeredKid?: string;
		now?: number;
	}[];

	test("describes the suite iOS CryptoKit calls P256_SHA256_AES_GCM_256", () => {
		expect(vector.suite).toEqual({
			mode: "base",
			kem: "DHKEM(P-256, HKDF-SHA256)",
			kdf: "HKDF-SHA256",
			aead: "AES-256-GCM",
			info: HPKE_INFO,
		});
		expect(b64(vector.recipient.publicKey)).toHaveLength(65);
		expect(b64(vector.recipient.testOnlyPrivateKey)).toHaveLength(32);
	});

	test("the file has CryptoKit-sealed and server-sealed rows, and every kind of negative", () => {
		expect(rows.filter((r) => r.sealedBy === "cryptokit").length).toBeGreaterThanOrEqual(2);
		expect(rows.filter((r) => r.sealedBy === "server").length).toBeGreaterThanOrEqual(3);
		const names = rows.map((r) => r.name);
		for (const needed of [
			"negative-tampered-device-id",
			"negative-tampered-push-id",
			"negative-flipped-ciphertext-bit",
			"negative-short-ciphertext",
			"negative-wrong-recipient-key",
			"negative-tampered-enc",
			"receiver-wrong-kid",
			"receiver-inner-pid-differs-from-outer",
			"receiver-stale-ts",
			"receiver-future-ts",
		]) {
			expect(names).toContain(needed);
		}
	});

	test("the AAD in every row is exactly agentpulse-push-v1|<deviceId>|<pushId>", () => {
		for (const row of rows) {
			if (row.expect === "opens" || row.expect === "opens_then_reject") {
				expect(row.aad).toBe(pushAad(row.deviceId, row.pushId));
				expect(row.aad).toBe(`agentpulse-push-v1|${row.deviceId}|${row.pushId}`);
			}
		}
	});

	for (const sealedBy of ["cryptokit", "server"] as const) {
		test(`opens every row ${sealedBy === "cryptokit" ? "CryptoKit sealed (the phone's side)" : "the server sealed (and CryptoKit opened)"}`, async () => {
			const group = rows.filter((r) => r.sealedBy === sealedBy && r.expect === "opens");
			expect(group.length).toBeGreaterThan(0);
			for (const row of group) {
				expect(await open(row, vector.recipient.testOnlyPrivateKey)).toBe(row.plaintext);
			}
		});
	}

	test("refuses every negative row", async () => {
		const negatives = rows.filter((r) => r.expect === "open_fails");
		expect(negatives.length).toBeGreaterThanOrEqual(5);
		for (const row of negatives) {
			await expect(
				open(row, row.openWithTestOnlyPrivateKey ?? vector.recipient.testOnlyPrivateKey),
			).rejects.toThrow();
		}
	});

	test("a ciphertext shorter than its tag is refused before opening", () => {
		const row = rows.find((r) => r.name === "negative-short-ciphertext");
		expect(row?.expect).toBe("reject_before_open");
		expect(b64(row?.ct ?? "").length).toBeLessThan(vector.receiverRules.minCiphertextBytes);
	});

	test("the receiver rules the phone applies are expressible on the payload (kid, pid, ts window)", async () => {
		const rules = vector.receiverRules;
		for (const row of rows.filter((r) => r.expect === "opens_then_reject")) {
			const body = JSON.parse(await open(row, vector.recipient.testOnlyPrivateKey)) as PushPayload;
			const now = row.now ?? 0;
			const verdict =
				body.kid !== row.registeredKid && row.reject === "kid_mismatch"
					? "kid_mismatch"
					: body.pid !== row.pushId
						? "pid_mismatch"
						: body.ts < now - rules.tsWindowSeconds.before ||
								body.ts > now + rules.tsWindowSeconds.after
							? "ts_out_of_window"
							: "accept";
			expect(verdict).toBe(row.reject ?? "accept");
		}
		// Rows that are good must pass the same rules.
		const good = rows.find((r) => r.name === "server-seals-permission-wait");
		if (!good) throw new Error("fixture row missing");
		const body = JSON.parse(await open(good, vector.recipient.testOnlyPrivateKey)) as PushPayload;
		expect(body.pid).toBe(good.pushId);
		expect(Math.abs(body.ts - 1_760_000_000)).toBeLessThanOrEqual(rules.tsWindowSeconds.after);
	});
});

describe("sealBytes and sealPushPayload", () => {
	test("round-trips with an independent receiver, and returns {enc, ct} as unpadded base64url", async () => {
		const { pair, publicKey } = await freshRecipient();
		const plaintext = encoder.encode(JSON.stringify(payload({ sname: "naive café 日本語 🚀" })));
		const sealed = await sealBytes(plaintext, {
			publicKey,
			relayDeviceId: "dev-aaaaaaaaaaaaaaaa",
			pushId: "p1",
		});
		expect(sealed.enc).toMatch(/^[A-Za-z0-9_-]{87}$/); // 65 bytes
		expect(b64(sealed.ct).length).toBe(plaintext.length + 16); // plus the GCM tag
		expect(sealed.ct).not.toContain("=");
		const out = await suite.open(
			{ recipientKey: pair.privateKey, enc: b64(sealed.enc), info: encoder.encode(HPKE_INFO) },
			b64(sealed.ct),
			encoder.encode(pushAad("dev-aaaaaaaaaaaaaaaa", "p1")),
		);
		expect(new Uint8Array(out)).toEqual(plaintext);
	});

	test("binds the device id and push id: another AAD does not open it", async () => {
		const { pair, publicKey } = await freshRecipient();
		const sealed = await sealBytes(encoder.encode("{}"), {
			publicKey,
			relayDeviceId: "dev-aaaaaaaaaaaaaaaa",
			pushId: "p1",
		});
		const attempt = (d: string, p: string) =>
			suite.open(
				{ recipientKey: pair.privateKey, enc: b64(sealed.enc), info: encoder.encode(HPKE_INFO) },
				b64(sealed.ct),
				encoder.encode(pushAad(d, p)),
			);
		await expect(attempt("dev-aaaaaaaaaaaaaaaa", "p1")).resolves.toBeDefined();
		await expect(attempt("dev-bbbbbbbbbbbbbbbb", "p1")).rejects.toThrow();
		await expect(attempt("dev-aaaaaaaaaaaaaaaa", "p2")).rejects.toThrow();
	});

	test("uses a fresh ephemeral key every time", async () => {
		const { publicKey } = await freshRecipient();
		const a = await sealBytes(encoder.encode("x"), { publicKey, relayDeviceId: "d", pushId: "p" });
		const b = await sealBytes(encoder.encode("x"), { publicKey, relayDeviceId: "d", pushId: "p" });
		expect(a.enc).not.toBe(b.enc);
		expect(a.ct).not.toBe(b.ct);
	});

	test("sealPushPayload returns exactly the relay's five envelope members, bound to the payload's push id", async () => {
		const { pair, publicKey } = await freshRecipient();
		const sealed = await sealPushPayload(payload({ pid: "push-xyz" }), {
			publicKey,
			relayDeviceId: "relayDevice0123456789",
		});
		expect(Object.keys(sealed.envelope).sort()).toEqual(["c", "d", "e", "p", "v"]);
		expect(sealed.envelope).toMatchObject({ v: 1, d: "relayDevice0123456789", p: "push-xyz" });
		expect(sealed.envelope.e).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
		expect(sealed.envelope.c).toMatch(/^[A-Za-z0-9_-]{22,3900}$/);
		const out = await suite.open(
			{
				recipientKey: pair.privateKey,
				enc: b64(sealed.envelope.e),
				info: encoder.encode(HPKE_INFO),
			},
			b64(sealed.envelope.c),
			encoder.encode(pushAad("relayDevice0123456789", "push-xyz")),
		);
		expect(JSON.parse(decoder.decode(out))).toEqual(payload({ pid: "push-xyz" }));
		expect(sealed.plaintextBytes).toBe(size(payload({ pid: "push-xyz" })));
		expect(sealed.trimmed).toEqual([]);
	});

	test("the plaintext never appears in the envelope", async () => {
		const { publicKey } = await freshRecipient();
		const sealed = await sealPushPayload(
			payload({ sname: "SECRET-SESSION-NAME", text: "SECRET-AGENT-TEXT" }),
			{
				publicKey,
				relayDeviceId: "relayDevice0123456789",
			},
		);
		const wire = JSON.stringify(sealed.envelope);
		expect(wire).not.toContain("SECRET");
		expect(Buffer.from(sealed.envelope.c, "base64url").toString("latin1")).not.toContain("SECRET");
	});
});

describe("plaintext limit (2,400 bytes)", () => {
	test("is 2,400", () => {
		expect(MAX_PLAINTEXT_BYTES).toBe(2400);
	});

	test("sealBytes accepts exactly 2,400 bytes and refuses 2,401", async () => {
		const { publicKey } = await freshRecipient();
		const target = { publicKey, relayDeviceId: "d", pushId: "p" };
		await expect(sealBytes(new Uint8Array(2400), target)).resolves.toBeDefined();
		const err = await sealBytes(new Uint8Array(2401), target).catch((e) => e);
		expect(err).toBeInstanceOf(SealError);
		expect(err.code).toBe("payload_too_large");
	});

	test("a payload that already fits is left alone", () => {
		const p = payload({ sname: "short", text: "short" });
		const out = fitPayload(p);
		expect(out.payload).toEqual(p);
		expect(out.trimmed).toEqual([]);
	});

	test("trims text first, as little as possible, and leaves sname alone", () => {
		const p = payload({ sname: "keep me", text: "t".repeat(3000) });
		const out = fitPayload(p);
		expect(out.trimmed).toEqual(["text"]);
		expect(out.payload.sname).toBe("keep me");
		expect(size(out.payload)).toBeLessThanOrEqual(2400);
		// As little as possible: one more character would not fit.
		expect(size({ ...out.payload, text: `${out.payload.text}t` })).toBeGreaterThan(2400);
	});

	test("trims sname only when text is gone and it is still too big", () => {
		const p = payload({ sname: "n".repeat(3000), text: "short text" });
		const out = fitPayload(p);
		expect(out.trimmed).toEqual(["text", "sname"]);
		expect(out.payload.text).toBeUndefined(); // cut whole, since it was the first thing to go
		expect(size(out.payload)).toBeLessThanOrEqual(2400);
		expect(out.payload.sname?.length).toBeGreaterThan(1000);
	});

	test("cuts on whole characters, never through a surrogate pair or a multibyte sequence", () => {
		const out = fitPayload(payload({ text: "🚀".repeat(2000) }));
		const text = out.payload.text ?? "";
		expect(text.length).toBeGreaterThan(0);
		expect(Array.from(text).every((c) => c === "🚀")).toBe(true);
		expect(JSON.parse(JSON.stringify(out.payload)).text).toBe(text);
		expect(size(out.payload)).toBeLessThanOrEqual(2400);
	});

	test("never cuts anything but text and sname: if they are not enough it refuses", () => {
		const err = (() => {
			try {
				fitPayload(payload({ sid: "s".repeat(2500) }));
			} catch (e) {
				return e as SealError;
			}
			return undefined;
		})();
		expect(err).toBeInstanceOf(SealError);
		expect(err?.code).toBe("payload_too_large");
	});

	test("sealPushPayload reports what it trimmed, and the sealed plaintext fits", async () => {
		const { pair, publicKey } = await freshRecipient();
		const sealed = await sealPushPayload(payload({ text: "x".repeat(4000) }), {
			publicKey,
			relayDeviceId: "relayDevice0123456789",
		});
		expect(sealed.trimmed).toEqual(["text"]);
		expect(sealed.plaintextBytes).toBeLessThanOrEqual(2400);
		const out = await suite.open(
			{
				recipientKey: pair.privateKey,
				enc: b64(sealed.envelope.e),
				info: encoder.encode(HPKE_INFO),
			},
			b64(sealed.envelope.c),
			encoder.encode(pushAad("relayDevice0123456789", "push-1")),
		);
		expect(out.byteLength).toBe(sealed.plaintextBytes);
		// The relay's envelope limit: 2,400 B of plaintext seals to well under the 3,900-character c.
		expect(sealed.envelope.c.length).toBeLessThan(3900);
	});
});

describe("what goes into the associated data", () => {
	const target = (over: Partial<{ relayDeviceId: string; pushId: string }> = {}) => ({
		publicKey: vector.recipient.publicKey,
		relayDeviceId: "relayDevice0001",
		pushId: "push-1",
		...over,
	});

	test("an id with the separator or any other stray character is refused before sealing", async () => {
		for (const bad of ["a|b", "has space", "new\nline", "ü", "", "x".repeat(65), "a/b"]) {
			await expect(
				sealBytes(new Uint8Array([1]), target({ relayDeviceId: bad })),
				`device ${JSON.stringify(bad)}`,
			).rejects.toMatchObject({ code: "invalid_input" });
			await expect(
				sealBytes(new Uint8Array([1]), target({ pushId: bad })),
				`push ${JSON.stringify(bad)}`,
			).rejects.toMatchObject({ code: "invalid_input" });
		}
	});

	test("the relay's id forms (base64url, hex, dotted) are accepted", async () => {
		for (const id of ["AbC_-123", "0123456789abcdef", "a.b:c-d_e", "x".repeat(64)]) {
			await expect(
				sealBytes(new Uint8Array([1]), target({ relayDeviceId: id })),
			).resolves.toBeDefined();
		}
	});

	test("two seals of identical input differ: every seal uses a fresh ephemeral key", async () => {
		const plaintext = new TextEncoder().encode("same plaintext");
		const a = await sealBytes(plaintext, target());
		const b = await sealBytes(plaintext, target());
		expect(a.enc).not.toBe(b.enc);
		expect(a.ct).not.toBe(b.ct);
	});

	test("the fixture is marked test-only and carries no key under a plain 'privateKey' name", () => {
		expect((vector as { testOnly?: boolean }).testOnly).toBe(true);
		expect(JSON.stringify(vector)).not.toMatch(/"privateKey"/);
	});
});

describe("device public key validation", () => {
	const GOOD = vector.recipient.publicKey;

	test("accepts a real uncompressed P-256 point", async () => {
		expect(await isValidDevicePublicKey(GOOD)).toBe(true);
	});

	test("refuses everything that is not one", async () => {
		const point = b64(GOOD);
		const offCurve = new Uint8Array(point);
		offCurve[64] ^= 0x01;
		const compressed = new Uint8Array(33);
		compressed[0] = 0x02;
		const rawNoPrefix = point.slice(1);
		const cases: [string, string][] = [
			["empty", ""],
			["not base64url", "not base64!"],
			["padded", `${GOOD}=`],
			["standard alphabet", `${GOOD.replace(/-/g, "+").replace(/_/g, "/")}=`],
			["a point not on the curve", fromBytes(offCurve)],
			["a compressed point", fromBytes(compressed)],
			["64 bytes without the 0x04 prefix", fromBytes(rawNoPrefix)],
			["too long", fromBytes(new Uint8Array(66))],
			["a 65-byte string that is not a point", fromBytes(new Uint8Array(65).fill(4))],
		];
		for (const [label, key] of cases) {
			expect(await isValidDevicePublicKey(key), label).toBe(false);
		}
	});

	test("sealing to a bad key throws invalid_public_key and seals nothing", async () => {
		const err = await sealBytes(encoder.encode("{}"), {
			publicKey: "AAAA",
			relayDeviceId: "d",
			pushId: "p",
		}).catch((e) => e);
		expect(err).toBeInstanceOf(SealError);
		expect(err.code).toBe("invalid_public_key");
		// The message names the problem, never the key.
		expect(String(err.message)).not.toContain("AAAA");
	});

	test("an empty device id or push id is refused", async () => {
		const bad = await sealBytes(encoder.encode("{}"), {
			publicKey: GOOD,
			relayDeviceId: "",
			pushId: "p",
		}).catch((e) => e);
		expect(bad.code).toBe("invalid_input");
	});
});
