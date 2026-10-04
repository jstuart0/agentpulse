import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type AiStatusResponse, api } from "../lib/api.js";
import { deferred } from "../test-utils/render-hook.js";
import { useAiStatusStore } from "./ai-status-store.js";

// biome-ignore lint/suspicious/noExplicitAny: the client is replaced method by method
const client = api as any;
const real = { getAiStatus: api.getAiStatus, updateAiStatus: api.updateAiStatus };
const STATUS: AiStatusResponse = {
	build: true,
	runtime: true,
	killSwitch: false,
	active: true,
	classifierEnabled: true,
	classifierAffectsRunner: false,
	autoEnableWatcherForAsk: true,
};
let statusCalls = 0;

function reset() {
	useAiStatusStore.setState({ status: null, loadState: "idle", error: null });
}
beforeEach(() => {
	statusCalls = 0;
	reset();
});
afterEach(() => {
	client.getAiStatus = real.getAiStatus;
	client.updateAiStatus = real.updateAiStatus;
	reset();
});

describe("ai-status-store", () => {
	test("TC-7.29a holds the full status and moves idle, loading, loaded", async () => {
		const d = deferred<AiStatusResponse>();
		client.getAiStatus = () => {
			statusCalls++;
			return d.promise;
		};
		const p = useAiStatusStore.getState().load();
		expect(useAiStatusStore.getState().loadState).toBe("loading");
		d.resolve(STATUS);
		await p;
		const s = useAiStatusStore.getState();
		expect(s.loadState).toBe("loaded");
		expect(s.status).toEqual(STATUS);
		expect(s.error).toBeNull();
	});

	test("TC-7.29b a failed first fetch is error, not loading forever, and load retries it", async () => {
		client.getAiStatus = async () => {
			statusCalls++;
			throw new Error("down");
		};
		await useAiStatusStore.getState().load();
		expect(useAiStatusStore.getState().loadState).toBe("error");
		expect(useAiStatusStore.getState().status).toBeNull();
		expect(useAiStatusStore.getState().error).toBeTruthy();
		client.getAiStatus = async () => {
			statusCalls++;
			return STATUS;
		};
		await useAiStatusStore.getState().load();
		expect(useAiStatusStore.getState().loadState).toBe("loaded");
		expect(statusCalls).toBe(2);
	});

	test("TC-7.29c load is a no-op once loaded; refresh always asks again and returns the status", async () => {
		client.getAiStatus = async () => {
			statusCalls++;
			return STATUS;
		};
		await useAiStatusStore.getState().load();
		await useAiStatusStore.getState().load();
		expect(statusCalls).toBe(1);
		const next = await useAiStatusStore.getState().refresh();
		expect(statusCalls).toBe(2);
		expect(next).toEqual(STATUS);
	});

	test("TC-7.29d two callers at once share one network call", async () => {
		const d = deferred<AiStatusResponse>();
		client.getAiStatus = () => {
			statusCalls++;
			return d.promise;
		};
		const a = useAiStatusStore.getState().refresh();
		const b = useAiStatusStore.getState().refresh();
		const c = useAiStatusStore.getState().load();
		d.resolve(STATUS);
		await Promise.all([a, b, c]);
		expect(statusCalls).toBe(1);
	});

	test("TC-7.29e a failed refresh after a good load keeps the status, rethrows and records the error", async () => {
		client.getAiStatus = async () => STATUS;
		await useAiStatusStore.getState().load();
		client.getAiStatus = async () => {
			throw new Error("blip");
		};
		await expect(useAiStatusStore.getState().refresh()).rejects.toThrow("blip");
		const s = useAiStatusStore.getState();
		expect(s.status).toEqual(STATUS);
		expect(s.loadState).toBe("loaded");
		expect(s.error).toBeTruthy();
	});

	test("TC-7.29f update stores the server's answer so a Settings change shows without a reload", async () => {
		client.getAiStatus = async () => STATUS;
		await useAiStatusStore.getState().load();
		let sent: unknown = null;
		client.updateAiStatus = async (body: unknown) => {
			sent = body;
			return { ...STATUS, killSwitch: true, active: false };
		};
		const result = await useAiStatusStore.getState().update({ killSwitch: true });
		expect(sent).toEqual({ killSwitch: true });
		expect(result.killSwitch).toBe(true);
		expect(useAiStatusStore.getState().status).toMatchObject({
			killSwitch: true,
			active: false,
			classifierEnabled: true,
		});
		client.updateAiStatus = async () => {
			throw new Error("nope");
		};
		await expect(useAiStatusStore.getState().update({ enabled: false })).rejects.toThrow("nope");
		expect(useAiStatusStore.getState().status?.killSwitch).toBe(true);
	});

	test("TC-7.29g AiPanel and AiSettingsPanel go through the store's fetcher, not the client", () => {
		const root = join(import.meta.dir, "..", "components");
		for (const file of ["session-detail/AiPanel.tsx", "settings/AiSettingsPanel.tsx"]) {
			const source = readFileSync(join(root, file), "utf8");
			expect(source, file).not.toContain("api.getAiStatus");
			expect(source, file).not.toContain("api.updateAiStatus");
			expect(source, file).toContain("useAiStatusStore");
		}
	});
});
