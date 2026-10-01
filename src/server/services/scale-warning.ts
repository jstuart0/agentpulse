/**
 * Best-effort, heuristic boot-time advisory: when the resolved dialect is
 * sqlite and the process environment suggests it's running under an
 * orchestrator that commonly scales to >1 replica (ECS, Kubernetes),
 * log once — SQLite only supports a single server instance (CLAUDE.md
 * "Single-replica constraint"); each replica would get its own local
 * database file and silently diverge. Never a failure, never blocks boot.
 */

export type OrchestratorHint = "ecs" | "kubernetes" | null;

const ORCHESTRATOR_LABELS: Record<Exclude<OrchestratorHint, null>, string> = {
	ecs: "ECS",
	kubernetes: "Kubernetes",
};

export function detectOrchestratorHint(env: Record<string, string | undefined>): OrchestratorHint {
	if (env.ECS_CONTAINER_METADATA_URI || env.ECS_CONTAINER_METADATA_URI_V4) return "ecs";
	if (env.KUBERNETES_SERVICE_HOST) return "kubernetes";
	return null;
}

export function buildSqliteScaleWarning(
	dialect: "sqlite" | "postgres",
	hint: OrchestratorHint,
): string | null {
	if (dialect !== "sqlite" || !hint) return null;
	return `[agentpulse] SQLite backend detected on ${ORCHESTRATOR_LABELS[hint]}: run exactly one replica/task, or set DATABASE_URL for Postgres. Multiple instances each get their own database.`;
}
