import { Hono } from "hono";
import pkg from "../../../package.json" with { type: "json" };
import { SCOPE_INGEST, SCOPE_MANAGE, SCOPE_OBSERVE, SCOPE_RESPOND } from "../auth/api-key.js";
import { getAuthUser, requireAuth } from "../auth/middleware.js";
import { requireOperatorScope, resolveEffectiveRole } from "../auth/route-scope-policy.js";
import { config } from "../config.js";
import { isAiActive, isAiBuildEnabled, isVectorSearchActive } from "../services/ai/feature.js";
import { getDefaultProvider } from "../services/ai/providers-service.js";
import { getMode } from "../services/instance-mode.js";
import { type PushAvailability, pushAvailability } from "../services/push/push-runtime.js";

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
	/**
	 * Advertised only while this holds (the route is mounted either way). Absent means always. It is
	 * judged against one snapshot of the server's state, taken once per request, so a flag and the
	 * data that travels with it can never disagree.
	 */
	isAvailable?: (snapshot: CapabilitySnapshot) => boolean;
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
		name: "devices",
		proof: { kind: "route", method: "POST", path: "/devices" },
		value: true,
	},
	{
		name: "respondAck",
		proof: { kind: "route", method: "POST", path: "/sessions/:sessionId/acknowledge" },
		value: true,
	},
	{
		// An approved prompt is forwarded to the agent and its delivery state can be read.
		name: "hitlForwarding",
		proof: { kind: "route", method: "GET", path: "/ai/proposals/:id/delivery" },
		value: true,
	},
	{
		// A finished Ask reply the phone wasn't connected for is pushed as `ask_reply`.
		name: "askReplyPush",
		proof: { kind: "route", method: "POST", path: "/ai/ask/threads/:id/cancel" },
		value: true,
		pushEvents: ["ask_reply"],
	},
	{
		name: "inboxChanged",
		proof: { kind: "ws" },
		value: true,
	},
	{
		// A respond key may approve or decline (never write a prompt).
		name: "respondDecisions",
		proof: { kind: "route", method: "POST", path: "/ai/proposals/:id/decision" },
		value: true,
	},
	{
		// GET /sessions?view=card
		name: "sessionCardView",
		proof: { kind: "route", method: "GET", path: "/sessions" },
		value: true,
	},
	{
		// GET /sessions/:id?eventsLimit=&compact=&omit=
		name: "detailEventsLimit",
		proof: { kind: "route", method: "GET", path: "/sessions/:sessionId" },
		value: true,
	},
	{
		// GET /sessions/:id/timeline?beforeId=&compact=, and the same compact form on the event context
		name: "timelineKeyset",
		proof: { kind: "route", method: "GET", path: "/sessions/:sessionId/timeline" },
		value: true,
	},
	{
		// GET /sessions/stats carries completedToday, failedToday and launchesToday
		name: "statsToday",
		proof: { kind: "route", method: "GET", path: "/sessions/stats" },
		value: true,
	},
	{
		// Needs a configured relay and the instance secrets key; `push.relayOrigin` travels with it.
		name: "mobilePush",
		proof: { kind: "route", method: "POST", path: "/devices/:id/test" },
		value: true,
		isAvailable: (snapshot) => snapshot.push.available,
	},
];

/** What the availability checks may look at; read once per request. */
export interface CapabilitySnapshot {
	push: PushAvailability;
}

export function advertisedFeatures(snapshot: CapabilitySnapshot): readonly CapabilityFeature[] {
	return CAPABILITY_FEATURES.filter((f) => f.isAvailable?.(snapshot) ?? true);
}

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
	const snapshot: CapabilitySnapshot = { push: pushAvailability() };
	const push = snapshot.push;
	const features = advertisedFeatures(snapshot);

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
		features: Object.fromEntries(features.map((f) => [f.name, f.value])),
		// Present only with features.mobilePush, so a client that sees the flag always has the origin.
		...(push.available ? { push: { relayOrigin: push.relayOrigin } } : {}),
		pushEvents: [...new Set(features.flatMap((f) => f.pushEvents ?? []))],
	});
});

export { capabilitiesRouter };
