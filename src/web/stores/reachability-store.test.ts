import { beforeEach, describe, expect, test } from "bun:test";
import { retryDelayMs } from "../lib/network-retry.js";
import { useReachabilityStore } from "./reachability-store.js";
import { useUserStore } from "./user-store.js";

function probeFailed() {
	(
		useReachabilityStore.getState() as unknown as { reportProbeFailure: () => void }
	).reportProbeFailure();
}

function reset() {
	useReachabilityStore.setState({ unreachable: false, attempt: 0, recoveries: 0 });
	// Past the first identity check: any answer then ends an outage.
	useUserStore.setState({ loaded: true } as never);
}

describe("the retry backoff counts probes, not failed requests", () => {
	beforeEach(reset);

	test("three requests failing at once are one outage and leave the first wait at the base", () => {
		const store = useReachabilityStore.getState();
		store.reportFailure();
		store.reportFailure();
		store.reportFailure();
		const { unreachable, attempt } = useReachabilityStore.getState();
		expect(unreachable).toBe(true);
		expect(retryDelayMs(attempt + 1)).toBe(1_000);
	});

	test("each failed probe doubles the next wait, up to the cap", () => {
		const waits: number[] = [];
		useReachabilityStore.getState().reportFailure();
		for (let probe = 0; probe < 7; probe += 1) {
			waits.push(retryDelayMs(useReachabilityStore.getState().attempt + 1));
			probeFailed();
		}
		expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
	});

	test("an answer clears the outage, resets the wait and tells views to refetch", () => {
		useReachabilityStore.getState().reportFailure();
		probeFailed();
		probeFailed();
		useReachabilityStore.getState().reportSuccess("/sessions");
		const after = useReachabilityStore.getState();
		expect(after.unreachable).toBe(false);
		expect(after.attempt).toBe(0);
		expect(after.recoveries).toBe(1);
		expect(retryDelayMs(after.attempt + 1)).toBe(1_000);
	});

	test("an answer when nothing was wrong changes nothing (no refetch storm)", () => {
		useReachabilityStore.getState().reportSuccess("/sessions");
		expect(useReachabilityStore.getState().recoveries).toBe(0);
	});
});

describe("a failed request is not a fresh start", () => {
	beforeEach(reset);

	test("another request failing during an outage leaves the backoff where the probes put it", () => {
		const store = useReachabilityStore.getState();
		store.reportFailure();
		probeFailed();
		probeFailed();
		store.reportFailure();
		expect(useReachabilityStore.getState().attempt).toBe(2);
		expect(useReachabilityStore.getState().unreachable).toBe(true);
	});
});
