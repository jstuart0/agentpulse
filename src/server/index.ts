import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { logger } from "hono/logger";
import packageJson from "../../package.json" with { type: "json" };
import { ensureDefaultApiKey } from "./auth/api-key.js";
import { getAuthUserFromHeaders } from "./auth/middleware.js";
import { config } from "./config.js";
import { initializeDatabase } from "./db/client.js";
import { setShuttingDown } from "./drain-state.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { aiRouter } from "./routes/ai.js";
import { askRouter } from "./routes/ask.js";
import { authRouter } from "./routes/auth.js";
import { channelsRouter, handleTelegramUpdate, telegramWebhookRouter } from "./routes/channels.js";
import { cspReportRouter } from "./routes/csp-report.js";
import { health } from "./routes/health.js";
import { getInFlightCount } from "./routes/ingest-counters.js";
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
import { embedEvent, startBackfillIfNeeded } from "./services/ai/embeddings/embedding-service.js";
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
import { sessionBus } from "./services/notifier.js";
import { loadEager as loadProjectsEager } from "./services/projects/cache.js";
import {
	listProjects,
	resolveAllSessionsForProject,
} from "./services/projects/projects-service.js";
import { updateStaleSessions } from "./services/session-tracker.js";
import { startTelemetry } from "./services/telemetry.js";
import { startTranscriptSync } from "./services/transcript-sync.js";
import { handleWsClose, handleWsMessage, handleWsOpen, startHeartbeat } from "./ws/handler.js";

// ── Graceful drain state ──────────────────────────────────────────────────────
//
// State lives in drain-state.ts (separate module to avoid circular imports).
// The flag is set by:
//  1. POST /api/v1/internal/drain (k8s preStop hook — runs before SIGTERM).
//  2. SIGTERM/SIGINT handlers below (fallback for non-k8s shutdowns).
//
// Once true:
//  - GET /api/v1/ready returns 503 → Traefik stops routing new traffic.
//  - GET /api/v1/health still returns 200 → k8s liveness stays passing.
//  - In-flight hook events continue to drain (tracked in ingest-counters.ts).
//
// IMPORTANT: registering a SIGTERM/SIGINT handler suppresses Bun's default
// exit behaviour. The handlers must call process.exit() explicitly after the
// drain window expires, otherwise the process hangs until the OS sends SIGKILL
// (exhausting terminationGracePeriodSeconds in k8s, or leaving a zombie in
// local dev after Ctrl-C).

const MAX_DRAIN_MS = 30_000; // matches preStop curl budget

async function gracefulExit(reason: string, code = 0): Promise<never> {
	setShuttingDown(reason);
	const start = Date.now();
	while (getInFlightCount() > 0 && Date.now() - start < MAX_DRAIN_MS) {
		await new Promise((r) => setTimeout(r, 100));
	}
	// bunServer is assigned after Bun.serve() below; the reference is captured
	// by closure so the handlers can stop the server port before exiting.
	bunServer?.stop?.();
	process.exit(code);
}

// Fallback for non-k8s shutdowns; k8s flow uses the preStop endpoint first.
process.on("SIGTERM", () => void gracefulExit("sigterm"));
process.on("SIGINT", () => void gracefulExit("sigint"));

// ─────────────────────────────────────────────────────────────────────────────

// Fail fast if AI is enabled but the instance secrets key is missing or weak.
validateAiStartupConfig();

// Advisory: operators should configure the Authentik trust secret in production.
// Without it, any request that carries X-Authentik-Username (e.g. from a compromised
// sibling pod) bypasses the trust gate. NetworkPolicy from P10 narrows but does not
// eliminate this attack surface.
if (!config.authentikTrustSecret && !config.disableAuth) {
	console.warn(
		"[security] AGENTPULSE_AUTHENTIK_TRUST_SECRET is not set. The Authentik header trust gate is disabled. " +
			"Any request carrying X-Authentik-Username headers will be accepted without verification. " +
			"Set AGENTPULSE_AUTHENTIK_TRUST_SECRET to a shared secret (see deploy/k8s/AUTHENTIK-FORWARDAUTH.md).",
	);
}

// Initialize database
initializeDatabase();

// Eagerly populate the projects cache before hook ingestion routes are mounted
// so the first incoming event sees a warm cache with no DB round-trip.
await loadProjectsEager();

// One-shot backfill: stamp sessions that existed before projects were created.
(async () => {
	try {
		const allProjects = await listProjects();
		for (const project of allProjects) {
			await resolveAllSessionsForProject(project.id, project.cwd);
		}
	} catch (err) {
		console.warn("[projects] Boot backfill failed:", err);
	}
})();

// Create Hono app
const app = new Hono();

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

// Start server with WebSocket support
// Bun.serve handles both HTTP and WS on the same port.
// Assigned to `bunServer` so the SIGTERM/SIGINT handlers above can call
// server.stop() before process.exit(). The variable is declared with `let`
// and referenced by closure; hoisting ensures the handlers don't fire before
// this assignment completes (signals only arrive after the event loop is running).
// biome-ignore lint/style/useConst: assigned once, referenced by closure in signal handlers above
let bunServer: ReturnType<typeof Bun.serve> | undefined;
bunServer = Bun.serve({
	port: config.port,
	hostname: config.host,
	async fetch(req: Request, server: unknown) {
		const url = new URL(req.url);

		// Handle WebSocket upgrade
		if (url.pathname === "/api/v1/ws" || url.pathname === "/app-api/v1/ws") {
			// Strict Origin check — no NODE_ENV branching.
			// Allowed origins are derived from PUBLIC_URL (comma-separated).
			// Dev setups: set PUBLIC_URL=https://prod.example.com,http://localhost:5173
			const origin = req.headers.get("Origin");
			if (!origin || !config.allowedOrigins.includes(origin)) {
				return new Response("Forbidden", { status: 403 });
			}

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

		// Handle HTTP via Hono. Pass the Bun server handle as Hono's `env` so
		// that `getConnInfo(c)` (backed by `server.requestIP`) can resolve the
		// TCP peer address for rate limiting and IP logging.
		return app.fetch(req, { server });
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

// Vector search: kick off any backfill that's pending and wire ingest
// → fire-and-forget embed. Both no-op when AGENTPULSE_VECTOR_SEARCH is
// unset, so this is safe to call unconditionally.
void startBackfillIfNeeded();
sessionBus.on("session_event", ({ event }) => {
	if (event.id > 0) void embedEvent(event.id);
});
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
console.log(`  ║        AgentPulse v${packageJson.version}            ║`);
console.log("  ╠═══════════════════════════════════════════╣");
console.log(`  ║  Server:  http://${config.host}:${config.port}          ║`);
console.log("  ║  DB:      SQLite                       ║");
console.log(
	`  ║  Auth:    ${config.disableAuth ? "DISABLED" : "API Key + Authentik"}              ║`,
);
console.log(`  ║  WS:      ws://${config.host}:${config.port}/api/v1/ws   ║`);
console.log("  ╚═══════════════════════════════════════════╝");
console.log("");

// Boot log: show effective bind so operators can self-diagnose connectivity issues
// ("I can't reach my server") without reading docs. The default is 127.0.0.1;
// set HOST=0.0.0.0 (or use Docker, which sets it via ENV) to expose to LAN/network.
console.log(
	`[config] Binding to ${config.host}:${config.port}; set HOST=0.0.0.0 to expose to LAN/network.`,
);

// One-shot footgun warning. DISABLE_AUTH=true binds every mutation route
// (sessions, projects, templates, ai control plane) wide-open; combined
// with HOST=0.0.0.0 that means anyone on the network can mutate state.
// The HOST default is now 127.0.0.1 (safe for bare `bun run start`);
// the Dockerfile sets HOST=0.0.0.0 so containers still bind all interfaces.
// Warning fires when the operator has EXPLICITLY chosen the dangerous combo.
if (config.disableAuth && config.host === "0.0.0.0") {
	console.warn("  ============================================================");
	console.warn("  WARNING: AgentPulse is running with DISABLE_AUTH=true and HOST=0.0.0.0.");
	console.warn("  All mutation APIs are fully open on all interfaces.");
	console.warn("  If running via Docker, ensure you used:");
	console.warn("    -p 127.0.0.1:3000:3000  (NOT -p 3000:3000)");
	console.warn("  so the host port is not published on all network interfaces.");
	console.warn("  See README → Local deployment.");
	console.warn("  ============================================================");
	console.warn("");
}

// Non-blocking advisory: AGENTPULSE_ALLOW_SIGNUP=true is only meaningful on
// a fresh instance with zero users. Once users exist, the signup transaction
// guard prevents abuse, but leaving the flag set is a config smell.
// Fire-and-forget: this advisory is informational and must never delay startup.
(async () => {
	try {
		const { countActiveUsers } = await import("./services/local-auth-service.js");
		if (config.allowSignup && (await countActiveUsers()) > 0) {
			console.log(
				"[config] AGENTPULSE_ALLOW_SIGNUP=true is set but the instance already has users. Set AGENTPULSE_ALLOW_SIGNUP=false (or unset) to prevent first-run signup attempts on future restarts.",
			);
		}
	} catch {
		// DB might not be fully settled yet on first boot; skip silently.
	}
})();

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
