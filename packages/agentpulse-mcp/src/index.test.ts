/**
 * Tests for src/mcp/index.ts — serveStdio() (AGEN-12 Phase 4 catch-up,
 * tessa-H2 / Phase 2 mid-build reconciliation Finding H-2: "serveStdio()'s
 * CLI-entrypoint wiring ... has no automated coverage reachable under the
 * project's default DISABLE_AUTH=true local-dev mode — required closed
 * before Phase 4/5").
 *
 * Only the two fail-fast paths are exercised (missing AGENTPULSE_API_KEY;
 * discoverScopes() rejecting) — the success path calls
 * StdioServerTransport + server.connect(), which would hang this test
 * process waiting on stdio and isn't this finding's concern. Both paths are
 * reached by monkey-patching process.exit (to convert the exit into a
 * catchable throw instead of actually terminating the test runner),
 * process.stderr.write (to capture the diagnostic text without polluting
 * test output), and globalThis.fetch (so discoverScopes' /auth/me call
 * resolves to a controlled response) — no auth server needed.
 *
 * tessa L (Phase 4 mid-build review): every fail-fast path also asserts
 * process.stdout.write is never called — the stdio transport owns stdout
 * for the JSON-RPC protocol stream (log.ts's whole reason for existing);
 * a diagnostic message accidentally routed to stdout here would corrupt
 * that stream for a real client.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { serveStdio } from "./index.js";

class ProcessExitCalled extends Error {
	constructor(public code: number | undefined) {
		super(`process.exit(${code})`);
	}
}

describe("serveStdio — fail-fast paths (tessa-H2)", () => {
	const originalEnv = { ...process.env };
	let exitSpy: ReturnType<typeof spyOn>;
	let stderrSpy: ReturnType<typeof spyOn>;
	let stdoutSpy: ReturnType<typeof spyOn>;
	let fetchSpy: ReturnType<typeof spyOn> | undefined;

	beforeEach(() => {
		exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new ProcessExitCalled(code);
		}) as never);
		stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
		stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		exitSpy.mockRestore();
		stderrSpy.mockRestore();
		stdoutSpy.mockRestore();
		fetchSpy?.mockRestore();
		fetchSpy = undefined;
		process.env = { ...originalEnv };
	});

	function stderrText(): string {
		return stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
	}

	test("missing AGENTPULSE_API_KEY exits 1 with a mint hint on stderr, before any network call", async () => {
		process.env.AGENTPULSE_API_KEY = undefined;
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
			throw new Error("fetch should not be called when the API key is missing");
		}) as unknown as typeof fetch);

		await expect(serveStdio()).rejects.toBeInstanceOf(ProcessExitCalled);

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(stdoutSpy).not.toHaveBeenCalled();
		expect(stderrText()).toContain("AGENTPULSE_API_KEY");
		expect(stderrText().toLowerCase()).toContain("mcp install");
	});

	test("discoverScopes() rejecting (ingest-only key) exits 1, ScopeDiscoveryError message reaches stderr", async () => {
		process.env.AGENTPULSE_API_KEY = "ap_test_key";
		process.env.AGENTPULSE_URL = "http://localhost:3000";
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () =>
				new Response(
					JSON.stringify({
						authenticated: true,
						user: { name: "t", source: "api_key", id: "1", role: null, scopes: ["ingest"] },
						signOutUrl: null,
						disableAuth: false,
						allowSignup: false,
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				)) as unknown as typeof fetch,
		);

		await expect(serveStdio()).rejects.toBeInstanceOf(ProcessExitCalled);

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(stdoutSpy).not.toHaveBeenCalled();
		expect(stderrText().toLowerCase()).toContain("neither");
		expect(stderrText().toLowerCase()).toContain("mint");
	});

	test("authenticated:false (bad/missing key rejected by the server) exits 1", async () => {
		process.env.AGENTPULSE_API_KEY = "ap_bad_key";
		process.env.AGENTPULSE_URL = "http://localhost:3000";
		fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () =>
				new Response(JSON.stringify({ authenticated: false, user: null }), {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch,
		);

		await expect(serveStdio()).rejects.toBeInstanceOf(ProcessExitCalled);

		expect(exitSpy).toHaveBeenCalledWith(1);
		expect(stdoutSpy).not.toHaveBeenCalled();
		expect(stderrText()).toContain("AgentPulse rejected");
	});
});
