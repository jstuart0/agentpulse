/** The pure parts of "Pair a phone": what the QR carries, the countdown, and which view the panel is in. */

export type PairingAccess = "full" | "respond";

export interface PairingAccessOption {
	value: PairingAccess;
	label: string;
	hint: string;
}

export const PAIRING_ACCESS_OPTIONS: readonly PairingAccessOption[] = [
	{
		value: "respond",
		label: "Respond only",
		hint: "See sessions, mark them as seen and get live updates. Can't launch, stop or change anything.",
	},
	{
		value: "full",
		label: "Full access",
		hint: "Everything you can do here: launch, stop, prompt, manage keys and settings.",
	},
];

/** What the phone scans. Carries the server's origin and the single-use code; it is a QR only, never a link on the page. */
export function pairingUri(origin: string, code: string): string {
	return `agentpulse://pair?v=1&u=${encodeURIComponent(origin)}&c=${encodeURIComponent(code)}`;
}

/** m:ss until `expiresAt`, never negative. */
export function countdownText(expiresAt: string, nowMs: number): string {
	const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - nowMs) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export type PairingView = "idle" | "pending" | "redeemed" | "expired";

export interface PairingServerStatus {
	state: "pending" | "redeemed" | "expired";
	expiresAt: string;
	redeemedDeviceName: string | null;
	redeemedKeyId: string | null;
}

/**
 * Which view to show for a code the panel made. The server's word wins
 * (redeemed beats the clock), and the clock ends a pending code on this side
 * too so a stale poll can't leave a dead QR on screen.
 */
export function pairingView(
	made: { expiresAt: string } | null,
	status: PairingServerStatus | null,
	nowMs: number,
): PairingView {
	if (!made) return "idle";
	if (status?.state === "redeemed") return "redeemed";
	if (status?.state === "expired" || Date.parse(made.expiresAt) <= nowMs) return "expired";
	return "pending";
}

/** The code (and so the QR drawn from it) is held only while the pairing is pending; redeemed, expired, cancelled or hidden drops it. */
export function heldCode(
	made: { code: string | null } | null,
	view: PairingView,
	tabHidden: boolean,
): string | null {
	if (!made || view !== "pending" || tabHidden) return null;
	return made.code;
}

/** The key to revoke for a redeemed code, or null when there is nothing to revoke (so Revoke does nothing). */
export function revokeTarget(status: PairingServerStatus | null): string | null {
	return status?.state === "redeemed" ? (status.redeemedKeyId ?? null) : null;
}

export type RevokeState =
	| { step: "idle" }
	| { step: "confirming" }
	| { step: "revoking" }
	| { step: "revoked" }
	| { step: "error"; message: string };

export type RevokeEvent =
	| { type: "ask" }
	| { type: "cancel" }
	| { type: "reset" }
	| { type: "submit" }
	| { type: "succeeded" }
	| { type: "failed"; message: string };

/**
 * Revoking a phone is two steps, so one click can't do it: ask, then confirm. Only
 * a confirmed request is sent; its outcome ends in revoked or an error that can be
 * asked again. Events that don't fit the step are ignored.
 */
export function revokeReducer(state: RevokeState, event: RevokeEvent): RevokeState {
	switch (event.type) {
		case "ask":
			return state.step === "idle" || state.step === "error" ? { step: "confirming" } : state;
		case "reset":
			return { step: "idle" };
		case "cancel":
			return state.step === "confirming" || state.step === "error" ? { step: "idle" } : state;
		case "submit":
			return state.step === "confirming" ? { step: "revoking" } : state;
		case "succeeded":
			return state.step === "revoking" ? { step: "revoked" } : state;
		case "failed":
			return state.step === "revoking" ? { step: "error", message: event.message } : state;
	}
}
