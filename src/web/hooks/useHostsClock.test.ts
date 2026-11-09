/**
 * The Hosts page's clock, through the hook itself (no DOM): `now` moves only when the hosts were really
 * fetched, a quiet refetch runs on the tick while the tab is in view, and coming back to the tab fetches at
 * once. The page wires this hook to its own fetch; these tests are the wiring, not just the rule behind it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, useState } from "react";
import type { SupervisorRecord } from "../../shared/types.js";
import { deriveHostOutboxNotice } from "../pages/host-outbox-view-state.js";
import {
	fireVisibilityChange,
	flush,
	installDomStubs,
	removeDomStubs,
	renderHook,
	setDocumentHidden,
} from "../test-utils/render-hook.js";
import { useHostsClock } from "./useHostsClock.js";

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());
afterEach(() => setDocumentHidden(false));

const T0 = Date.parse("2026-11-02T12:00:00Z");
const LEASE_MS = 90_000;
const STEP_MS = 30_000; // what one tick stands for in the host's life
const TICK_MS = 15;

type Host = Pick<
	SupervisorRecord,
	"id" | "outbox" | "status" | "heartbeatLeaseExpiresAt" | "enrollmentState" | "capabilities"
>;

/** A host as the server reports it: lease from the moment it answered, with `pending` events if any. */
function hostAt(t: number, pending = 0): Host {
	return {
		id: "h1",
		status: "connected",
		enrollmentState: "active",
		heartbeatLeaseExpiresAt: new Date(t + LEASE_MS).toISOString(),
		capabilities: { features: ["offline_outbox"] } as SupervisorRecord["capabilities"],
		outbox: {
			pending,
			oldestPendingAt: pending ? new Date(t - 60_000).toISOString() : null,
			lastFlushAt: null,
			lastFlushDelivered: 0,
			lastFlushLost: 0,
		},
	};
}

/**
 * A world: real time passes STEP_MS at every refetch (or when the test calls `elapse`); the server answers
 * with a host that has been heartbeating, unless the fetch is set to fail.
 */
function setup(over: { pending?: number; tickMs?: number; pollMs?: number } = {}) {
	let t = T0;
	let fetches = 0;
	const state = { failing: false, stopped: false, pending: over.pending ?? 0 };
	const h = renderHook((_: null) => {
		const [supervisors, setSupervisors] = useState<Host[]>([hostAt(T0, state.pending)]);
		const { now } = useHostsClock({
			supervisors,
			tickMs: over.tickMs ?? TICK_MS,
			pollMs: over.pollMs ?? 10_000,
			clock: () => t,
			refetch: async () => {
				fetches++;
				t += STEP_MS;
				if (state.failing) return false;
				setSupervisors([hostAt(state.stopped ? t - 10 * LEASE_MS : t, state.pending)]);
				return true;
			},
		});
		return { now, host: supervisors[0] as Host };
	}, null);
	const notice = () => {
		const { now, host } = h.current.value as { now: number; host: Host };
		return deriveHostOutboxNotice(host, now);
	};
	return {
		h,
		state,
		notice,
		fetches: () => fetches,
		now: () => (h.current.value as { now: number }).now,
		elapse: (ms: number) => {
			t += ms;
		},
	};
}

describe("a host that keeps heartbeating", () => {
	test("is never shown as offline, however long the page stays open (the tick refetches)", async () => {
		const w = setup();
		await w.h.render(null);
		const start = w.fetches();
		// ten ticks: 300 s of the host's life, well past one 90 s lease
		await flush(TICK_MS * 12);
		expect(w.fetches() - start).toBeGreaterThanOrEqual(8);
		expect(w.now()).toBeGreaterThan(T0 + LEASE_MS);
		expect(w.notice()?.kind ?? null).not.toBe("offline");
		await w.h.unmount();
	});

	test("a host that really stopped does show as offline, within a tick of its lease running out", async () => {
		const w = setup();
		await w.h.render(null);
		w.state.stopped = true; // from now on the server reports a lease that ran out long ago
		await flush(TICK_MS * 3);
		expect(w.notice()?.kind).toBe("offline");
		await w.h.unmount();
	});
});

describe("a failed fetch", () => {
	test("leaves now alone, so hosts don't look offline because the server was unreachable", async () => {
		const w = setup();
		await w.h.render(null);
		await flush(TICK_MS * 3);
		const before = w.now();
		w.state.failing = true;
		const fetchesBefore = w.fetches();
		await flush(TICK_MS * 8);
		expect(w.fetches() - fetchesBefore).toBeGreaterThanOrEqual(4);
		expect(w.now()).toBe(before);
		expect(w.notice()?.kind ?? null).not.toBe("offline");
		await w.h.unmount();
	});

	test("the next good answer moves it on", async () => {
		const w = setup();
		await w.h.render(null);
		w.state.failing = true;
		await flush(TICK_MS * 3);
		const stuck = w.now();
		w.state.failing = false;
		await flush(TICK_MS * 3);
		expect(w.now()).toBeGreaterThan(stuck);
		await w.h.unmount();
	});
});

describe("the tab out of view", () => {
	test("nothing is fetched while it is hidden", async () => {
		const w = setup();
		await w.h.render(null);
		await flush(TICK_MS * 2);
		await act(async () => fireVisibilityChange(true));
		const during = w.fetches();
		await flush(TICK_MS * 8);
		expect(w.fetches()).toBe(during);
		await w.h.unmount();
	});

	test("coming back after a long stretch fetches at once and the catching-up poll resumes", async () => {
		const w = setup({ pending: 9, pollMs: TICK_MS, tickMs: 10_000 });
		await w.h.render(null);
		await act(async () => fireVisibilityChange(true));
		await flush(2);
		w.elapse(130_000); // longer than the lease the page last saw
		const hiddenFetches = w.fetches();
		await flush(TICK_MS * 4);
		expect(w.fetches()).toBe(hiddenFetches);

		await act(async () => fireVisibilityChange(false));
		await flush(2);
		expect(w.fetches(), "a fetch on return, not after the next tick").toBeGreaterThan(
			hiddenFetches,
		);
		expect(w.notice()?.kind).toBe("catching-up");

		const afterReturn = w.fetches();
		await flush(TICK_MS * 6);
		expect(w.fetches(), "and the poll runs again").toBeGreaterThan(afterReturn + 2);
		await w.h.unmount();
	});
});

describe("the tick and the poll", () => {
	test("while a host is catching up the tick is paused: only the poll refetches", async () => {
		// a poll too slow to fire in the window, and a fast tick that would have fired many times
		const w = setup({ pending: 5, pollMs: 10_000, tickMs: TICK_MS });
		await w.h.render(null);
		await flush(TICK_MS * 8);
		expect(w.fetches()).toBe(0);
		await w.h.unmount();
	});

	test("with nothing catching up the tick runs", async () => {
		const w = setup({ pending: 0, pollMs: 10_000, tickMs: TICK_MS });
		await w.h.render(null);
		await flush(TICK_MS * 8);
		expect(w.fetches()).toBeGreaterThanOrEqual(4);
		await w.h.unmount();
	});
});

describe("the catching-up poll", () => {
	test("runs while a host is catching up and stops when it has caught up", async () => {
		const w = setup({ pending: 5, pollMs: TICK_MS, tickMs: 10_000 });
		await w.h.render(null);
		await flush(TICK_MS * 5);
		expect(w.fetches()).toBeGreaterThanOrEqual(3);
		expect(w.notice()?.kind).toBe("catching-up");

		w.state.pending = 0;
		await flush(TICK_MS * 3); // the next answer says nothing is pending
		const settled = w.fetches();
		await flush(TICK_MS * 6);
		expect(w.fetches(), "no polling once none is catching up").toBeLessThanOrEqual(settled + 1);
		await w.h.unmount();
	});
});

describe("the page uses the clock and keeps no clock of its own", () => {
	const page = readFileSync(join(import.meta.dir, "../pages/HostsPage.tsx"), "utf-8");

	test("HostsPage takes `now` from useHostsClock, refetches quietly for it, and never sets the time itself", () => {
		expect(page).toContain("useHostsClock({");
		expect(page).toMatch(/refetch: \(\) => loadSupervisors\(false, true\)/);
		expect(page).not.toMatch(/setNow\(/);
		expect(page).not.toContain("setInterval(");
		// the cards judge leases by the hook's now
		expect(page).toContain("now={now}");
	});

	test("W9: a quiet failure raises a flag, a success clears it, and the line is shown above the cards", () => {
		expect(page).toContain("hostsRefreshNotice(refreshFailed, lastHeardAt, now)");
		expect(page).toContain("{refreshNotice}");
	});
});
