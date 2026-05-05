/**
 * CSP violation report ingest endpoint (S-H3).
 *
 * Accepts both content types used by browsers:
 *  - application/csp-report   (legacy CSP Level 2 / Chrome, Firefox)
 *  - application/reports+json (modern Reporting API — Reporting Level 1)
 *
 * No authentication — browsers send these unauthenticated from any origin.
 * The endpoint is intentionally thin: parse, validate, log, return 204.
 *
 * Rate limiting: applied at the Traefik IngressRoute level (P10 public-route
 * middleware). This endpoint must not require auth so the browser can reach it
 * from the CSP report-uri directive.
 *
 * Security hardening (xander M2, M3):
 *  - Body rejected with 413 if Content-Length > MAX_BODY_BYTES (65 536).
 *  - Parsed JSON validated against the CSP report shape; unknown keys dropped.
 *  - String fields truncated to MAX_FIELD_BYTES (2 048) to limit log volume.
 *  - Invalid shapes logged without body and returned 204 (browsers retry on 4xx).
 */

import { Hono } from "hono";
import { getTrustedClientIp } from "../auth/client-ip.js";

const cspReportRouter = new Hono();

const MAX_BODY_BYTES = 65_536;
const MAX_FIELD_BYTES = 2_048;

/** Truncate a string value to MAX_FIELD_BYTES to cap log output. */
function trunc(v: unknown): string | null {
	if (typeof v !== "string") return null;
	return v.length > MAX_FIELD_BYTES ? `${v.slice(0, MAX_FIELD_BYTES)}…` : v;
}

/**
 * Extract only the known fields from a legacy CSP Level 2 report object.
 * Unknown keys are silently dropped.
 */
function parseLegacyReport(raw: unknown): Record<string, string | null> | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const inner = r["csp-report"];
	if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return null;
	const report = inner as Record<string, unknown>;
	return {
		"document-uri": trunc(report["document-uri"]),
		"blocked-uri": trunc(report["blocked-uri"]),
		"violated-directive": trunc(report["violated-directive"]),
		"effective-directive": trunc(report["effective-directive"]),
		"original-policy": trunc(report["original-policy"]),
		disposition: trunc(report.disposition),
		"status-code": trunc(String(report["status-code"] ?? "")),
	};
}

/**
 * Extract known fields from a Reporting API (Level 1) report array.
 * The array must contain at least one element with type "csp-violation" or
 * "Content-Security-Policy". Unknown keys inside each item are dropped.
 */
function parseReportingApiReports(raw: unknown): Array<Record<string, unknown>> | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const results: Array<Record<string, unknown>> = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const r = item as Record<string, unknown>;
		const body = r.body;
		if (typeof body !== "object" || body === null || Array.isArray(body)) continue;
		const b = body as Record<string, unknown>;
		results.push({
			type: trunc(r.type),
			age: typeof r.age === "number" ? r.age : null,
			url: trunc(r.url),
			body: {
				"document-uri": trunc(b["document-uri"] ?? b.documentURL),
				"blocked-uri": trunc(b["blocked-uri"] ?? b.blockedURL),
				"violated-directive": trunc(b["violated-directive"] ?? b.violatedDirective),
				"effective-directive": trunc(b["effective-directive"] ?? b.effectiveDirective),
				disposition: trunc(b.disposition),
				"status-code": typeof b["status-code"] === "number" ? b["status-code"] : null,
			},
		});
	}
	return results.length > 0 ? results : null;
}

cspReportRouter.post("/csp-report", async (c) => {
	const remoteIp = getTrustedClientIp(c);
	const ua = c.req.header("User-Agent") ?? "unknown";
	const ct = c.req.header("Content-Type") ?? "";

	// M3: Reject oversized payloads before reading the body.
	const contentLength = c.req.header("Content-Length");
	if (contentLength !== null) {
		const len = Number(contentLength);
		if (!Number.isNaN(len) && len > MAX_BODY_BYTES) {
			return new Response(null, { status: 413 });
		}
	} else {
		// No Content-Length: reject with 411 rather than stream-capping.
		// Browsers always send Content-Length on report POSTs; missing it is
		// either a buggy client or an attacker probing the endpoint.
		return new Response(null, { status: 411 });
	}

	let raw: unknown;
	try {
		raw = await c.req.json();
	} catch {
		// Malformed JSON or empty body — log without body and return 204.
		// Browsers occasionally send partial reports; 4xx would cause retries.
		console.warn(
			JSON.stringify({
				kind: "csp_report_invalid",
				remoteIp,
				ua,
			}),
		);
		return new Response(null, { status: 204 });
	}

	// M2: Validate against the two documented CSP report shapes.
	const legacy = parseLegacyReport(raw);
	if (legacy !== null) {
		console.warn(
			JSON.stringify({
				kind: "csp_report",
				level: "warn",
				schema: "level2",
				remoteIp,
				ua,
				contentType: ct,
				report: legacy,
			}),
		);
		return new Response(null, { status: 204 });
	}

	const reportingApi = parseReportingApiReports(raw);
	if (reportingApi !== null) {
		console.warn(
			JSON.stringify({
				kind: "csp_report",
				level: "warn",
				schema: "reporting-api",
				remoteIp,
				ua,
				contentType: ct,
				reports: reportingApi,
			}),
		);
		return new Response(null, { status: 204 });
	}

	// Body doesn't match either schema — log without body.
	console.warn(
		JSON.stringify({
			kind: "csp_report_invalid",
			remoteIp,
			ua,
		}),
	);
	return new Response(null, { status: 204 });
});

export { cspReportRouter };
