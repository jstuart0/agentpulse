import { create } from "zustand";

/**
 * Which Summary sections the person has collapsed or expanded ("Show all"), held for the life of
 * the session page so switching tabs doesn't lose it. Sections start open, with long ones
 * trimmed to their first items; the page clears it when the session changes or the page closes.
 */
interface SummaryViewState {
	closed: Record<string, boolean>;
	expanded: Record<string, boolean>;
	setOpen: (section: string, open: boolean) => void;
	setExpanded: (section: string, expanded: boolean) => void;
	reset: () => void;
}

export const useSummaryViewStore = create<SummaryViewState>((set) => ({
	closed: {},
	expanded: {},
	setOpen: (section, open) =>
		set((s) => (s.closed[section] === !open ? s : { closed: { ...s.closed, [section]: !open } })),
	setExpanded: (section, expanded) =>
		set((s) =>
			s.expanded[section] === expanded ? s : { expanded: { ...s.expanded, [section]: expanded } },
		),
	reset: () => set({ closed: {}, expanded: {} }),
}));
