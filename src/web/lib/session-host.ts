/**
 * Which machine a session is running on, for the dashboard.
 *
 * Two sources, in order of trust. A supervisor-launched session has a host the
 * supervisor registered (`managedSession.hostName`, loaded on the detail view
 * only). Any other session may carry `reportedHost`, the name its relay or the
 * Codex observer sent: self-declared and unauthenticated, so it is labelled as
 * reported and used for display only. Never feed it into a permission, routing
 * or ownership decision.
 *
 * Where each shows: the dashboard card only has the list row, which carries no
 * managed session, so a managed session's card shows its reported host (if any);
 * its detail view loads `managedSession` and shows the supervisor host instead.
 * The two can differ.
 */
import type { Session } from "../../shared/types.js";

export interface SessionHostLabel {
	source: "supervisor" | "reported";
	name: string;
	/** The short chip text. */
	text: string;
	/** The Overview field's label. */
	fieldLabel: "Host" | "Reported host";
	/** The mouse tooltip. */
	title: string;
	/** What a screen reader says in place of the visual chip. */
	srText: string;
}

type HostSource = Pick<Session, "reportedHost"> & {
	managedSession?: { hostName: string | null } | null;
};

function present(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

export function sessionHostLabel(session: HostSource): SessionHostLabel | null {
	const supervisorHost = present(session.managedSession?.hostName);
	if (supervisorHost) {
		return {
			source: "supervisor",
			name: supervisorHost,
			text: `on ${supervisorHost}`,
			fieldLabel: "Host",
			title: `Runs on ${supervisorHost}, the machine whose AgentPulse supervisor launched it.`,
			srText: `Host: ${supervisorHost}`,
		};
	}
	const reported = present(session.reportedHost);
	if (reported) {
		return {
			source: "reported",
			name: reported,
			text: `on ${reported}`,
			fieldLabel: "Reported host",
			title: `Reported by the machine that sent this session's events (${reported}); not verified.`,
			srText: `Reported machine: ${reported}`,
		};
	}
	return null;
}
