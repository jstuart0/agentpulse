import type {
	SessionSummaryRefusalBody,
	SessionSummaryStartBody,
	SessionSummaryView,
} from "../../shared/session-summary-view.js";
/**
 * AGEN-69 phase 5: the session summary service. STUB (red commit): signatures only.
 */
import type { Actor } from "../auth/actor.js";

export interface SummaryRequestCaller {
	/** Who is asking: a user id or a key id, as a string. Used only for the team-mode one-at-a-time rule. */
	subject: string;
	teamMode: boolean;
	actor: Actor;
}

export type SummaryRequestResult =
	| { kind: "started"; body: SessionSummaryStartBody; done: Promise<void> }
	| { kind: "joined"; body: SessionSummaryStartBody }
	| { kind: "refused"; refusal: SessionSummaryRefusalBody };

export async function getSessionSummaryView(
	_sessionId: string,
): Promise<SessionSummaryView | null> {
	throw new Error("not implemented");
}

export async function requestSummaryGeneration(
	_sessionId: string,
	_caller: SummaryRequestCaller,
): Promise<SummaryRequestResult> {
	throw new Error("not implemented");
}

export async function releaseOwnSummaryClaims(): Promise<void> {
	throw new Error("not implemented");
}
