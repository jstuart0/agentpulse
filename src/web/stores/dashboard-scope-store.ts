import { create } from "zustand";
import { OWNER_ALL, type OwnerParam } from "../lib/owner-scope.js";

interface DashboardScopeState {
	/** Whose sessions the dashboard shows. Solo never leaves "all". */
	owner: OwnerParam;
	/** The stored or default choice is known, so the first request can go out. Solo is resolved from the start. */
	resolved: boolean;
	/** The viewer picked a scope (or an owner): remembered by the caller, applied here. */
	setOwner: (owner: OwnerParam) => void;
	/** The stored or default choice arrived. */
	resolveOwner: (owner: OwnerParam) => void;
}

export const useDashboardScopeStore = create<DashboardScopeState>((set) => ({
	owner: OWNER_ALL,
	resolved: false,
	setOwner: (owner) => set({ owner, resolved: true }),
	resolveOwner: (owner) => set({ owner, resolved: true }),
}));
