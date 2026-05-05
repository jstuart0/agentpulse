/**
 * Internal-only routes for operational lifecycle management.
 *
 * Security model: these endpoints are loopback-restricted. The TCP peer
 * address is checked against 127.0.0.1 / ::1 / localhost; any other peer
 * gets 403. No API key is required — loopback restriction IS the auth.
 *
 * These routes must NOT be exposed via Traefik IngressRoute. The path
 * prefix /api/v1/internal/* must be excluded from public IngressRoute
 * rules (enforced in P10's manifest sweep).
 *
 * NetworkPolicy implication: even a compromised sibling pod cannot trigger
 * drain because its peer address is not loopback. The restriction is
 * enforced at the TCP layer by the Bun server before any handler runs.
 */

import { Hono } from "hono";
import { getTrustedClientIp } from "../auth/client-ip.js";
import { setShuttingDown } from "../drain-state.js";
import { getInFlightCount } from "./ingest-counters.js";

const internalRouter = new Hono();

// POST /api/v1/internal/drain
//
// Called by the k8s preStop hook to initiate graceful drain before SIGTERM.
// Sets shuttingDown=true so the readiness probe returns 503 immediately,
// stopping Traefik from routing new traffic to this pod.
//
// Returns 200 with { shuttingDown: true, inFlight: number } once the flag
// is set. Does NOT wait for drain to complete — polling is the preStop
// hook's job (poll /api/v1/health for inFlight === 0).
//
// Idempotent: calling again after the flag is already set is safe.
internalRouter.post("/drain", (c) => {
	// Resolve the TCP peer address. getTrustedClientIp falls back to "0.0.0.0"
	// in test contexts where getConnInfo is unavailable — that will be rejected
	// below, which is the correct behaviour for tests that don't set peerIp.
	const peer = getTrustedClientIp(c);

	// Strip port suffix if present (e.g. "127.0.0.1:52341" → "127.0.0.1").
	const peerHost = peer.includes(":") && !peer.includes(".") ? peer : (peer.split(":")[0] ?? peer);

	const isLoopback =
		peerHost === "127.0.0.1" || peerHost === "::1" || peerHost.toLowerCase() === "localhost";

	if (!isLoopback) {
		console.warn(
			JSON.stringify({
				kind: "drain_rejected_non_loopback",
				level: "warn",
				peer,
			}),
		);
		return c.json({ error: "Forbidden: loopback only" }, 403);
	}

	setShuttingDown("drain_endpoint");

	return c.json({
		shuttingDown: true,
		inFlight: getInFlightCount(),
	});
});

export { internalRouter };
