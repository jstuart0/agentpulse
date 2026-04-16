import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "./config.js";
import { initializeDatabase } from "./db/client.js";
import { ensureDefaultApiKey } from "./auth/api-key.js";
import { health } from "./routes/health.js";
import { ingest } from "./routes/ingest.js";
import { sessionsRouter } from "./routes/sessions.js";
import { settingsRouter } from "./routes/settings.js";
import { setup as setupRoute } from "./routes/setup.js";
import {
	handleWsOpen,
	handleWsMessage,
	handleWsClose,
	startHeartbeat,
} from "./ws/handler.js";
import { updateStaleSessions } from "./services/session-tracker.js";
import { startTelemetry } from "./services/telemetry.js";
import { existsSync } from "fs";
import { join } from "path";

// Initialize database
initializeDatabase();

// Create Hono app
const app = new Hono();

// Global middleware
app.use("*", cors());
app.use("*", logger());

// API routes
const api = new Hono();
api.route("/v1", health);
api.route("/v1", ingest);
api.route("/v1", sessionsRouter);
api.route("/v1", settingsRouter);

app.route("/api", api);

// Setup script endpoint (outside /api so it's at /setup.sh)
app.route("/", setupRoute);

// Serve static frontend in production
if (config.isProduction) {
	const staticDir = join(import.meta.dir, "../../dist/web");

	const MIME_TYPES: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".js": "application/javascript; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".json": "application/json",
		".svg": "image/svg+xml",
		".png": "image/png",
		".ico": "image/x-icon",
		".woff": "font/woff",
		".woff2": "font/woff2",
	};

	function getMimeType(path: string): string {
		const ext = path.slice(path.lastIndexOf("."));
		return MIME_TYPES[ext] || "application/octet-stream";
	}

	if (existsSync(staticDir)) {
		app.get("*", async (c) => {
			const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
			const filePath = join(staticDir, reqPath);
			const file = Bun.file(filePath);
			if (await file.exists()) {
				return new Response(file, {
					headers: { "Content-Type": getMimeType(filePath) },
				});
			}
			// SPA fallback - serve index.html for client-side routing
			return new Response(Bun.file(join(staticDir, "index.html")), {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		});
	}
}

// Start server with WebSocket support
// Bun.serve handles both HTTP and WS on the same port
const server = Bun.serve({
	port: config.port,
	hostname: config.host,
	fetch(req: Request, server: unknown) {
		const url = new URL(req.url);

		// Handle WebSocket upgrade
		if (url.pathname === "/api/v1/ws") {
			const s = server as { upgrade(req: Request): boolean };
			const upgraded = s.upgrade(req);
			if (upgraded) return undefined as unknown as Response;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}

		// Handle HTTP via Hono
		return app.fetch(req);
	},
	websocket: {
		open: handleWsOpen,
		message: handleWsMessage,
		close: handleWsClose,
	},
});

// Start heartbeat for WebSocket connections
startHeartbeat();

// Start anonymous telemetry (opt-out with AGENTPULSE_TELEMETRY=off)
startTelemetry();

// Periodically check for stale sessions (every 60 seconds)
setInterval(async () => {
	try {
		const ended = await updateStaleSessions();
		if (ended > 0) {
			console.log(`[tracker] Marked ${ended} stale sessions as completed`);
		}
	} catch (err) {
		console.error("[tracker] Error updating stale sessions:", err);
	}
}, 60_000);

// Ensure at least one API key exists
const defaultKey = await ensureDefaultApiKey();

console.log("");
console.log("  ╔═══════════════════════════════════════════╗");
console.log("  ║           AgentPulse v0.1.0               ║");
console.log("  ╠═══════════════════════════════════════════╣");
console.log(`  ║  Server:  http://${config.host}:${config.port}          ║`);
console.log(`  ║  DB:      ${config.useSqlite ? "SQLite" : "PostgreSQL"}                       ║`);
console.log(`  ║  Auth:    ${config.disableAuth ? "DISABLED" : "API Key + Authentik"}              ║`);
console.log(`  ║  WS:      ws://${config.host}:${config.port}/api/v1/ws   ║`);
console.log("  ╚═══════════════════════════════════════════╝");
console.log("");
if (defaultKey) {
	console.log(`  Default API Key: ${defaultKey}`);
	console.log("     Add this to your shell profile:");
	console.log(`     export AGENTPULSE_API_KEY="${defaultKey}"`);
	console.log("");
}
