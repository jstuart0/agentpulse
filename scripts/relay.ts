#!/usr/bin/env bun

/**
 * AgentPulse Local Relay
 *
 * Claude Code and Codex block HTTP hooks to remote/private IPs.
 * This tiny relay listens on localhost and forwards everything to
 * your remote AgentPulse server.
 *
 * Usage:
 *   bun scripts/relay.ts https://agentpulse.xmojo.net
 *   bun scripts/relay.ts https://agentpulse.xmojo.net --port 4000 --key ap_xxx
 */

const args = process.argv.slice(2);
let remoteUrl = "";
let port = 4000;
let apiKey = "";

for (let i = 0; i < args.length; i++) {
	if (args[i] === "--port" && args[i + 1]) {
		port = Number(args[++i]);
	} else if (args[i] === "--key" && args[i + 1]) {
		apiKey = args[++i];
	} else if (!args[i].startsWith("--")) {
		remoteUrl = args[i].replace(/\/$/, "");
	}
}

if (!remoteUrl) {
	console.error("Usage: bun scripts/relay.ts <remote-url> [--port 4000] [--key ap_xxx]");
	console.error("Example: bun scripts/relay.ts https://agentpulse.xmojo.net --key ap_xxx");
	process.exit(1);
}

const server = Bun.serve({
	port,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);

		// Health check
		if (url.pathname === "/api/v1/health") {
			return new Response(JSON.stringify({ status: "ok", relay: true, remote: remoteUrl }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Forward everything under /api/ to the remote server
		if (url.pathname.startsWith("/api/")) {
			try {
				const headers = new Headers();
				headers.set("Content-Type", req.headers.get("Content-Type") || "application/json");
				if (apiKey) {
					headers.set("Authorization", `Bearer ${apiKey}`);
				}
				// Pass through agent type header
				const agentType = req.headers.get("X-Agent-Type");
				if (agentType) headers.set("X-Agent-Type", agentType);

				const body = req.method !== "GET" ? await req.text() : undefined;

				const res = await fetch(`${remoteUrl}${url.pathname}${url.search}`, {
					method: req.method,
					headers,
					body,
					signal: AbortSignal.timeout(10000),
				});

				const responseBody = await res.text();
				return new Response(responseBody, {
					status: res.status,
					headers: { "Content-Type": res.headers.get("Content-Type") || "application/json" },
				});
			} catch (err) {
				console.error(`[relay] Failed to forward ${url.pathname}:`, err);
				// Always return 200 for hook endpoints so we don't block the agent
				if (url.pathname.includes("/hooks")) {
					return new Response(JSON.stringify({ ok: true, relayed: false }), {
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response(JSON.stringify({ error: "Relay failed" }), {
					status: 502,
					headers: { "Content-Type": "application/json" },
				});
			}
		}

		// For non-API routes (dashboard), redirect to remote
		return Response.redirect(remoteUrl + url.pathname, 302);
	},
});

console.log("");
console.log(`  AgentPulse Relay`);
console.log(`  ────────────────`);
console.log(`  Local:  http://localhost:${port}`);
console.log(`  Remote: ${remoteUrl}`);
console.log(`  Auth:   ${apiKey ? "API key" : "none"}`);
console.log("");
console.log(`  Hooks on localhost:${port} → forwarded to ${remoteUrl}`);
console.log(`  Dashboard: open ${remoteUrl} in your browser`);
console.log("");
