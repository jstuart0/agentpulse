import { Hono } from "hono";
import { getAuthUser, requireAuth } from "../auth/middleware.js";
import { config } from "../config.js";

/**
 * Tiny auth-introspection router so the UI can render "who am I" and
 * a sign-out affordance without having to decode Authentik headers
 * client-side.
 */
const authRouter = new Hono();

authRouter.get("/auth/me", requireAuth(), async (c) => {
	const user = await getAuthUser(c);
	if (!user) return c.json({ error: "Unauthorized" }, 401);
	// Authentik's outpost exposes a standard sign-out path at
	// /outpost.goauthentik.io/sign_out on the same host. We return it
	// here so the UI can show a Sign-out button for Authentik sessions
	// without hard-coding the path.
	const signOutUrl = user.source === "authentik" ? "/outpost.goauthentik.io/sign_out" : null;
	return c.json({
		user: {
			name: user.name,
			source: user.source,
			id: user.id ?? null,
		},
		signOutUrl,
		disableAuth: config.disableAuth,
	});
});

export { authRouter };
