import { create } from "zustand";
import { plainErrorMessage } from "../lib/api-errors.js";
import type { AiStatusResponse, api } from "../lib/api.js";

export type AiStatusUpdate = Parameters<typeof api.updateAiStatus>[0];

interface AiStatusState {
	status: AiStatusResponse | null;
	loadState: "idle" | "loading" | "loaded" | "error";
	error: string | null;
	load: () => Promise<void>;
	refresh: () => Promise<AiStatusResponse>;
	update: (body: AiStatusUpdate) => Promise<AiStatusResponse>;
}

export const useAiStatusStore = create<AiStatusState>(() => ({
	status: null,
	loadState: "idle",
	error: null,
	async load() {
		throw new Error("not implemented");
	},
	async refresh() {
		throw new Error("not implemented");
	},
	async update(_body) {
		throw new Error("not implemented");
	},
}));

void plainErrorMessage;
