import { create } from "zustand";
import type { UpdateStatusWire } from "../../shared/update-status.js";
import { ApiError, api } from "../lib/api.js";

/** The status is reread this often while the page stays open. */
export const REFETCH_INTERVAL_MS = 6 * 3_600_000;
/** A tab that comes back into focus rereads only when what it holds is older than this. */
export const FOCUS_REFETCH_AFTER_MS = 3_600_000;

/** What "Check now" last said, for the panel to show under the button. */
export type CheckNotice = "none" | "checked" | "rate_limited" | "failed";

interface UpdateStoreState {
	/** Null until the first answer. `{ state: "unknown" }` when the server predates the update check. */
	status: UpdateStatusWire | null;
	loadedAt: number | null;
	checking: boolean;
	notice: CheckNotice;
	load: () => Promise<void>;
	refreshIfStale: (now: number) => Promise<void>;
	checkNow: () => Promise<void>;
	reset: () => void;
}

const UNKNOWN: UpdateStatusWire = { state: "unknown" };

function isStatus(value: unknown): value is UpdateStatusWire {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as { state?: unknown }).state === "string"
	);
}

let pending: Promise<void> | null = null;

/**
 * What this dashboard knows about updates, read from `/capabilities` and written straight from "Check now".
 * The status is display data only: nothing here starts or enables an update.
 */
export const useUpdateStore = create<UpdateStoreState>((set, get) => ({
	status: null,
	loadedAt: null,
	checking: false,
	notice: "none",

	load() {
		pending ??= api
			.getCapabilities()
			.then((answer) => {
				// An older server has no `update`; that is "unknown", not an error.
				set({ status: isStatus(answer.update) ? answer.update : UNKNOWN, loadedAt: Date.now() });
			})
			.catch(() => {
				// A failed read keeps what is shown: a server that is briefly unreachable has not changed its state.
			})
			.finally(() => {
				pending = null;
			});
		return pending;
	},

	async refreshIfStale(now) {
		const { loadedAt } = get();
		if (loadedAt === null || now - loadedAt >= FOCUS_REFETCH_AFTER_MS) await get().load();
	},

	async checkNow() {
		if (get().checking) return;
		set({ checking: true, notice: "none" });
		try {
			const answer = await api.checkForUpdates();
			if (!isStatus(answer.update)) throw new Error("not a status");
			set({ status: answer.update, loadedAt: Date.now(), checking: false, notice: "checked" });
		} catch (err) {
			set({
				checking: false,
				notice: err instanceof ApiError && err.status === 429 ? "rate_limited" : "failed",
			});
		}
	},

	reset() {
		pending = null;
		set({ status: null, loadedAt: null, checking: false, notice: "none" });
	},
}));
