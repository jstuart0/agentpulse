import { create } from "zustand";

/**
 * WS connection state visible to the UI.
 *
 * connected   — WS is open and receiving heartbeats.
 * reconnecting — WS closed; attempting to reconnect (dashboard still
 *               refreshes via 30 s polling).
 * paused      — Enough consecutive failures that we've given up on WS
 *               (polling is the only update path). Note: "paused" not
 *               "disconnected" — the app never goes fully dark.
 */
export type WsConnectionState = "connected" | "reconnecting" | "paused";

interface ConnectionStore {
	wsState: WsConnectionState;
	lastConnectedAt: number | null;
	setWsState: (state: WsConnectionState) => void;
	markConnected: () => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
	wsState: "reconnecting",
	lastConnectedAt: null,

	setWsState: (wsState) => set({ wsState }),

	markConnected: () =>
		set({
			wsState: "connected",
			lastConnectedAt: Date.now(),
		}),
}));
