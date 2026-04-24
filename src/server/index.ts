import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { ensureDefaultApiKey } from "./auth/api-key.js";
import { getAuthUserFromHeaders } from "./auth/middleware.js";
import { config } from "./config.js";
import { initializeDatabase } from "./db/client.js";
import { aiRouter } from "./routes/ai.js";
import { askRouter } from "./routes/ask.js";
import { authRouter } from "./routes/auth.js";
import { channelsRouter, telegramWebhookRouter } from "./routes/channels.js";
import { handleTelegramUpdate } from "./routes/channels.js";
import { health } from "./routes/health.js";
import { ingest } from "./routes/ingest.js";
import { labsRouter } from "./routes/labs.js";
import { launchesRouter } from "./routes/launches.js";
import { searchRouter } from "./routes/search.js";
import { sessionsRouter } from "./routes/sessions.js";
import { settingsRouter } from "./routes/settings.js";
import { setup as setupRoute } from "./routes/setup.js";
import { supervisorsRouter } from "./routes/supervisors.js";
import { templatesRouter } from "./routes/templates.js";
import { validateAiStartupConfig } from "./services/ai/feature.js";
import { maybeStartWatcherRunner } from "./services/ai/runner.js";
import {
	getTelegramBotToken,
	getTelegramDeliveryMode,
	initTelegramCredentials,
} from "./services/channels/telegram-credentials.js";
import { startTelegramPolling } from "./services/channels/telegram-poller.js";
import { ensureBootstrapAdmin } from "./services/local-auth-bootstrap.js";
import { reapExpiredSessions } from "./services/local-auth-service.js";
import { updateStaleSessions } from "./services/session-tracker.js";
import { startTelemetry } from "./services/telemetry.js";
import { startTranscriptSync } from "./services/transcript-sync.js";
import { handleWsClose, handleWsMessage, handleWsOpen, startHeartbeat } from "./ws/handler.js";

// Fail fast if AI is enabled but the instance secrets key is missing or weak.
validateAiStartupConfig();

// Initialize database
initializeDatabase();

// Create Hono app
const app = new Hono();

// Global middleware
app.use("*", logger());

// API routes
const api = new Hono();
api.route("/v1", health);
api.route("/v1", ingest);
api.route("/v1", sessionsRouter);
api.route("/v1", settingsRouter);
api.route("/v1", templatesRouter);
api.route("/v1", supervisorsRouter);
api.route("/v1", launchesRouter);
api.route("/v1", aiRouter);
api.route("/v1", askRouter);
api.route("/v1", searchRouter);
api.route("/v1", labsRouter);
api.route("/v1", channelsRouter);
api.route("/v1", authRouter);

// Public Telegram webhook lives OUTSIDE the `api` bundle. Other routers
// in that bundle register `.use("*", requireAuth())`, and Hono merges
// those wildcard middlewares across the whole parent router — which
// means anything inside `api` can get shadowed by their auth guard.
// Mounting the webhook on the root app sidesteps that entirely.
app.route("/api/v1", telegramWebhookRouter);
app.route("/app-api/v1", telegramWebhookRouter);

app.route("/api", api);
app.route("/app-api", api);

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
const _server = Bun.serve({
	port: config.port,
	hostname: config.host,
	async fetch(req: Request, server: unknown) {
		const url = new URL(req.url);

		// Handle WebSocket upgrade
		if (url.pathname === "/api/v1/ws" || url.pathname === "/app-api/v1/ws") {
			const authUser = config.disableAuth
				? { source: "api_key", name: "anonymous", id: "anonymous" }
				: await getAuthUserFromHeaders(req.headers);
			if (!authUser) {
				return new Response("Unauthorized", { status: 401 });
			}
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
startTranscriptSync();
void maybeStartWatcherRunner();
void ensureBootstrapAdmin();
// Warm the Telegram credential cache so getTelegramBotToken() /
// getTelegramWebhookSecret() return the DB-stored value (not the env
// fallback) the moment a request lands. Non-blocking; if the DB is
// unreachable on boot the fallback kicks in and we retry lazily.
void initTelegramCredentials()
	.then(async () => {
		// Auto-resume polling if that's the persisted delivery mode. In
		// webhook mode Telegram will push on its own so nothing to do here.
		if (getTelegramBotToken() && getTelegramDeliveryMode() === "polling") {
			await startTelegramPolling(handleTelegramUpdate);
		}
	})
	.catch((err) => {
		console.error("[telegram-credentials] warmup failed:", err);
	});
setInterval(
	() => {
		void reapExpiredSessions().catch(() => {
			// ignore transient errors; the next tick will retry
		});
	},
	60 * 60 * 1000,
);

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
console.log("  ║        AgentPulse v0.2.0-pre.1            ║");
console.log("  ╠═══════════════════════════════════════════╣");
console.log(`  ║  Server:  http://${config.host}:${config.port}          ║`);
console.log(`  ║  DB:      ${config.useSqlite ? "SQLite" : "PostgreSQL"}                       ║`);
console.log(
	`  ║  Auth:    ${config.disableAuth ? "DISABLED" : "API Key + Authentik"}              ║`,
);
console.log(`  ║  WS:      ws://${config.host}:${config.port}/api/v1/ws   ║`);
console.log("  ╚═══════════════════════════════════════════╝");
console.log("");
if (defaultKey) {
	if (config.isProduction) {
		console.log("  Default API key created.");
		console.log("     Retrieve it from the database or create a replacement in Settings.");
		console.log("");
	} else {
		console.log(`  Default API Key: ${defaultKey}`);
		console.log("     Add this to your shell profile:");
		console.log(`     export AGENTPULSE_API_KEY="${defaultKey}"`);
		console.log("");
	}
}
