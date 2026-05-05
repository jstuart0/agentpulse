import { Hono } from "hono";
import { isShuttingDown } from "../drain-state.js";
import { getBgErrorCount, getInFlightCount, getRateLimitedDropped } from "./ingest-counters.js";

const health = new Hono();

// GET /api/v1/health - Liveness probe + operator observability.
//
// Returns 200 always (even during graceful drain) so k8s liveness does not
// SIGKILL the pod before in-flight events finish draining.
//
// Fields added by P7 (audit findings A-H1, A-H3, S-M6):
//  - inFlight: number of async hook-processing tasks in progress.
//  - processingErrors: cumulative count of background processing failures.
//  - rateLimitedDropped: cumulative count of silently-dropped rate-limited hooks.
//  - shuttingDown: true when drain has been triggered (readiness returns 503).
//  - dbReady: placeholder for P10's S-24 fix; true until then.
health.get("/health", (c) => {
	return c.json({
		status: "ok",
		service: "agentpulse",
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
