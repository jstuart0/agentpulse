import type {
	LaunchRequest,
	ManagedSession,
	ManagedSessionEventInput,
	ManagedSessionStateInput,
	Session,
} from "../../shared/types.js";
import type { RpcClient } from "./codex-rpc.js";

export type ManagedCodexRuntime = {
	sessionId: string;
	threadId: string;
	client: RpcClient | null;
	currentThreadTitle: string | null;
	protocolVersion: string | null;
	activeTurnId: string | null;
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
	reportEvents: (events: ManagedSessionEventInput[]) => Promise<unknown>;
};

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
