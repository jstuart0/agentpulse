/**
 * F164: the Settings hint ("can't be used by a relay") must agree with what
 * the relay itself decides from /auth/me: the hint is shown exactly when the
 * relay would find the key missing Observe and nothing else.
 */
import { describe, expect, test } from "bun:test";
import { relayKeyHint } from "../src/web/lib/onboarding.ts";

// "?module": see check-installers.ts (the server text-imports relay.ts).
const { evaluateScopes } = await import("./relay.ts?module");

const SCOPE_SETS: string[][] = [
	[],
	["ingest"],
	["observe"],
	["manage"],
	["*"],
	["ingest", "observe"],
	["ingest", "manage"],
	["observe", "manage"],
	["ingest", "observe", "manage"],
	["ingest", "*"],
];

describe("relayKeyHint agrees with the relay's evaluateScopes", () => {
	for (const scopes of SCOPE_SETS) {
		test(JSON.stringify(scopes), () => {
			const relay = evaluateScopes({ authenticated: true, user: { scopes } });
			const relayWouldLackOnlyObserve =
				relay.missing.length === 1 && relay.missing[0] === "observe";
			expect(relayKeyHint(scopes)).toBe(relayWouldLackOnlyObserve);
		});
	}
});
