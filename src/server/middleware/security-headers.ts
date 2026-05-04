/**
 * Security headers middleware (S-H3).
 *
 * Adds defensive HTTP response headers to every request:
 *  - Content-Security-Policy-Report-Only (report-only; flip to enforce in a
 *    future release once the CSP report sink has collected real-world data)
 *  - X-Frame-Options: DENY (clickjacking)
 *  - X-Content-Type-Options: nosniff (MIME sniffing)
 *  - Strict-Transport-Security (HSTS; only meaningful over TLS)
 *  - Referrer-Policy: strict-origin-when-cross-origin
 *  - Report-To (modern Reporting API for CSP)
 *
 * The CSP allowlist covers the current Vite-built asset graph:
 *  - script-src 'self'          — hash-named .js bundles served from origin
 *  - style-src 'self' 'unsafe-inline' — Tailwind injects inline styles at runtime
 *  - img-src 'self' data:       — avatars and SVG data URIs
 *  - connect-src 'self' wss://… — XHR/fetch + WebSocket (derived from PUBLIC_URL)
 *  - font-src 'self'            — self-hosted fonts only
 *  - report-uri + report-to     — route CSP violations to the ingest endpoint
 *
 * 'unsafe-inline' in style-src: Tailwind CSS-in-JS / JIT injects inline styles.
 * Verify with `vite build` output — if all styles are in the .css bundle with no
 * inline style attributes, this can be tightened to 'self' in a future phase.
 */

import type { Context, MiddlewareHandler, Next } from "hono";
import { config } from "../config.js";

const CSP_REPORT_URI = "/api/v1/csp-report";
const REPORT_TO_GROUP = "csp-default";
const HSTS_MAX_AGE = 63_072_000; // 2 years in seconds

function buildCspDirectives(publicUrl: string): string {
	// Derive the WebSocket host from the first PUBLIC_URL entry.
	// wss:// must match the host exactly; derive from the canonical public URL.
	let wsHost: string;
	try {
		const u = new URL(publicUrl);
		wsHost = u.host; // e.g. "agentpulse.example.com" or "localhost:3000"
	} catch {
		wsHost = "localhost:3000";
	}

	const directives = [
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data:",
		"font-src 'self'",
		`connect-src 'self' wss://${wsHost}`,
		`report-uri ${CSP_REPORT_URI}`,
		`report-to ${REPORT_TO_GROUP}`,
	];

	return directives.join("; ");
}

function buildReportToHeader(): string {
	const endpoint = { url: CSP_REPORT_URI };
	const group = {
		group: REPORT_TO_GROUP,
		max_age: 10_886_400,
		endpoints: [endpoint],
	};
	return JSON.stringify(group);
}

export function securityHeaders(): MiddlewareHandler {
	// Build headers once at middleware-creation time; PUBLIC_URL is static.
	const publicUrl = config.publicUrl.split(",")[0]?.trim() ?? "http://localhost:3000";
	const csp = buildCspDirectives(publicUrl);
	const reportTo = buildReportToHeader();

	return async (_c: Context, next: Next) => {
		await next();

		// Headers are set after the handler so they apply to every response
		// including error responses produced by downstream handlers.
		const res = _c.res;

		res.headers.set("X-Frame-Options", "DENY");
		res.headers.set("X-Content-Type-Options", "nosniff");
		res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
		res.headers.set("Strict-Transport-Security", `max-age=${HSTS_MAX_AGE}; includeSubDomains`);
		res.headers.set("Content-Security-Policy-Report-Only", csp);
		res.headers.set("Report-To", reportTo);
	};
}
