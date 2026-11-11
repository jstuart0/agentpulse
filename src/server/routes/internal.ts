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
 * Browsers: no request a browser sends may reach any route here, with auth on
 * or off. A page on any site can POST to http://127.0.0.1:<port>; the browser
 * runs on this machine, so the peer is loopback. Browsers always add `Origin`
 * to a POST and fetch-metadata browsers add `Sec-Fetch-*`; the one legitimate
 * caller (the preStop hook, Bun's fetch) sends none of them. So the router
 * refuses any request carrying one of those headers, whatever its value.
 * A browser that sends neither (an old Firefox with the Origin header turned
 * off) is still caught: a form post or no-cors fetch always carries a
 * Content-Type of form-urlencoded, multipart or text/plain, so any
 * Content-Type other than application/json is refused too. The preStop call
 * has no body and sends no Content-Type.
 * `refuseBadOrigin` is deliberately not used: it accepts Origin equal to Host
 * with auth on, which a DNS-rebinding page satisfies. No Host check is added:
 * a rebinding page still sends Origin and is refused, and a non-browser
 * process on loopback can set any Host anyway.
 *
 * NetworkPolicy implication: even a compromised sibling pod cannot trigger
 * drain because its peer address is not loopback. The restriction is
 * enforced at the TCP layer by the Bun server before any handler runs.
 */

import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { hasBrowserRequestSignal, hasNonJsonContentType } from "../auth/request-origin.js";
import { setShuttingDown } from "../drain-state.js";
import { getInFlightCount } from "./ingest-counters.js";

const internalRouter = new Hono();

const BROWSER_REFUSAL_LOG_INTERVAL_MS = 60_000;
let lastBrowserRefusalLogAt = 0;
let suppressedBrowserRefusals = 0;

// Registered before every route so any method and any future route inherits it.
// The Origin value is never logged, and one line a minute at most, so a hostile
// page can't flood the log.
internalRouter.use("*", async (c, next) => {
	if (
		!hasBrowserRequestSignal((name) => c.req.header(name)) &&
		!hasNonJsonContentType(c.req.header("Content-Type"))
	) {
		return next();
	}
	const now = Date.now();
	if (now - lastBrowserRefusalLogAt >= BROWSER_REFUSAL_LOG_INTERVAL_MS) {
		console.warn(
			JSON.stringify({
				kind: "internal_rejected_browser",
				level: "warn",
				suppressed: suppressedBrowserRefusals,
			}),
		);
		lastBrowserRefusalLogAt = now;
		suppressedBrowserRefusals = 0;
	} else {
		suppressedBrowserRefusals++;
	}
	return c.json({ error: "bad_origin" }, 403);
});

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
