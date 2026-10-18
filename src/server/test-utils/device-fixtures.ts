/**
 * Fixtures for tests that register phones: a real P-256 public key and a valid
 * registration body. Not a test file.
 */
import { app } from "../app.js";
import { bearerHeaders, cookieHeadersFor, jsonRequest } from "./team-fixtures.js";

/** A fresh uncompressed P-256 point, base64url, as a phone's secure enclave would hand over. */
export async function p256PublicKey(): Promise<string> {
	const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
		"deriveBits",
	]);
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	return Buffer.from(raw).toString("base64url");
}

let counter = 0;

/** A valid POST /devices body; override fields to break or vary it. */
export async function deviceBody(
	over: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	counter++;
	return {
		platform: "ios",
		environment: "sandbox",
		relayDeviceId: `relay-device-${crypto.randomUUID()}`,
		sendToken: `send-token-secret-${crypto.randomUUID()}`,
		kid: `kid-${counter}`,
		publicKey: await p256PublicKey(),
		clientServerRef: `server-ref-${counter}`,
		deviceName: "Test Phone",
		appVersion: "1.0.0",
		osVersion: "26.3",
		prefs: { showContent: true, quietHours: { enabled: false, start: "22:00", end: "07:00" } },
		...over,
	};
}

export function asKey(key: string): Headers {
	return bearerHeaders(key, { "Content-Type": "application/json" });
}

export async function registerWith(
	headers: Headers,
	over: Record<string, unknown> = {},
): Promise<Response> {
	return app.request("/api/v1/devices", jsonRequest("POST", await deviceBody(over), headers));
}

/** A key that came out of a pairing code, as the phone gets one: the minter's session mints, the phone redeems. */
export async function pairedKey(
	userId: string,
	access: "respond" | "full" = "respond",
): Promise<{ key: string; keyId: string }> {
	const headers = await cookieHeadersFor(userId);
	const minted = (await (
		await app.request("/api/v1/pairing-codes", jsonRequest("POST", { access }, headers))
	).json()) as { code: string };
	const res = await app.request(
		"/api/v1/pair",
		jsonRequest("POST", { code: minted.code, deviceName: "Paired Phone", platform: "ios" }),
	);
	if (res.status !== 201) throw new Error(`pairing failed: ${res.status}`);
	return (await res.json()) as { key: string; keyId: string };
}
