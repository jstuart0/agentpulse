/**
 * Internal-only routes for operational lifecycle management.
 *
 * Security model: these endpoints are loopback-restricted. The **TCP peer**
 * address (from getConnInfo) is checked against 127.0.0.1 / ::1 / localhost;
 * any other peer gets 403. No API key is required — loopback restriction IS
 * the auth.
 *
 * IMPORTANT: X-Forwarded-For is intentionally NOT consulted here. Using the
 * XFF-aware getTrustedClientIp would defeat the restriction: an operator that
 * sets AGENTPULSE_TRUSTED_PROXIES to include the pod CIDR (the recommended
 * config for hook rate-limiting) would allow a request forwarded by Traefik
 * with `X-Forwarded-For: 127.0.0.1` to pass the loopback check — making the
 * drain endpoint externally callable. The TCP peer is the only ground truth.
 *
 * These routes are NOT exposed via Traefik IngressRoute. An explicit deny
 * rule for PathPrefix("/api/v1/internal") appears before the catch-all in
 * 07-ingressroute.yaml, providing defense-in-depth even if the loopback
 * check were somehow bypassed.
 *
 * NetworkPolicy implication: even a compromised sibling pod cannot trigger
 * drain because its peer address is not loopback. The restriction is
 * enforced at the TCP layer by the Bun server before any handler runs.
 */

import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
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
	// Read the raw TCP peer address directly — never via getTrustedClientIp.
	// XFF is irrelevant: loopback auth must be grounded on the transport layer.
	// Falls back to the test-injected peerIp context variable when getConnInfo
	// is unavailable (no Bun server handle in unit tests).
	let peer: string;
	try {
		peer = getConnInfo(c).remote.address ?? "0.0.0.0";
	} catch {
		// getConnInfo requires c.env.server (the Bun server handle).
		// In test contexts it is not available; read the injected peerIp.
		const ctx = c as unknown as { get(k: string): unknown };
		peer = (ctx.get("peerIp") as string | undefined) ?? "0.0.0.0";
	}

	// Strip IPv4-mapped IPv6 prefix before any other processing so that
	// dual-stack Linux kernels presenting "::ffff:127.0.0.1" are correctly
	// recognised as loopback. Must happen before the port-strip below because
	// split(":")[0] returns "" for "::ffff:127.0.0.1".
	const stripped = peer.replace(/^::ffff:/i, "");

	// Strip port suffix if present (e.g. "127.0.0.1:52341" → "127.0.0.1").
	// For pure IPv6 (still contains ":" but no ".") keep the address as-is.
	const peerHost =
		stripped.includes(":") && !stripped.includes(".")
			? stripped
			: (stripped.split(":")[0] ?? stripped);

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
