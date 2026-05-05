/**
 * Graceful drain state module.
 *
 * Kept in its own file to avoid circular imports between index.ts (which
 * mounts all routes) and internal.ts (which sets the drain flag).
 *
 * Once shuttingDown is true:
 *  - GET /api/v1/ready returns 503 → Traefik stops routing new traffic.
 *  - GET /api/v1/health still returns 200 → k8s liveness stays passing.
 *  - In-flight hook events continue to drain (tracked in ingest-counters.ts).
 *
 * The flag is set by:
 *  1. POST /api/v1/internal/drain (k8s preStop hook — runs before SIGTERM).
 *  2. SIGTERM/SIGINT handlers in index.ts (fallback for non-k8s shutdowns).
 */

let shuttingDown = false;

export function isShuttingDown(): boolean {
	return shuttingDown;
}

export function setShuttingDown(reason: string): void {
	if (!shuttingDown) {
		shuttingDown = true;
		console.log(JSON.stringify({ kind: "lifecycle_drain_start", reason }));
	}
}

/** Reset for tests only — do not call in production code. */
export function _resetDrainStateForTest(): void {
	shuttingDown = false;
}
