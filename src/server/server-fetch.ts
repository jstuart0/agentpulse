import { app } from "./app.js";
import { WS_UPGRADE_PATHS, handleWsUpgradeRequest } from "./ws/ws-auth.js";

/**
 * The server's request handler, shared by Bun.serve and the tests that need the
 * real routing: a WebSocket upgrade goes through the origin and auth guard,
 * everything else through the app. `server` is the Bun server handle; Hono gets
 * it as `env` so that `getConnInfo(c)` (backed by `server.requestIP`) can
 * resolve the TCP peer address for rate limiting and IP logging.
 */
export async function handleServerRequest(req: Request, server: unknown): Promise<Response> {
	if (WS_UPGRADE_PATHS.has(new URL(req.url).pathname)) {
		return handleWsUpgradeRequest(
			req,
			server as Parameters<typeof handleWsUpgradeRequest>[1],
		) as Promise<Response>;
	}
	return app.fetch(req, { server });
}
