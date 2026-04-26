import { db } from "../../db/client.js";
import { projects } from "../../db/schema.js";

// In-process cache. Single-Bun-process assumption is fine for the
// homelab deployment. If AgentPulse ever moves to multi-instance,
// this becomes per-instance and needs a refresh signal (e.g. Postgres
// LISTEN/NOTIFY or polling) — flagged as a future concern, not a blocker.

// Extended from the base ProjectRecord (id + cwd) to include name,
// which the launch-intent detector needs for keyword matching and LLM context.
export interface CachedProject {
	id: string;
	name: string;
	cwd: string;
}

let cached: CachedProject[] = [];
let version = 0;

export function getCachedProjects(): CachedProject[] {
	return cached;
}

export async function bumpVersionAndReload(): Promise<void> {
	version += 1;
	await reloadCache();
}

async function reloadCache(): Promise<void> {
	const rows = await db
		.select({ id: projects.id, name: projects.name, cwd: projects.cwd })
		.from(projects);
	cached = rows;
}

// Called once at server boot before hook ingestion routes are mounted.
// Avoids a cache-miss stampede on the first event after restart.
export async function loadEager(): Promise<void> {
	await reloadCache();
}

export { version };
