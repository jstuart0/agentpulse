import { create } from "zustand";
import { HOST_ALL, type HostParam } from "../lib/host-scope.js";
import { OWNER_ALL, type OwnerParam } from "../lib/owner-scope.js";

interface DashboardScopeState {
	/** Whose sessions the dashboard shows. Solo never leaves "all". */
	owner: OwnerParam;
	/** Which machine's sessions the dashboard shows (see host-scope.ts). Every machine until the viewer picks one, in solo and in team mode alike. */
	host: HostParam;
	/** The stored or default machine is known, so the first request can go out. */
	hostResolved: boolean;
	/** The stored or default choice is known, so the first request can go out. Solo is resolved from the start. */
	resolved: boolean;
	/** The viewer picked a scope (or an owner): remembered by the caller, applied here. */
	setOwner: (owner: OwnerParam) => void;
	/** The viewer picked a machine, or the stored choice arrived. */
	setHost: (host: HostParam) => void;
	/** The stored machine arrived. */
	resolveHost: (host: HostParam) => void;
	/** The stored or default choice arrived. */
	resolveOwner: (owner: OwnerParam) => void;
}

export const useDashboardScopeStore = create<DashboardScopeState>((set) => ({
	owner: OWNER_ALL,
	host: HOST_ALL,
	resolved: false,
	setOwner: (owner) => set({ owner, resolved: true }),
	hostResolved: false,
	setHost: (host) => set({ host, hostResolved: true }),
	resolveHost: (host) => set({ host, hostResolved: true }),
	resolveOwner: (owner) => set({ owner, resolved: true }),
}));
