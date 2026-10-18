/**
 * What the server advertises when push is set up, in the shape the capabilities
 * contract fixes: `features.mobilePush: true` (a boolean like every feature) and
 * a top-level `push.relayOrigin`. Both are present together or neither is, so a
 * client that sees the feature always has the origin that goes with it.
 *
 * The capabilities route calls this once the device routes that prove the
 * feature exist; until then nothing advertises push.
 */
export interface PushCapability {
	features: { mobilePush: true };
	push: { relayOrigin: string };
}

/** The capability members for the relay URL `loadRelayUrl` returned, or null when push is not configured. */
export function pushCapability(relayUrl: string | null): PushCapability | null {
	if (!relayUrl) return null;
	const origin = new URL(relayUrl).origin;
	return { features: { mobilePush: true }, push: { relayOrigin: origin } };
}
