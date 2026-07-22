import { describe, expect, test } from "bun:test";
/**
 * Live smoke test (AGEN-12 Phase 2, D3 seam 4). NOT run by default —
 * gated on AGENTPULSE_MCP_SMOKE=1. Spawns `bun bin/cli.ts mcp serve`
 * against a real running AgentPulse dev server via a real StdioClientTransport
 * subprocess. This is the one real (non-faked) path in this phase, and the
 * only way to confirm the SDK's stdio transport actually works under Bun.
 *
 * Usage:
 *   bun run dev:server   # in one terminal, with DISABLE_AUTH=true or a manage key
 *   AGENTPULSE_MCP_SMOKE=1 AGENTPULSE_URL=http://localhost:3000 \
 *     AGENTPULSE_API_KEY=<manage-scoped key, or omit under DISABLE_AUTH> \
 *     bun test src/mcp/smoke.test.ts
 */
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SMOKE_ENABLED = process.env.AGENTPULSE_MCP_SMOKE === "1";
const describeSmoke = SMOKE_ENABLED ? describe : describe.skip;
const REPO_ROOT = new URL("../..", import.meta.url).pathname;

describeSmoke("MCP live smoke (AGENTPULSE_MCP_SMOKE=1)", () => {
	const url = process.env.AGENTPULSE_URL ?? "http://localhost:3000";
	const apiKey = process.env.AGENTPULSE_API_KEY ?? "";

	test("stdio server lists tools and get_stats returns real numbers", async () => {
		const transport = new StdioClientTransport({
			command: "bun",
			args: ["bin/cli.ts", "mcp", "serve"],
			cwd: REPO_ROOT,
			env: {
				...(process.env as Record<string, string>),
				AGENTPULSE_URL: url,
				AGENTPULSE_API_KEY: apiKey,
			},
		});
		const client = new Client({ name: "smoke-test-client", version: "0.0.0" });

		try {
			await client.connect(transport);

			const { tools } = await client.listTools();
			expect(tools.length).toBeGreaterThan(0);
			expect(tools.map((t) => t.name)).toContain("get_stats");

			const result = await client.callTool({ name: "get_stats", arguments: {} });
			expect(result.isError).toBeFalsy();
			const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
			const stats = JSON.parse(text);
			expect(typeof stats.activeSessions).toBe("number");
			expect(typeof stats.totalSessionsToday).toBe("number");
		} finally {
			await client.close();
		}
	}, 20_000);

	test("an ingest-only key fails fast: nonzero exit, stderr has the mint hint, stdout is empty", async () => {
		// This scenario is only meaningful against an auth-ENABLED server: under
		// DISABLE_AUTH=true, getAuthUserFromHeaders() returns the synthetic
		// {scopes:["*"]} identity unconditionally (middleware.ts:63-64) before
		// it ever inspects the Authorization header, so an "ingest-only key"
		// spawned against a DISABLE_AUTH server would connect successfully and
		// never exit — hanging this test rather than failing it meaningfully.
		// Detect that mode via an unauthenticated /auth/me probe and skip with
		// an explicit note instead of asserting something the server can't
		// exercise (verified empirically: this is exactly what happened before
		// this guard was added).
		const probe = (await (await fetch(`${url}/api/v1/auth/me`)).json()) as {
			authenticated?: boolean;
			user?: { scopes?: string[] };
		};
		if (probe.authenticated && probe.user?.scopes?.includes("*")) {
			console.info(
				"[smoke] SKIP: server is running with DISABLE_AUTH=true — scope enforcement is bypassed, " +
					"so an ingest-only key cannot be meaningfully rejected here. Re-run against an auth-enabled " +
					"server with AGENTPULSE_API_KEY set to a manage-scoped key to exercise this path.",
			);
			return;
		}

		// Mint a throwaway ingest-only key using the manage-scoped smoke credential.
		const mintRes = await fetch(`${url}/api/v1/api-keys`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
			},
			body: JSON.stringify({ name: "mcp-smoke-ingest-only", scopes: ["ingest"] }),
		});
		if (!mintRes.ok) {
			throw new Error(
				`Smoke setup failed: could not mint an ingest-only key (${mintRes.status}). AGENTPULSE_API_KEY must be a manage-scoped key.`,
			);
		}
		const { key: ingestOnlyKey } = (await mintRes.json()) as { key: string };

		const child = spawn("bun", ["bin/cli.ts", "mcp", "serve"], {
			cwd: REPO_ROOT,
			env: { ...process.env, AGENTPULSE_URL: url, AGENTPULSE_API_KEY: ingestOnlyKey },
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		const exitCode = await new Promise<number>((resolve) => {
			child.on("exit", (code) => resolve(code ?? -1));
		});

		expect(exitCode).not.toBe(0);
		expect(stderr.toLowerCase()).toContain("scope");
		expect(stdout).toBe("");
	}, 20_000);
});
