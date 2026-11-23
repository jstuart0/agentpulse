/**
 * Reading a server's /health: the running version, the database fingerprint and dialect, and (when asked)
 * the signed release envelope it stores. Every request goes through `fetchCapped` (a deadline, a byte cap,
 * no redirects, no cookies, no custom headers); what comes back is data the updater compares and verifies,
 * never a command or a URL to follow.
 */
import type { CappedFetchOptions, CappedFetchResult } from "../shared/capped-fetch.js";

export type FetchText = (url: string, options: CappedFetchOptions) => Promise<CappedFetchResult>;

export const HEALTH_MAX_BYTES = 128 * 1024;
const HEALTH_DEADLINE_MS = 10_000;

export interface HealthInfo {
	version: string | null;
	dbFingerprint: string | null;
	dialect: string | null;
	/** Present only for `manifest: true`: the stored envelope text, or null. */
	releaseManifest: string | null;
	/** The server's own update-check state (`update.state`), or null from a server that doesn't report one. */
	updateState: string | null;
}

/** The server's health answer, or null when it didn't answer `ok`. `httpsOrLoopbackOnly: false` is for a supervisor-only install on a plain-http LAN server (U7). */
export async function probeHealth(
	fetchText: FetchText,
	baseUrl: string,
	options: { manifest?: boolean; httpsOrLoopbackOnly?: boolean } = {},
): Promise<HealthInfo | null> {
	const base = baseUrl.replace(/\/+$/, "");
	const url = `${base}/api/v1/health${options.manifest ? "?manifest=1" : ""}`;
	const result = await fetchText(url, {
		deadlineMs: HEALTH_DEADLINE_MS,
		maxBytes: HEALTH_MAX_BYTES,
		httpsOrLoopbackOnly: options.httpsOrLoopbackOnly ?? true,
	});
	if (!result.ok) return null;
	try {
		const body = JSON.parse(result.body) as Record<string, unknown>;
		if (body.status !== "ok") return null;
		const instance =
			typeof body.instance === "object" && body.instance !== null
				? (body.instance as Record<string, unknown>)
				: {};
		const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length < 64 ? v : null);
		const update =
			typeof body.update === "object" && body.update !== null
				? (body.update as Record<string, unknown>)
				: {};
		return {
			version: str(body.version),
			dbFingerprint: str(instance.dbFingerprint),
			dialect: str(instance.dialect),
			releaseManifest: typeof body.releaseManifest === "string" ? body.releaseManifest : null,
			updateState: str(update.state),
		};
	} catch {
		return null;
	}
}
