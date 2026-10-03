import { describe, expect, test } from "bun:test";
import { runRetryProbe } from "./retry-probe.js";

function deps(over: Partial<Parameters<typeof runRetryProbe>[0]> = {}) {
	const calls: string[] = [];
	return {
		calls,
		d: {
			identityPending: false,
			loadIdentity: async () => {
				calls.push("identity");
			},
			identityConfirmed: () => true,
			health: async () => {
				calls.push("health");
			},
			onFail: () => {
				calls.push("fail");
			},
			...over,
		},
	};
}

describe("runRetryProbe", () => {
	test("with the identity unknown the probe is the identity check, not health", async () => {
		const { calls, d } = deps({ identityPending: true });
		await runRetryProbe(d);
		expect(calls).toEqual(["identity"]);
	});

	test("an identity check that still cannot confirm counts as one failed probe", async () => {
		const { calls, d } = deps({ identityPending: true, identityConfirmed: () => false });
		await runRetryProbe(d);
		expect(calls).toEqual(["identity", "fail"]);
	});

	test("an identity check that throws counts as one failed probe", async () => {
		const { calls, d } = deps({
			identityPending: true,
			loadIdentity: async () => {
				throw new Error("down");
			},
			identityConfirmed: () => false,
		});
		await runRetryProbe(d);
		expect(calls).toEqual(["fail"]);
	});

	test("with the identity known a health call decides, and a failure counts", async () => {
		const ok = deps();
		await runRetryProbe(ok.d);
		expect(ok.calls).toEqual(["health"]);
		const bad = deps({
			health: async () => {
				throw new Error("down");
			},
		});
		await runRetryProbe(bad.d);
		expect(bad.calls).toEqual(["fail"]);
	});
});
