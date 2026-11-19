/**
 * Fixtures for the update-check suites: a source that serves what the test says, an in-memory store, and a
 * scheduler the test fires by hand. There is no network here; the real https adapter has its own test
 * against a local TLS server.
 */
import type { UpdateCheckResult } from "../../shared/update-status.js";
import type {
	ManifestSource,
	SourceFailureCode,
	SourceResult,
	StoredUpdate,
	UpdateStore,
} from "../services/update-check.js";

export type Scripted = string | { fail: SourceFailureCode; status?: number };

/** Serves each scripted answer once, then repeats the last. Counts every fetch. */
export function fixtureSource(...answers: Scripted[]): ManifestSource & {
	fetches: number;
	push(...answers: Scripted[]): void;
} {
	const queue = [...answers];
	let lastAnswer: Scripted = queue[queue.length - 1] ?? { fail: "network" };
	const source = {
		fetches: 0,
		push(...answers: Scripted[]) {
			queue.push(...answers);
		},
		async fetchEnvelope(): Promise<SourceResult> {
			source.fetches++;
			const next = queue.length > 0 ? (queue.shift() as Scripted) : lastAnswer;
			lastAnswer = next;
			return typeof next === "string"
				? { ok: true, body: next }
				: { ok: false, code: next.fail, ...(next.status ? { status: next.status } : {}) };
		},
	};
	return source;
}

export const EMPTY_STORED: StoredUpdate = {
	envelope: null,
	state: {
		lastCheckedAt: null,
		lastResult: null as UpdateCheckResult | null,
		last: null,
		revoked: [],
	},
};

export function memoryUpdateStore(initial: StoredUpdate = EMPTY_STORED): UpdateStore & {
	snapshot(): StoredUpdate;
	saves: Array<{ envelope?: string | null; state?: StoredUpdate["state"] }>;
} {
	let held: StoredUpdate = structuredClone(initial);
	const store = {
		saves: [] as Array<{ envelope?: string | null; state?: StoredUpdate["state"] }>,
		snapshot: () => structuredClone(held),
		async load() {
			return structuredClone(held);
		},
		async save(next: { envelope?: string | null; state?: StoredUpdate["state"] }) {
			store.saves.push(structuredClone(next));
			held = {
				envelope: next.envelope !== undefined ? next.envelope : held.envelope,
				state: next.state ? structuredClone(next.state) : held.state,
			};
		},
	};
	return store;
}

/** A scheduler whose timers never fire on their own: `fire()` runs the newest one and reports its delay. */
export function manualScheduler() {
	const scheduled: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
	return {
		scheduled,
		schedule(fn: () => void, ms: number) {
			const entry = { ms, fn, cancelled: false };
			scheduled.push(entry);
			return () => {
				entry.cancelled = true;
			};
		},
		/** Delay of the newest live timer, or null. */
		nextDelay(): number | null {
			for (let i = scheduled.length - 1; i >= 0; i--) {
				if (!scheduled[i].cancelled) return scheduled[i].ms;
			}
			return null;
		},
		/** Runs the newest live timer and returns its delay. */
		fire(): number {
			for (let i = scheduled.length - 1; i >= 0; i--) {
				const entry = scheduled[i];
				if (!entry.cancelled) {
					entry.cancelled = true;
					entry.fn();
					return entry.ms;
				}
			}
			throw new Error("no live timer");
		},
	};
}
