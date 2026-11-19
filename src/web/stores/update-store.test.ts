import { afterEach, describe, expect, test } from "bun:test";
import type { UpdateStatusWire } from "../../shared/update-status.js";
import { ApiError, api } from "../lib/api.js";
import { deferred } from "../test-utils/render-hook.js";
import { FOCUS_REFETCH_AFTER_MS, REFETCH_INTERVAL_MS, useUpdateStore } from "./update-store.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { ...api };
const HOUR = 3_600_000;

const STATUS: UpdateStatusWire = {
	current: "0.11.0",
	latest: "0.12.0",
	state: "available",
	stale: false,
	severity: "normal",
	checkedAt: "2026-11-19T12:00:00.000Z",
	lastResult: "ok",
	manifestIssuedAt: "2026-11-19T11:00:00.000Z",
	installKind: "local",
	track: "release",
	localApply: null,
};

afterEach(() => {
	Object.assign(api, real);
	useUpdateStore.getState().reset();
});

describe("the update store", () => {
	test("the intervals are the plan's: reread every 6 hours, on focus only when older than an hour", () => {
		expect(REFETCH_INTERVAL_MS).toBe(6 * HOUR);
		expect(FOCUS_REFETCH_AFTER_MS).toBe(HOUR);
	});

	test("load reads capabilities.update into the store", async () => {
		client.getCapabilities = async () => ({ features: {}, update: STATUS });
		await useUpdateStore.getState().load();
		expect(useUpdateStore.getState().status).toEqual(STATUS);
		expect(useUpdateStore.getState().loadedAt).not.toBeNull();
	});

	test("a server with no update field is state unknown, not an error and not nothing", async () => {
		client.getCapabilities = async () => ({ features: {} });
		await useUpdateStore.getState().load();
		expect(useUpdateStore.getState().status).toEqual({ state: "unknown" });
	});

	test("a failed read keeps what was shown and doesn't throw", async () => {
		client.getCapabilities = async () => ({ update: STATUS });
		await useUpdateStore.getState().load();
		client.getCapabilities = async () => {
			throw new Error("offline");
		};
		await useUpdateStore.getState().load();
		expect(useUpdateStore.getState().status).toEqual(STATUS);
	});

	test("overlapping loads share one request", async () => {
		const gate = deferred<{ update: typeof STATUS }>();
		let calls = 0;
		client.getCapabilities = () => {
			calls++;
			return gate.promise;
		};
		const a = useUpdateStore.getState().load();
		const b = useUpdateStore.getState().load();
		gate.resolve({ update: STATUS });
		await Promise.all([a, b]);
		expect(calls).toBe(1);
	});

	test("refreshIfStale: nothing inside the hour, a read after it, and a read when never loaded", async () => {
		let calls = 0;
		client.getCapabilities = async () => {
			calls++;
			return { update: STATUS };
		};
		const t0 = Date.now();
		await useUpdateStore.getState().refreshIfStale(t0);
		expect(calls).toBe(1);
		await useUpdateStore.getState().refreshIfStale(t0 + HOUR - 5000);
		expect(calls).toBe(1);
		await useUpdateStore.getState().refreshIfStale(t0 + HOUR + 5000);
		expect(calls).toBe(2);
	});

	test("Check now writes the response straight into the store, with no second read", async () => {
		let reads = 0;
		client.getCapabilities = async () => {
			reads++;
			return { update: { ...STATUS, state: "current" } };
		};
		client.checkForUpdates = async () => ({ update: STATUS });
		await useUpdateStore.getState().checkNow();
		expect(useUpdateStore.getState().status).toEqual(STATUS);
		expect(useUpdateStore.getState().notice).toBe("checked");
		expect(reads).toBe(0);
	});

	test("a 429 says it was checked a moment ago and keeps the status", async () => {
		client.getCapabilities = async () => ({ update: STATUS });
		await useUpdateStore.getState().load();
		client.checkForUpdates = async () => {
			throw new ApiError(429, "rate_limited");
		};
		await useUpdateStore.getState().checkNow();
		expect(useUpdateStore.getState().notice).toBe("rate_limited");
		expect(useUpdateStore.getState().status).toEqual(STATUS);
		expect(useUpdateStore.getState().checking).toBe(false);
	});

	test("any other failure is a failed notice, and checking clears", async () => {
		client.checkForUpdates = async () => {
			throw new ApiError(500, "boom");
		};
		await useUpdateStore.getState().checkNow();
		expect(useUpdateStore.getState().notice).toBe("failed");
		expect(useUpdateStore.getState().checking).toBe(false);
	});

	test("a Check now answer that isn't a status is a failure, never stored", async () => {
		client.checkForUpdates = async () => ({ update: "nope" });
		await useUpdateStore.getState().checkNow();
		expect(useUpdateStore.getState().status).toBeNull();
		expect(useUpdateStore.getState().notice).toBe("failed");
	});
});
