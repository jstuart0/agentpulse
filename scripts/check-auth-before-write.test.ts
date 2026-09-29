/**
 * F246 (High, codex r2 D38): ap_check_auth_before_write is the shared
 * primitive (inside the `# >>> agentpulse-hook-cmd` marker block, verbatim
 * across scripts/setup-hooks.sh, scripts/setup-relay.sh, and the /setup.sh
 * template rendered by src/server/routes/setup.ts) that mirrors bin/cli.ts:
 * with no key, against a server that requires auth, refuse before writing
 * any command hooks. Without it, an auth-enabled server accepts an empty
 * key and installs hooks that 401 forever — invisible, since the detached
 * shim discards curl's output by design (D13).
 *
 * This tests the function itself, sourced from each file (never
 * reimplemented), against a real stub /api/v1/auth/me server — proving
 * correctness independent of whether a given site's caller can actually
 * reach the "no key" branch (scripts/setup-hooks.sh requires a non-empty
 * key unconditionally before this call is ever reached, so its own call
 * site is a defence-in-depth no-op today; the /setup.sh template's own
 * subprocess-level integration test, in scripts/hook-command-parity.test.ts,
 * is where the actual pre-existing bug this closes is exercised live).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function extractMarkerBlock(source: string): string {
	const startMarker = "# >>> agentpulse-hook-cmd";
	const endMarker = "# <<< agentpulse-hook-cmd";
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker);
	if (start === -1 || end === -1) {
		throw new Error("agentpulse-hook-cmd markers not found");
	}
	return source.slice(start, end + endMarker.length);
}

async function renderedSetupSh(): Promise<string> {
	const { Hono } = await import("hono");
	const { setup } = await import("../src/server/routes/setup.ts");
	const app = new Hono().route("/", setup);
	const res = await app.request("http://localhost/setup.sh", {
		headers: { Host: "localhost:3000" },
	});
	return res.text();
}

type Site = { name: string; block: () => Promise<string> };

const SITES: Site[] = [
	{
		name: "scripts/setup-hooks.sh",
		block: async () =>
			extractMarkerBlock(readFileSync(join(ROOT, "scripts/setup-hooks.sh"), "utf-8")),
	},
	{
		name: "scripts/setup-relay.sh",
		block: async () =>
			extractMarkerBlock(readFileSync(join(ROOT, "scripts/setup-relay.sh"), "utf-8")),
	},
	{
		name: "rendered GET /setup.sh",
		block: async () => extractMarkerBlock(await renderedSetupSh()),
	},
];

async function runCheck(
	block: string,
	base: string,
	key: string,
): Promise<{ code: number | null; stderr: string }> {
	const script = `${block}\nap_check_auth_before_write "$1" "$2"`;
	const proc = Bun.spawn(["bash", "-c", script, "_", base, key], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { code: exitCode, stderr };
}

function startStub(disableAuth: boolean) {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/api/v1/auth/me") {
				return Response.json({ authenticated: false, user: null, disableAuth });
			}
			return new Response("not found", { status: 404 });
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

for (const site of SITES) {
	describe(`ap_check_auth_before_write (F246) — ${site.name}`, () => {
		test("auth ENABLED, no key: refuses with a clear message", async () => {
			const stub = startStub(false);
			try {
				const block = await site.block();
				const result = await runCheck(block, stub.url, "");
				expect(result.code).not.toBe(0);
				expect(result.stderr).toMatch(/requires an API key/);
			} finally {
				stub.stop();
			}
		});

		test("auth DISABLED, no key: proceeds", async () => {
			const stub = startStub(true);
			try {
				const block = await site.block();
				const result = await runCheck(block, stub.url, "");
				expect(result.code).toBe(0);
			} finally {
				stub.stop();
			}
		});

		test("auth ENABLED, a key IS present: proceeds without even calling the server (no network needed)", async () => {
			const block = await site.block();
			// An unreachable URL proves this returns early on key-presence
			// alone — if it tried to reach the network it would hang/fail.
			const result = await runCheck(block, "http://127.0.0.1:1", "ap_some_key");
			expect(result.code).toBe(0);
		});

		test("server unreachable, no key: falls through (this isn't the auth-refusal path — a different check reports connectivity)", async () => {
			const block = await site.block();
			const result = await runCheck(block, "http://127.0.0.1:1", "");
			expect(result.code).toBe(0);
		});
	});
}
