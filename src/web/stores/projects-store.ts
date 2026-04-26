import { create } from "zustand";
import type { Project } from "../../shared/types.js";
import { api } from "../lib/api.js";

interface ProjectsStore {
	projects: Project[];
	loaded: boolean;
	load: () => Promise<void>;
	getById: (id: string | null | undefined) => Project | null;
}

export const useProjectsStore = create<ProjectsStore>((set, get) => ({
	projects: [],
	loaded: false,

	load: async () => {
		try {
			const result = await api.listProjects();
			set({ projects: result.projects, loaded: true });
		} catch {
			set({ loaded: true });
		}
	},

	getById: (id) => {
		if (!id) return null;
		return get().projects.find((p) => p.id === id) ?? null;
	},
}));
