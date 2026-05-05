import { Hono } from "hono";
import pkg from "../../../package.json" with { type: "json" };
import { isShuttingDown } from "../drain-state.js";
import { getBgErrorCount, getInFlightCount, getRateLimitedDropped } from "./ingest-counters.js";

// Read version from package.json at module init — independent of how the
// process was launched (file-path invocation doesn't inject npm_package_version).
const APP_VERSION: string = pkg.version;

const health = new Hono();

// ── DB-ready gate (S-24) ──────────────────────────────────────────────────────
//
// The startupProbe polls /api/v1/health. We must return 503 until
// initializeDatabase() has completed all migrations so the probe does not
// pass early and allow livenessProbe to SIGKILL the pod mid-migration.
//
// index.ts calls markDbReady() immediately after `await initializeDatabase()`.
// initializeDatabase() is async since Phase 1 of the postgres-backend campaign
// (Decision 15). The event loop yields during the await, but because index.ts
// runs at module load time before Bun.serve() is called, no requests can land
// before the await resolves and markDbReady() fires. The 503 window is
// confined to the true migration period.
let _dbReady = false;

export function markDbReady(): void {
	_dbReady = true;
}

/** Reset db-ready gate to a known state for tests only — do not call in production code. */
export function _resetDbReadyForTest(ready = false): void {
	_dbReady = ready;
}

// GET /api/v1/health - Liveness probe + operator observability.
//
// Returns 503 until the database has finished initialising (startupProbe
// gate). Returns 200 always thereafter — even during graceful drain — so k8s
// liveness does not SIGKILL the pod before in-flight events finish draining.
//
// Fields added by P7 (audit findings A-H1, A-H3, S-M6):
//  - inFlight: number of async hook-processing tasks in progress.
//  - processingErrors: cumulative count of background processing failures.
//  - rateLimitedDropped: cumulative count of silently-dropped rate-limited hooks.
//  - shuttingDown: true when drain has been triggered (readiness returns 503).
//  - dbReady: true only after initializeDatabase() completes (S-24).
health.get("/health", (c) => {
	if (!_dbReady) {
		return c.json(
			{
				status: "starting",
				service: "agentpulse",
				timestamp: new Date().toISOString(),
				dbReady: false,
			},
			503,
		);
	}
	return c.json({
		status: "ok",
		service: "agentpulse",
		version: APP_VERSION,
		timestamp: new Date().toISOString(),
		inFlight: getInFlightCount(),
		processingErrors: getBgErrorCount(),
		rateLimitedDropped: getRateLimitedDropped(),
		shuttingDown: isShuttingDown(),
		dbReady: true,
	});
});

// GET /api/v1/ready - Readiness probe.
//
// Returns 503 the moment shuttingDown is true (drain endpoint or SIGTERM),
// so Traefik stops routing new traffic while in-flight events finish.
// Returns 200 when not shutting down (pod is ready to accept requests).
health.get("/ready", (c) => {
	if (isShuttingDown()) {
		return c.json({ ready: false, reason: "draining" }, 503);
	}
	return c.json({ ready: true });
});

export { health };
