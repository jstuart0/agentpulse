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
 * Where each shows: a list row carries no managed session but does carry
 * `machine`, the one name the server files the session under (the supervisor's
 * host, else the reported one, else none), so the card, the Machine filter and
 * Group by Machine always agree. The detail view loads `managedSession` and
 * shows the supervisor host from it, which is the same name. They can differ
 * only where `machine` is absent: a push whose lookup failed, or an older
 * server, where the card falls back to the reported host until the next poll.
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

type HostSource = Pick<Session, "reportedHost" | "machine"> & {
	managedSession?: { hostName: string | null } | null;
};

function present(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

export function sessionHostLabel(session: HostSource): SessionHostLabel | null {
	const supervisorHost = present(session.managedSession?.hostName);
	if (supervisorHost) return supervisorLabel(supervisorHost);
	const reported = present(session.reportedHost);
	// A row the server listed or pushed carries the machine it files the session
	// under, which is what the Machine filter and grouping select on: the card
	// says exactly that, and says "reported" only when the reported name is it.
	if (session.machine !== undefined) {
		const machine = present(session.machine);
		if (machine === null) return null;
		return machine === reported ? reportedLabel(machine) : supervisorLabel(machine);
	}
	return reported ? reportedLabel(reported) : null;
}

function supervisorLabel(name: string): SessionHostLabel {
	return {
		source: "supervisor",
		name,
		text: `on ${name}`,
		fieldLabel: "Host",
		title: `Runs on ${name}, the machine whose AgentPulse supervisor launched it.`,
		srText: `Host: ${name}`,
	};
}

function reportedLabel(name: string): SessionHostLabel {
	return {
		source: "reported",
		name,
		text: `on ${name}`,
		fieldLabel: "Reported host",
		title: `Reported by the machine that sent this session's events (${name}); not verified.`,
		srText: `Reported machine: ${name}`,
	};
}
