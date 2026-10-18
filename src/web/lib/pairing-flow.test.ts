import { describe, expect, test } from "bun:test";
import {
	type DeviceListEvent,
	type DeviceListState,
	PAIRING_ACCESS_OPTIONS,
	type RevokeEvent,
	type RevokeState,
	type TestPushEvent,
	type TestPushState,
	countdownText,
	deviceListReducer,
	deviceRevokeWarning,
	deviceTitle,
	heldCode,
	lastSeenText,
	pairingUri,
	pairingView,
	revokeReducer,
	revokeTarget,
	testPushMessage,
	testPushReducer,
} from "./pairing-flow.js";

describe("pairingUri", () => {
	test("carries the version, the origin and the code, escaped", () => {
		expect(pairingUri("https://agentpulse.example.com", "ABCDEFGH23JKMNPQRSTV")).toBe(
			"agentpulse://pair?v=1&u=https%3A%2F%2Fagentpulse.example.com&c=ABCDEFGH23JKMNPQRSTV",
		);
	});

	test("an origin with a port and a code with odd characters stay one query value each", () => {
		const uri = pairingUri("http://192.0.2.10:3000", "a&b=c");
		const params = new URL(uri).searchParams;
		expect(params.get("u")).toBe("http://192.0.2.10:3000");
		expect(params.get("c")).toBe("a&b=c");
	});
});

describe("countdownText", () => {
	const expires = "2026-10-01T12:05:00.000Z";
	const at = (s: number) => Date.parse("2026-10-01T12:00:00.000Z") + s * 1000;
	test("m:ss, rounding a partial second up so it never reads 0:00 early", () => {
		expect(countdownText(expires, at(0))).toBe("5:00");
		expect(countdownText(expires, at(0) + 400)).toBe("5:00");
		expect(countdownText(expires, at(61))).toBe("3:59");
		expect(countdownText(expires, at(299))).toBe("0:01");
	});
	test("never negative", () => {
		expect(countdownText(expires, at(300))).toBe("0:00");
		expect(countdownText(expires, at(9999))).toBe("0:00");
	});
});

describe("pairingView", () => {
	const made = { expiresAt: "2026-10-01T12:05:00.000Z" };
	const now = Date.parse("2026-10-01T12:01:00.000Z");
	const status = (state: "pending" | "redeemed" | "expired") => ({
		state,
		expiresAt: made.expiresAt,
		redeemedDeviceName: state === "redeemed" ? "Phone" : null,
		redeemedKeyId: state === "redeemed" ? "k1" : null,
	});

	test("no code made: idle", () => {
		expect(pairingView(null, null, now)).toBe("idle");
	});
	test("made and not yet answered: pending", () => {
		expect(pairingView(made, null, now)).toBe("pending");
		expect(pairingView(made, status("pending"), now)).toBe("pending");
	});
	test("the server's redeemed wins, even past the clock", () => {
		expect(pairingView(made, status("redeemed"), now)).toBe("redeemed");
		expect(pairingView(made, status("redeemed"), Date.parse("2026-10-01T13:00:00Z"))).toBe(
			"redeemed",
		);
	});
	test("expired by the server's word or by the clock", () => {
		expect(pairingView(made, status("expired"), now)).toBe("expired");
		expect(pairingView(made, status("pending"), Date.parse("2026-10-01T12:05:00Z"))).toBe(
			"expired",
		);
	});
});

describe("access options", () => {
	test("respond comes first and is the safe default; full says what it allows", () => {
		expect(PAIRING_ACCESS_OPTIONS[0]?.value).toBe("respond");
		expect(PAIRING_ACCESS_OPTIONS[1]?.hint.toLowerCase()).toContain("launch");
	});
});

describe("the code is dropped as soon as it stops being useful", () => {
	const made = { code: "ABCDEFGH23JKMNPQRSTV" };
	test("held while pending and the tab is visible", () => {
		expect(heldCode(made, "pending", false)).toBe(made.code);
	});
	test("dropped when redeemed, expired, idle, or the tab is hidden", () => {
		expect(heldCode(made, "redeemed", false)).toBeNull();
		expect(heldCode(made, "expired", false)).toBeNull();
		expect(heldCode(made, "idle", false)).toBeNull();
		expect(heldCode(made, "pending", true)).toBeNull();
	});
	test("nothing made, nothing held; a code already forgotten stays forgotten", () => {
		expect(heldCode(null, "pending", false)).toBeNull();
		expect(heldCode({ code: null }, "pending", false)).toBeNull();
	});
});

describe("revokeTarget", () => {
	const status = (over: Record<string, unknown>) => ({
		state: "redeemed" as const,
		expiresAt: "2026-10-01T12:05:00.000Z",
		redeemedDeviceName: "Phone",
		redeemedKeyId: "k1",
		...over,
	});
	test("the redeemed key, and nothing otherwise", () => {
		expect(revokeTarget(status({}))).toBe("k1");
		expect(revokeTarget(status({ redeemedKeyId: null }))).toBeNull();
		expect(revokeTarget(status({ state: "pending", redeemedKeyId: "k1" }))).toBeNull();
		expect(revokeTarget(null)).toBeNull();
	});
});

describe("revokeReducer", () => {
	const run = (events: RevokeEvent[], from: RevokeState = { step: "idle" }) =>
		events.reduce(revokeReducer, from);

	test("idle -> confirming -> revoking -> revoked", () => {
		expect(run([{ type: "ask" }])).toEqual({ step: "confirming" });
		expect(run([{ type: "ask" }, { type: "submit" }])).toEqual({ step: "revoking" });
		expect(run([{ type: "ask" }, { type: "submit" }, { type: "succeeded" }])).toEqual({
			step: "revoked",
		});
	});

	test("one click can't revoke: submit without asking first does nothing", () => {
		expect(run([{ type: "submit" }])).toEqual({ step: "idle" });
		expect(run([{ type: "succeeded" }])).toEqual({ step: "idle" });
	});

	test("cancelling goes back to idle, from confirming and from an error", () => {
		expect(run([{ type: "ask" }, { type: "cancel" }])).toEqual({ step: "idle" });
		expect(
			run([
				{ type: "ask" },
				{ type: "submit" },
				{ type: "failed", message: "x" },
				{ type: "cancel" },
			]),
		).toEqual({ step: "idle" });
	});

	test("a failure keeps its message and can be asked again", () => {
		const failed = run([{ type: "ask" }, { type: "submit" }, { type: "failed", message: "boom" }]);
		expect(failed).toEqual({ step: "error", message: "boom" });
		expect(run([{ type: "ask" }], failed)).toEqual({ step: "confirming" });
	});

	test("while a request is in flight, ask and cancel are ignored; a failure outside one is too", () => {
		const revoking: RevokeState = { step: "revoking" };
		expect(run([{ type: "ask" }, { type: "cancel" }], revoking)).toEqual(revoking);
		expect(run([{ type: "failed", message: "late" }])).toEqual({ step: "idle" });
	});

	test("revoked is final until reset", () => {
		const revoked: RevokeState = { step: "revoked" };
		expect(run([{ type: "ask" }, { type: "submit" }, { type: "cancel" }], revoked)).toEqual(
			revoked,
		);
		expect(run([{ type: "reset" }], revoked)).toEqual({ step: "idle" });
	});
});

describe("paired phones", () => {
	test("deviceTitle falls back to the platform", () => {
		expect(deviceTitle({ deviceName: "Kitchen iPhone", platform: "ios" })).toBe("Kitchen iPhone");
		expect(deviceTitle({ deviceName: "  ", platform: "ios" })).toBe("ios device");
		expect(deviceTitle({ deviceName: null, platform: "android" })).toBe("android device");
	});

	test("the remove warning says whether the phone's key goes with it", () => {
		const paired = deviceRevokeWarning({ paired: true, deviceName: "P", platform: "ios" });
		const pasted = deviceRevokeWarning({ paired: false, deviceName: "P", platform: "ios" });
		expect(paired).toContain("revoked");
		expect(pasted).toContain("stays valid");
		expect(pasted).not.toContain("is revoked");
	});

	test("lastSeenText", () => {
		const now = Date.parse("2026-10-01T12:00:00Z");
		const ago = (s: number) => new Date(now - s * 1000).toISOString();
		expect(lastSeenText(null, now)).toBe("never seen");
		expect(lastSeenText(ago(30), now)).toBe("just now");
		expect(lastSeenText(ago(600), now)).toBe("10 min ago");
		expect(lastSeenText(ago(7200), now)).toBe("2 h ago");
		expect(lastSeenText(ago(3 * 86_400), now)).toBe("3 d ago");
		expect(lastSeenText(ago(-50), now)).toBe("just now");
	});

	test("testPushMessage names what happened", () => {
		expect(testPushMessage("sent")).toContain("sent");
		expect(testPushMessage({ status: 503 })).toContain("can't send");
		expect(testPushMessage({ status: 429 })).toContain("limit");
		expect(testPushMessage({ status: 404 })).toContain("no longer");
		expect(testPushMessage({ status: 500 })).toContain("Couldn't");
	});
});

describe("deviceListReducer", () => {
	type D = { id: string; name: string };
	const a: D = { id: "a", name: "A" };
	const b: D = { id: "b", name: "B" };
	const step = (state: DeviceListState<D>, event: DeviceListEvent<D>) =>
		deviceListReducer(state, event);

	test("loading -> ready on a load, -> failed on a first failure, back to loading on retry", () => {
		const loading: DeviceListState<D> = { step: "loading" };
		expect(step(loading, { type: "loaded", devices: [a] })).toEqual({
			step: "ready",
			devices: [a],
		});
		const failed = step(loading, { type: "failed" });
		expect(failed).toEqual({ step: "failed" });
		expect(step(failed, { type: "retry" })).toEqual({ step: "loading" });
		expect(step(loading, { type: "retry" })).toEqual(loading);
	});

	test("a failed refresh keeps the list on screen instead of blanking it", () => {
		const ready: DeviceListState<D> = { step: "ready", devices: [a, b] };
		expect(step(ready, { type: "failed" })).toBe(ready);
	});

	test("a refresh replaces the list, including with an empty one", () => {
		const ready: DeviceListState<D> = { step: "ready", devices: [a, b] };
		expect(step(ready, { type: "loaded", devices: [b] })).toEqual({ step: "ready", devices: [b] });
		expect(step(ready, { type: "loaded", devices: [] })).toEqual({ step: "ready", devices: [] });
	});

	test("a removed phone leaves at once; removing one that isn't there changes nothing", () => {
		const ready: DeviceListState<D> = { step: "ready", devices: [a, b] };
		expect(step(ready, { type: "removed", id: "a" })).toEqual({ step: "ready", devices: [b] });
		expect(step(ready, { type: "removed", id: "zzz" })).toEqual(ready);
		expect(step({ step: "loading" }, { type: "removed", id: "a" })).toEqual({ step: "loading" });
		expect(step({ step: "failed" }, { type: "removed", id: "a" })).toEqual({ step: "failed" });
	});
});

describe("testPushReducer", () => {
	const run = (events: TestPushEvent[], from: TestPushState = { step: "idle" }) =>
		events.reduce(testPushReducer, from);

	test("idle -> sending -> done with the message; dismiss clears it", () => {
		expect(run([{ type: "start" }])).toEqual({ step: "sending" });
		expect(run([{ type: "start" }, { type: "finished", message: "sent" }])).toEqual({
			step: "done",
			message: "sent",
		});
		expect(
			run([{ type: "start" }, { type: "finished", message: "sent" }, { type: "dismiss" }]),
		).toEqual({ step: "idle" });
	});

	test("only one test at a time: a second start while sending changes nothing", () => {
		const sending: TestPushState = { step: "sending" };
		expect(run([{ type: "start" }], sending)).toBe(sending);
	});

	test("a finish nobody started, and a dismiss while sending, are ignored", () => {
		expect(run([{ type: "finished", message: "stray" }])).toEqual({ step: "idle" });
		expect(run([{ type: "dismiss" }], { step: "sending" })).toEqual({ step: "sending" });
	});

	test("a new test starts over a finished one", () => {
		expect(run([{ type: "start" }], { step: "done", message: "old" })).toEqual({ step: "sending" });
	});
});
