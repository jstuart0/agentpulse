import { create } from "zustand";
import { plainErrorMessage } from "../lib/api-errors.js";
import { type AiStatusResponse, api } from "../lib/api.js";

export type AiStatusUpdate = Parameters<typeof api.updateAiStatus>[0];

interface AiStatusState {
	/** The whole `/ai/status` answer, as the server last said it. */
	status: AiStatusResponse | null;
	/** A reload while a status is held stays "loaded"; only a first load can be "error". */
	loadState: "idle" | "loading" | "loaded" | "error";
	error: string | null;
	/** First load, once: a no-op while loading or loaded; retries after an error. */
	load: () => Promise<void>;
	/** Ask the server again. Callers at the same moment share one request. Rejects on failure. */
	refresh: () => Promise<AiStatusResponse>;
	/** Change the AI status and keep the server's answer, so every reader sees it at once. */
	update: (body: AiStatusUpdate) => Promise<AiStatusResponse>;
}

let inFlight: Promise<AiStatusResponse> | null = null;
/** Bumped by a reset: an answer to a request from before it is not applied. */
let epoch = 0;

/**
 * The one holder of the AI status, so the Settings panel, the session AI tab and the Summary
 * availability rule read the same answer and never ask twice at once.
 */
export const useAiStatusStore = create<AiStatusState>((set, get) => ({
	status: null,
	loadState: "idle",
	error: null,

	refresh() {
		if (inFlight) return inFlight;
		const mine = epoch;
		if (!get().status) set({ loadState: "loading", error: null });
		const request: Promise<AiStatusResponse> = api
			.getAiStatus()
			.then(
				(status) => {
					if (mine === epoch) set({ status, loadState: "loaded", error: null });
					return status;
				},
				(err: unknown) => {
					if (mine === epoch) {
						const error = plainErrorMessage(err);
						set(get().status ? { error } : { loadState: "error", error });
					}
					throw err;
				},
			)
			.finally(() => {
				if (inFlight === request) inFlight = null;
			});
		inFlight = request;
		return request;
	},

	async load() {
		const { loadState } = get();
		if (loadState === "loaded" || loadState === "loading") return;
		try {
			await get().refresh();
		} catch {
			// recorded on the store: loadState "error"
		}
	},

	async update(body) {
		const next = await api.updateAiStatus(body);
		set({ status: next, loadState: "loaded", error: null });
		return next;
	},
}));

/** For tests: forget the shared request and the held status, so one test cannot poison the next. */
export function resetAiStatusStore(): void {
	epoch++;
	inFlight = null;
	useAiStatusStore.setState({ status: null, loadState: "idle", error: null });
}
