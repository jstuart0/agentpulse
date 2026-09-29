import { AGENT_METADATA } from "../../shared/constants.js";
import type { AgentType, Session } from "../../shared/types.js";

export type NameSource = "user" | "native" | "generated";

/**
 * D14: show the "pinned" indicator only when a manual rename is actually
 * overriding something — either an already-observed native name, or an
 * agent whose CLI is capable of reporting one (hasNameSource), even if it
 * hasn't reported yet. A "user" pin on an agent that can never report a
 * native name (hasNameSource: false) has nothing to protect against, so the
 * pin affordance stays hidden.
 */
export function shouldShowPin(
	nameSource: NameSource,
	nativeName: string | null,
	agentType: AgentType,
): boolean {
	if (nameSource !== "user") return false;
	// F101: an agent type this bundle doesn't know (newer server, legacy row)
	// is treated as unable to report a name.
	return nativeName !== null || (AGENT_METADATA[agentType]?.hasNameSource ?? false);
}

/**
 * D14: caption shown next to the session name in the UI.
 *  - "user": "Renamed by you", plus the agent's suggested name when it
 *    differs from the current displayName (nothing to show when they match
 *    or no native name has been observed yet).
 *  - "native": "from <shortLabel>" (muted, informational).
 *  - "generated": no caption.
 */
export function nameSourceCaption(
	nameSource: NameSource,
	nativeName: string | null,
	displayName: string,
	agentType: AgentType,
): string | null {
	const shortLabel = AGENT_METADATA[agentType]?.shortLabel ?? "agent";
	if (nameSource === "user") {
		if (nativeName !== null && nativeName !== displayName) {
			return `Renamed by you · agent name: "${nativeName}"`;
		}
		return "Renamed by you";
	}
	if (nameSource === "native") {
		return `from ${shortLabel}`;
	}
	return null;
}

/**
 * D26/F98/F199: the caption's tooltip. For a manual rename it says what the
 * rename protects against; otherwise the caption speaks for itself.
 *
 * F199: this tooltip replaced the caption's own text as the title, so when
 * the caption is truncated (`truncate max-w-[...]`) the agent's suggested
 * name it carries — `Renamed by you · agent name: "<nativeName>"` — became
 * unreadable until "Use agent name" was pressed. When nativeName differs
 * from the current displayName, the name is folded back in here.
 */
export function nameSourceTitle(
	nameSource: NameSource,
	nativeName: string | null,
	displayName: string,
	agentType: AgentType,
): string | null {
	if (nameSource !== "user") return null;
	const shortLabel = AGENT_METADATA[agentType]?.shortLabel ?? "the agent";
	const base = `You renamed this session, so names from ${shortLabel} won't replace it.`;
	if (nativeName !== null && nativeName !== displayName) {
		return `${base} Agent name: "${nativeName}"`;
	}
	return base;
}

export type ResetButtonState = "idle" | "pending" | "error";
export type ResetButtonAction = "start" | "success" | "error" | "reset";

/**
 * D14: small state machine for the "reset to native name" button —
 * idle -> pending (request in flight) -> error (request failed) -> idle
 * (retry), or pending -> idle on success.
 */
export function resetButtonState(
	_current: ResetButtonState,
	action: ResetButtonAction,
): ResetButtonState {
	switch (action) {
		case "start":
			return "pending";
		case "success":
			return "idle";
		case "error":
			return "error";
		case "reset":
			return "idle";
	}
}

/**
 * F95: the local patch after a dashboard rename. A manual rename always pins
 * (the server stamps renameSource="user"), so nameSource changes with the
 * name; nativeName is untouched.
 */
export function applyManualRename(session: Session, name: string): Session {
	return { ...session, displayName: name, nameSource: "user" };
}
