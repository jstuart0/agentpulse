/**
 * CSP violation report ingest endpoint (S-H3).
 *
 * Accepts both content types used by browsers:
 *  - application/csp-report   (legacy CSP Level 2 / Chrome, Firefox)
 *  - application/reports+json (modern Reporting API — Reporting Level 1)
 *
 * No authentication — browsers send these unauthenticated from any origin.
 * The endpoint is intentionally thin: parse, log, return 204.
 *
 * Rate limiting: applied at the Traefik IngressRoute level (P10 public-route
 * middleware). This endpoint must not require auth so the browser can reach it
 * from the CSP report-uri directive.
 */

import { Hono } from "hono";
import { getTrustedClientIp } from "../auth/client-ip.js";

const cspReportRouter = new Hono();

cspReportRouter.post("/csp-report", async (c) => {
	const remoteIp = getTrustedClientIp(c);
	const ua = c.req.header("User-Agent") ?? "unknown";
	const ct = c.req.header("Content-Type") ?? "";

	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		// Malformed JSON or empty body — log and return 204 anyway.
		// Browsers occasionally send partial reports; we never want to
		// feed a 4xx back to the browser since it causes retries and noise.
		console.warn(
			JSON.stringify({
				kind: "csp_report",
				level: "warn",
				remoteIp,
				ua,
				body: null,
				parseError: "invalid JSON or empty body",
			}),
		);
		return new Response(null, { status: 204 });
	}

	console.warn(
		JSON.stringify({
			kind: "csp_report",
			level: "warn",
			remoteIp,
			ua,
			contentType: ct,
			body,
		}),
	);

	// 204 No Content — browsers do not need a body here.
	return new Response(null, { status: 204 });
});

export { cspReportRouter };
