import { Hono } from "hono";
import pkg from "../../../package.json" with { type: "json" };
import { SCOPE_INGEST, SCOPE_MANAGE, SCOPE_OBSERVE, SCOPE_RESPOND } from "../auth/api-key.js";
import { getAuthUser, requireAuth } from "../auth/middleware.js";
import { requireOperatorScope, resolveEffectiveRole } from "../auth/route-scope-policy.js";
import { config } from "../config.js";
import { isAiActive, isAiBuildEnabled, isVectorSearchActive } from "../services/ai/feature.js";
import { getDefaultProvider } from "../services/ai/providers-service.js";
import { getMode } from "../services/instance-mode.js";

/** Bumped when a client-visible contract changes incompatibly; clients gate on it before the feature flags. */
export const CAPABILITIES_API_LEVEL = 1;

/** What makes a feature true: a mounted HTTP route, or the WebSocket upgrade path. */
export type CapabilityProof = { kind: "route"; method: string; path: string } | { kind: "ws" };

export interface CapabilityFeature {
	/** Key under `features` in the response. */
	name: string;
	/** What proves the feature exists; capabilities.test.ts checks each is mounted. */
	proof: CapabilityProof;
	/** The advertised value; `true` unless the feature carries a parameter. */
	value: true | Record<string, unknown>;
	/** Push event names this feature makes the server able to send. */
	pushEvents?: readonly string[];
}

/**
 * Every capability the server advertises, each added by the phase that mounts
 * its route. A flag with no mounted route behind it is a lie a client would
 * act on, so the proof is part of the entry.
 */
export const CAPABILITY_FEATURES: readonly CapabilityFeature[] = [
	{ name: "wsNativeAuth", proof: { kind: "ws" }, value: true },
	{ name: "wsMobileProfile", proof: { kind: "ws" }, value: true },
	{
		name: "pairing",
		proof: { kind: "route", method: "POST", path: "/pairing-codes" },
		value: true,
	},
	{
		name: "respondAck",
		proof: { kind: "route", method: "POST", path: "/sessions/:sessionId/acknowledge" },
		value: true,
	},
];

const capabilitiesRouter = new Hono();
capabilitiesRouter.use("*", requireAuth());
capabilitiesRouter.use("*", requireOperatorScope());

// GET /api/v1/capabilities - what this server can do and who is asking. Read by
// native clients on connect, before they decide which screens to offer. Observe
// keys can read it, so it carries booleans and labels only: no labs flags, no
// provider name, model or URL (only the provider kind), no key material.
capabilitiesRouter.get("/capabilities", async (c) => {
	const authUser = await getAuthUser(c);
	const mode = await getMode();
	const aiBuild = isAiBuildEnabled();
	const provider = aiBuild ? await getDefaultProvider() : null;

	return c.json({
		apiLevel: CAPABILITIES_API_LEVEL,
		version: pkg.version,
		mode,
		auth: {
			required: !config.disableAuth,
			scopes: [SCOPE_INGEST, SCOPE_MANAGE, SCOPE_OBSERVE, SCOPE_RESPOND],
		},
		caller: authUser
			? {
					source: authUser.source,
					userId: authUser.userId,
					role: authUser.role ?? null,
					effectiveRole: await resolveEffectiveRole(authUser, mode),
					scopes: authUser.scopes ?? null,
				}
			: null,
		ai: {
			build: aiBuild,
			active: await isAiActive(),
			provider: provider?.kind ?? null,
			vectorSearch: await isVectorSearchActive(),
		},
		features: Object.fromEntries(CAPABILITY_FEATURES.map((f) => [f.name, f.value])),
		pushEvents: [...new Set(CAPABILITY_FEATURES.flatMap((f) => f.pushEvents ?? []))],
	});
});

export { capabilitiesRouter };
