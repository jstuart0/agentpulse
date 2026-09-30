/**
 * F246 (High, codex r2 D38, tightened by xander's D39 re-verify):
 * ap_check_auth_before_write is the shared primitive (inside the
 * `# >>> agentpulse-hook-cmd` marker block, verbatim across
 * scripts/setup-hooks.sh, scripts/setup-relay.sh, and the /setup.sh
 * template rendered by src/server/routes/setup.ts) that mirrors bin/cli.ts:
 * with no key, against a server that requires auth, refuse before writing
 * any command hooks.
 *
 * D39: the original version failed OPEN — an unreachable server, a
 * non-JSON response (an HTML error page from a proxy), or JSON missing
 * `disableAuth` all fell through to "proceed," meaning the silent-401
 * install this exists to prevent could still happen after a network blip.
 * New rule: a supplied key always skips the probe; with no key, proceed
 * ONLY on an explicit `disableAuth: true`; everything else refuses, with a
 * message pointing at a way to bypass the check for installing before the
 * server is up (the message stays generic across all three call sites,
 * since only setup-hooks.sh/setup.ts's own installers actually expose a
 * --no-auth-check flag — scripts/setup-relay.sh never calls this function
 * at all; it keeps the shared implementation only for marker-block
 * byte-parity with the other two).
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
// D40 (F251): config.ts is a frozen-at-first-import singleton shared across
// the whole `bun test` process — this file dynamically imports
// src/server/routes/setup.ts (which statically imports config.js) via
// renderedSetupSh() below, so __test_db.js's env defaults must land first.
import "../src/server/db/__test_db.js";

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
	noAuthCheck = "",
): Promise<{ code: number | null; stderr: string }> {
	const script = `${block}\nap_check_auth_before_write "$1" "$2" "$3"`;
	const proc = Bun.spawn(["bash", "-c", script, "_", base, key, noAuthCheck], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { code: exitCode, stderr };
}

function startStub(handler: (req: Request) => Response) {
	const server = Bun.serve({ port: 0, fetch: handler });
	return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function jsonStub(body: unknown) {
	return startStub((req) => {
		const url = new URL(req.url);
		if (url.pathname === "/api/v1/auth/me") return Response.json(body as object);
		return new Response("not found", { status: 404 });
	});
}

for (const site of SITES) {
	describe(`ap_check_auth_before_write (F246/D39) — ${site.name}`, () => {
		test("auth ENABLED (disableAuth: false), no key: refuses with a clear message pointing at the bypass", async () => {
			const stub = jsonStub({ authenticated: false, user: null, disableAuth: false });
			try {
				const block = await site.block();
				const result = await runCheck(block, stub.url, "");
				expect(result.code).not.toBe(0);
				expect(result.stderr).toMatch(/requires an API key/);
				expect(result.stderr).toMatch(/bypass this check/);
			} finally {
				stub.stop();
			}
		});

		test("auth DISABLED (disableAuth: true), no key: proceeds", async () => {
			const stub = jsonStub({ authenticated: false, user: null, disableAuth: true });
			try {
				const block = await site.block();
				const result = await runCheck(block, stub.url, "");
				expect(result.code).toBe(0);
			} finally {
				stub.stop();
			}
		});

		test("a key IS present: proceeds without even calling the server (no network needed)", async () => {
			const block = await site.block();
			// An unreachable URL proves this returns early on key-presence
			// alone — if it tried to reach the network it would hang/fail.
			const result = await runCheck(block, "http://127.0.0.1:1", "ap_some_key");
			expect(result.code).toBe(0);
		});

		test("D39: --no-auth-check proceeds regardless of key or server reachability", async () => {
			const block = await site.block();
			const result = await runCheck(block, "http://127.0.0.1:1", "", "1");
			expect(result.code).toBe(0);
		});

		test("D39: server unreachable, no key, no --no-auth-check: refuses (was: fell through and proceeded)", async () => {
			const block = await site.block();
			const result = await runCheck(block, "http://127.0.0.1:1", "");
			expect(result.code).not.toBe(0);
			expect(result.stderr).toMatch(/requires an API key/);
			expect(result.stderr).toMatch(/bypass this check/);
		});

		test("D39: an HTML error page (non-JSON response) from a proxy, no key: refuses", async () => {
			const stub = startStub((req) => {
				const url = new URL(req.url);
				if (url.pathname === "/api/v1/auth/me") {
					return new Response("<html><body>502 Bad Gateway</body></html>", {
						status: 502,
						headers: { "Content-Type": "text/html" },
					});
				}
				return new Response("not found", { status: 404 });
			});
			try {
				const block = await site.block();
				const result = await runCheck(block, stub.url, "");
				expect(result.code).not.toBe(0);
				expect(result.stderr).toMatch(/requires an API key/);
			} finally {
				stub.stop();
			}
		});

		test("D39: valid JSON with no disableAuth field at all, no key: refuses", async () => {
			const stub = jsonStub({ authenticated: false, user: null });
			try {
				const block = await site.block();
				const result = await runCheck(block, stub.url, "");
				expect(result.code).not.toBe(0);
				expect(result.stderr).toMatch(/requires an API key/);
			} finally {
				stub.stop();
			}
		});
	});
}
