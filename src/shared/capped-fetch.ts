/**
 * The outbound GET for version documents and release bytes: one deadline, one byte cap, no redirects.
 *
 * Deliberately a small copy of the discipline in `services/ai/http.ts` (`llmFetch`), not an import of it:
 * that module is tied to `LlmError` and the LLM call-site guard, and this one is embedded verbatim into
 * `scripts/relay.ts` (marker block `capped-fetch`), so it imports nothing.
 *
 * It sends a bare GET: no cookies, no custom headers, no body. It returns a result with a code and never
 * throws, so a caller's failure path is a value it can branch on, not an exception it must remember to catch.
 */

export type CappedFetchResult =
	| { ok: true; status: number; body: string }
	| {
			ok: false;
			code:
				| "bad_options"
				| "bad_url"
				| "insecure"
				| "redirect"
				| "status"
				| "too_large"
				| "timeout"
				| "network";
			status?: number;
	  };

export interface CappedFetchOptions {
	/** One deadline for the whole exchange, headers and body included. */
	deadlineMs: number;
	/** Counted on raw bytes before decoding. A body of exactly this many bytes passes. */
	maxBytes: number;
	/** Default true: http is allowed only for a loopback host. */
	httpsOrLoopbackOnly?: boolean;
}

/** Bun's `fetch` takes `timeout`, which `bun-types` does not declare. */
type BunRequestInit = RequestInit & { timeout?: false };

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "[::1]" || LOOPBACK_V4.test(hostname);
}

/** Null when the URL may be fetched, else the refusal code. */
function refuseUrl(url: URL, httpsOrLoopbackOnly: boolean): "bad_url" | "insecure" | null {
	if (url.protocol !== "https:" && url.protocol !== "http:") return "bad_url";
	if (url.username !== "" || url.password !== "") return "bad_url";
	if (url.protocol === "http:" && httpsOrLoopbackOnly && !isLoopbackHost(url.hostname)) {
		return "insecure";
	}
	return null;
}

async function readCapped(
	response: Response,
	maxBytes: number,
): Promise<{ text: string } | "too_large"> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) return "too_large";
	if (!response.body) return { text: "" };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			total += chunk.value.byteLength;
			if (total > maxBytes) return "too_large";
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return { text: new TextDecoder().decode(bytes) };
}

export async function fetchCapped(
	rawUrl: string,
	options: CappedFetchOptions,
): Promise<CappedFetchResult> {
	const { deadlineMs, maxBytes } = options;
	if (
		!Number.isFinite(deadlineMs) ||
		deadlineMs <= 0 ||
		!Number.isFinite(maxBytes) ||
		maxBytes < 0
	) {
		return { ok: false, code: "bad_options" };
	}
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { ok: false, code: "bad_url" };
	}
	const refused = refuseUrl(url, options.httpsOrLoopbackOnly !== false);
	if (refused) return { ok: false, code: refused };

	const deadline = AbortSignal.timeout(deadlineMs);
	try {
		const response = await fetch(url.href, {
			method: "GET",
			// "manual": a redirect arrives as a 3xx we refuse, never as a request to another origin.
			redirect: "manual",
			signal: deadline,
			// Bun's own 300 s idle timer is off, so `deadlineMs` is the only time limit.
			timeout: false,
		} as BunRequestInit);
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel().catch(() => {});
			return { ok: false, code: "redirect", status: response.status };
		}
		if (response.status < 200 || response.status >= 300) {
			await response.body?.cancel().catch(() => {});
			return { ok: false, code: "status", status: response.status };
		}
		const read = await readCapped(response, maxBytes);
		if (read === "too_large") return { ok: false, code: "too_large" };
		return { ok: true, status: response.status, body: read.text };
	} catch {
		return { ok: false, code: deadline.aborted ? "timeout" : "network" };
	}
}
