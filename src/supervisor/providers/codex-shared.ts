import type {
	LaunchRequest,
	ManagedSession,
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	Session,
} from "../../shared/types.js";
import type { RpcClient } from "./codex-rpc.js";

/** A follow-up prompt's turn, from the moment it is reported until its one end event is written. */
export type FollowUp = { turnId: string | null };

export type ManagedCodexRuntime = {
	sessionId: string;
	/** The launch the session was started by; state reports from this runtime name it. */
	launchRequestId: string;
	threadId: string;
	client: RpcClient | null;
	currentThreadTitle: string | null;
	protocolVersion: string | null;
	activeTurnId: string | null;
	/** True from construction until the launch's `turn/start` settles, and around a follow-up's `turn/start`. */
	turnStarting: boolean;
	/** A `turn/start` got no usable answer: the turn may exist, so nothing else is sent until Codex says so or the session stops. */
	turnUncertain: boolean;
	/** Moves each time a follow-up begins; an idle report from an earlier turn checks it hasn't. */
	turnGeneration: number;
	/** Set when a stop begins, before its interrupt; nothing new is sent after it. */
	stopping: boolean;
	/** The running follow-up, if any. Whoever takes it (reads and nulls it) writes its one end event. */
	followUp: FollowUp | null;
	/** The last turn Codex told us ended, so a late `turn/start` reply for it doesn't mark it active. */
	lastCompletedTurnId: string | null;
	intentionalClose: boolean;
	syncTitle: (title: string) => Promise<void>;
	/** Declines what is held, closes stdin, and escalates to the child's process group. Idempotent. */
	dispose: () => Promise<void>;
};

export type LaunchCallbacks = {
	reportState: (input: ManagedSessionStateInput) => Promise<{
		session: Session;
		managedSession: ManagedSession;
		/** What became of the report; "queued" means the server hasn't seen it yet and `session` is empty. */
		outcome?: "sent" | "queued" | "excluded" | "blocked";
	}>;
	/** Resolves to the report gate's outcome ("sent", "queued", "excluded", "blocked") when it came from the gate. */
	reportEvents: (events: ManagedSessionEventInput[]) => Promise<unknown>;
};

/** The report gate would not let the prompt's event out (an exclude rule covers the session), so nothing was sent. */
export class CodexPromptWithheld extends Error {
	constructor() {
		super("The prompt was withheld by the report gate.");
		this.name = "CodexPromptWithheld";
	}
}

export function buildPrompt(launch: LaunchRequest) {
	const sections = [];
	if (launch.baseInstructions.trim()) {
		sections.push(`Instructions:\n${launch.baseInstructions.trim()}`);
	}
	if (launch.taskPrompt.trim()) {
		sections.push(`Task:\n${launch.taskPrompt.trim()}`);
	}
	return sections.join("\n\n").trim() || "Continue working on this project.";
}

export function extractText(value: unknown): string {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";
	if (Array.isArray(value))
		return value
			.map((item) => extractText(item))
			.filter(Boolean)
			.join("");
	const record = value as Record<string, unknown>;
	if (typeof record.text === "string") return record.text;
	if (typeof record.delta === "string") return record.delta;
	if (record.content) return extractText(record.content);
	if (record.item) return extractText(record.item);
	if (record.review) return typeof record.review === "string" ? record.review : "";
	return "";
}
