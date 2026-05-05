/**
 * Side-effect-free Hono application factory.
 *
 * This module exports a fully-configured Hono `app` with all routers mounted
 * and global middleware registered. It has NO side effects:
 *
 *   - Does NOT call Bun.serve
 *   - Does NOT call getDb() at import time
 *   - Does NOT start telemetry, transcripts, watchers, or any background jobs
 *   - Does NOT bind a port or open the DB
 *
 * All side-effecting boot steps live in index.ts, which imports this module
 * and then calls initializeDatabase(), starts services, and binds a port.
 *
 * Keeping app.ts pure enables:
 *   - Import-time route introspection (app.routes) without opening SQLite
 *   - Isolated integration tests that mount the app against an in-process server
 *   - A clean path for the Postgres backend epic (async adapter construction
 *     requires an explicit init call, not import-time side effects)
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { requireAuth } from "./auth/middleware.js";
import { config } from "./config.js";
import { securityHeaders } from "./middleware/security-headers.js";
import aiInboxRouter from "./routes/ai-inbox.js";
import aiIntelligenceRouter from "./routes/ai-intelligence.js";
import aiProvidersRouter from "./routes/ai-providers.js";
import aiStatusRouter from "./routes/ai-status.js";
import aiWatcherRouter from "./routes/ai-watcher.js";
import { askRouter } from "./routes/ask.js";
import { authRouter } from "./routes/auth.js";
import { channelsRouter, telegramWebhookRouter } from "./routes/channels.js";
import { cspReportRouter } from "./routes/csp-report.js";
import { health } from "./routes/health.js";
import { ingest } from "./routes/ingest.js";
import { internalRouter } from "./routes/internal.js";
import { labsRouter } from "./routes/labs.js";
import { launchesRouter } from "./routes/launches.js";
import { projectsRouter } from "./routes/projects.js";
import { searchRouter } from "./routes/search.js";
import { sessionsRouter } from "./routes/sessions.js";
import { settingsRouter } from "./routes/settings.js";
import { setup as setupRoute } from "./routes/setup.js";
import { supervisorsRouter } from "./routes/supervisors.js";
import { templatesRouter } from "./routes/templates.js";

export const app = new Hono();

// Global middleware
app.use("*", logger());
// Security headers on every response (S-H3). Applied globally so both API
// and static-file responses carry the headers. HSTS is harmless on HTTP
// (ignored by browsers) and covers the production TLS deployment.
app.use("*", securityHeaders());

// API routes
const api = new Hono();
api.route("/v1", health);
api.route("/v1", ingest);
api.route("/v1", sessionsRouter);
api.route("/v1", settingsRouter);
api.route("/v1", templatesRouter);
api.route("/v1", projectsRouter);
api.route("/v1", supervisorsRouter);
api.route("/v1", launchesRouter);
// AI control-plane: split from the monolithic ai.ts into 5 domain routers.
// A single requireAuth() gate wraps all AI sub-routers so the route snapshot
// (app.routes) shows one ALL /* entry for the AI domain — matching the
// pre-split shape where aiRouter had a single use("*", requireAuth()).
const aiRouter = new Hono();
aiRouter.use("*", requireAuth());
aiRouter.route("/", aiStatusRouter);
aiRouter.route("/", aiProvidersRouter);
aiRouter.route("/", aiWatcherRouter);
aiRouter.route("/", aiInboxRouter);
aiRouter.route("/", aiIntelligenceRouter);
api.route("/v1", aiRouter);
api.route("/v1", askRouter);
api.route("/v1", searchRouter);
api.route("/v1", labsRouter);
api.route("/v1", channelsRouter);

// Public Telegram webhook lives OUTSIDE the `api` bundle. Other routers
// in that bundle register `.use("*", requireAuth())`, and Hono merges
// those wildcard middlewares across the whole parent router — which
// means anything inside `api` can get shadowed by their auth guard.
// Mounting the webhook on the root app sidesteps that entirely.
app.route("/api/v1", telegramWebhookRouter);
app.route("/app-api/v1", telegramWebhookRouter);

// Auth router — lives OUTSIDE the `api` bundle for the same Hono
// wildcard-merge reason as telegramWebhookRouter and cspReportRouter.
// /auth/me, /auth/login, /auth/logout, /auth/signup must be reachable
// WITHOUT a session (the login page consumes them). The route handlers
// themselves apply requireAuth() per-route where needed (e.g.
// /auth/change-password); mounting the whole router on the root app
// prevents sibling routers' .use("*", requireAuth()) wildcards from
// 401'ing the public auth introspection endpoints.
app.route("/api/v1", authRouter);
app.route("/app-api/v1", authRouter);

// CSP report endpoint — unauthenticated by design (browsers send these
// without credentials). Mount on root app to bypass the api bundle's
// auth middleware. (S-H3)
app.route("/api/v1", cspReportRouter);

// Internal lifecycle endpoint — loopback-only, no auth key required.
// Must NOT be exposed via Traefik IngressRoute (enforced in P10).
// Mounted on root app to bypass the api bundle's auth middleware entirely.
app.route("/api/v1/internal", internalRouter);

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
