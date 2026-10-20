import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type PushRuntime,
	_resetDispatchForTest,
	configurePushRuntime,
	dispatchEvent,
	getPushRuntime,
} from "../push/dispatch.js";
import { InMemoryDeviceSource, PolicyPushTargets } from "../push/push-targets.js";
import type { PushDevice, PushEvent, PushLogger } from "../push/types.js";

const event: PushEvent = { type: "permission_wait", sessionId: "sess-1" };

function device(id: string): PushDevice {
	return {
		id,
		userId: "user-1",
		platform: "ios",
		relayDeviceId: `relayDevice${id}`,
		ownerlessKeyId: null,
		sendTokenCiphertext: "stored-token",
		kid: `kid-${id}`,
		publicKey: "AAAA",
		clientServerRef: "ref",
		prefs: {},
	};
}

function recorder() {
	const order: string[] = [];
	const warnings: { message: string; fields?: Record<string, unknown> }[] = [];
	const logger: PushLogger = {
		info: () => undefined,
		warn: (message, fields) => void warnings.push({ message, fields }),
	};
	return { order, warnings, logger };
}

beforeEach(() => _resetDispatchForTest());
afterEach(() => configurePushRuntime(null));

describe("dispatchEvent", () => {
	test("with no runtime it returns at once and touches nothing", async () => {
		expect(getPushRuntime()).toBeNull();
		await expect(dispatchEvent(event)).resolves.toBe("settled");
	});

	test("resolves targets for the event and hands them to the service with the event", async () => {
		const { logger } = recorder();
		const sent: { devices: PushDevice[]; event: PushEvent }[] = [];
		const seenEvents: PushEvent[] = [];
		configurePushRuntime({
			logger,
			targets: {
				resolve: async (e) => {
					seenEvents.push(e);
					return [device("a"), device("b")];
				},
			},
			service: {
				sendToDevices: async (devices, e) => {
					sent.push({ devices, event: e });
					return [];
				},
			},
		});
		await dispatchEvent(event);
		expect(seenEvents).toEqual([event]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.devices.map((d) => d.id)).toEqual(["a", "b"]);
		expect(sent[0]?.event).toBe(event);
	});

	test("it yields to the event loop before the first target lookup", async () => {
		const { order, logger } = recorder();
		configurePushRuntime({
			logger,
			targets: {
				resolve: async () => {
					order.push("resolve");
					return [];
				},
			},
			service: { sendToDevices: async () => [] },
		});
		const pending = dispatchEvent(event);
		order.push("caller continues");
		await pending;
		expect(order).toEqual(["caller continues", "resolve"]);
	});

	test("no targets means the service is never called", async () => {
		let called = false;
		configurePushRuntime({
			targets: { resolve: async () => [] },
			service: {
				sendToDevices: async () => {
					called = true;
					return [];
				},
			},
		});
		await dispatchEvent(event);
		expect(called).toBe(false);
	});

	test("a throwing resolver is contained: it resolves, logs the error name only, and sends nothing", async () => {
		const { warnings, logger } = recorder();
		let called = false;
		configurePushRuntime({
			logger,
			targets: {
				resolve: async () => {
					throw new TypeError("lookup failed for the value SECRET");
				},
			},
			service: {
				sendToDevices: async () => {
					called = true;
					return [];
				},
			},
		});
		await expect(dispatchEvent(event)).resolves.toBe("retry");
		expect(called).toBe(false);
		expect(warnings).toEqual([
			{ message: "dispatch failed", fields: { type: "permission_wait", error: "TypeError" } },
		]);
		expect(JSON.stringify(warnings)).not.toContain("SECRET");
	});

	test("a throwing service, and a synchronously throwing one, are contained", async () => {
		const { warnings, logger } = recorder();
		const base = { logger, targets: { resolve: async () => [device("a")] } };
		configurePushRuntime({
			...base,
			service: { sendToDevices: async () => Promise.reject(new RangeError("boom")) },
		});
		await expect(dispatchEvent(event)).resolves.toBe("retry");
		configurePushRuntime({
			...base,
			service: {
				sendToDevices: () => {
					throw new Error("sync boom");
				},
			},
		});
		await expect(dispatchEvent(event)).resolves.toBe("retry");
		expect(warnings.map((w) => w.fields?.error)).toEqual(["RangeError", "Error"]);
	});

	test("a non-Error throw is logged as unknown", async () => {
		const { warnings, logger } = recorder();
		configurePushRuntime({
			logger,
			targets: {
				resolve: async () => {
					throw "a string";
				},
			},
			service: { sendToDevices: async () => [] },
		});
		await dispatchEvent(event);
		expect(warnings[0]?.fields?.error).toBe("unknown");
	});

	test("a failure in one dispatch does not affect the next", async () => {
		const { logger } = recorder();
		let calls = 0;
		const sent: string[] = [];
		const runtime: PushRuntime = {
			logger,
			targets: {
				resolve: async () => {
					if (++calls === 1) throw new Error("first fails");
					return [device("a")];
				},
			},
			service: {
				sendToDevices: async (devices) => {
					sent.push(...devices.map((d) => d.id));
					return [];
				},
			},
		};
		configurePushRuntime(runtime);
		await dispatchEvent(event);
		await dispatchEvent(event);
		expect(sent).toEqual(["a"]);
	});

	test("configurePushRuntime(null) removes the runtime", async () => {
		let called = false;
		configurePushRuntime({
			targets: {
				resolve: async () => {
					called = true;
					return [];
				},
			},
			service: { sendToDevices: async () => [] },
		});
		configurePushRuntime(null);
		await dispatchEvent(event);
		expect(called).toBe(false);
	});
});

describe("PolicyPushTargets", () => {
	test("returns every active device in solo mode", async () => {
		const source = new InMemoryDeviceSource([device("a"), device("b")]);
		const targets = new PolicyPushTargets(source, async () => "solo");
		expect((await targets.resolve(event)).map((d) => d.id)).toEqual(["a", "b"]);
		source.remove("a");
		expect((await targets.resolve(event)).map((d) => d.id)).toEqual(["b"]);
	});

	test("leaves out revoked devices: an empty stored send token is no target", async () => {
		const revoked = { ...device("revoked"), sendTokenCiphertext: "" };
		const targets = new PolicyPushTargets(
			new InMemoryDeviceSource([device("a"), revoked]),
			async () => "solo",
		);
		expect((await targets.resolve(event)).map((d) => d.id)).toEqual(["a"]);
	});

	test("fails closed in team mode: nobody is targeted", async () => {
		const targets = new PolicyPushTargets(
			new InMemoryDeviceSource([device("a")]),
			async () => "team",
		);
		expect(await targets.resolve(event)).toEqual([]);
	});
});
