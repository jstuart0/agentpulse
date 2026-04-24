import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CODEX_SESSIONS_ROOT = join(homedir(), ".codex", "sessions");
const STATE_FILE = join(homedir(), ".agentpulse", "codex-observer-state.json");
const SCAN_INTERVAL_MS = 5_000;
// Default: only today's rollouts (UTC). Set AGENTPULSE_CODEX_BACKFILL_DAYS
// to 1+ to include older days at first scan. A large backfill against a
// cold dashboard can emit thousands of events in a burst, so it's opt-in.
const BACKFILL_DAYS = Math.max(
	0,
	Number.parseInt(process.env.AGENTPULSE_CODEX_BACKFILL_DAYS ?? "0", 10) || 0,
);

type FileState = { offset: number; sessionId: string };
type ObserverState = { files: Record<string, FileState> };

function loadState(): ObserverState {
	try {
		if (!existsSync(STATE_FILE)) return { files: {} };
		const raw = readFileSync(STATE_FILE, "utf8");
		const parsed = JSON.parse(raw) as ObserverState;
		return parsed && typeof parsed === "object" && parsed.files ? parsed : { files: {} };
	} catch {
		return { files: {} };
	}
}

function saveState(state: ObserverState) {
	try {
		writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
	} catch {
		// disk full / permissions / readonly — skip; next scan will retry
	}
}

function listRolloutFiles(sinceDaysAgo: number): string[] {
	const result: string[] = [];
	const now = new Date();
	for (let i = 0; i <= sinceDaysAgo; i++) {
		const d = new Date(now.getTime() - i * 86_400_000);
		const year = String(d.getUTCFullYear());
		const month = String(d.getUTCMonth() + 1).padStart(2, "0");
		const day = String(d.getUTCDate()).padStart(2, "0");
		const dir = join(CODEX_SESSIONS_ROOT, year, month, day);
		if (!existsSync(dir)) continue;
		try {
			for (const entry of readdirSync(dir)) {
				if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
					result.push(join(dir, entry));
				}
			}
		} catch {
			// unreadable dir — skip
		}
	}
	return result;
}

type HookPayload = {
	session_id: string;
	hook_event_name: string;
	cwd?: string;
	model?: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_response?: unknown;
	last_assistant_message?: string;
	prompt?: string;
	turn_id?: string;
};

async function postHook(serverUrl: string, apiKey: string | null, payload: HookPayload) {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Agent-Type": "codex_cli",
	};
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	const res = await fetch(`${serverUrl}/api/v1/hooks`, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) {
		throw new Error(`ingest ${res.status} ${res.statusText}`);
	}
}

function extractTextContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string };
		if ((b.type === "input_text" || b.type === "output_text") && typeof b.text === "string") {
			parts.push(b.text);
		}
	}
	return parts.join("\n").trim();
}

function tryParseJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

type CallMap = Map<string, string>; // call_id -> tool_name

async function processRolloutFile(
	filePath: string,
	stateEntry: FileState | undefined,
	serverUrl: string,
	apiKey: string | null,
	callMap: CallMap,
): Promise<FileState> {
	const stat = statSync(filePath);
	const startOffset = stateEntry?.offset ?? 0;
	if (stat.size === startOffset) {
		return stateEntry ?? { offset: 0, sessionId: "" };
	}
	if (stat.size < startOffset) {
		// file truncated / replaced — restart from 0
		return processRolloutFile(filePath, undefined, serverUrl, apiKey, callMap);
	}

	const bytesToRead = stat.size - startOffset;
	const buf = Buffer.alloc(bytesToRead);
	const fd = await open(filePath, "r");
	try {
		await fd.read(buf, 0, bytesToRead, startOffset);
	} finally {
		await fd.close();
	}

	const chunk = buf.toString("utf8");
	const endsWithNewline = chunk.endsWith("\n");
	const lines = chunk.split("\n");
	const completeLines = endsWithNewline ? lines.filter((l) => l !== "") : lines.slice(0, -1);
	const incomplete = endsWithNewline ? "" : lines[lines.length - 1];
	const consumedBytes = bytesToRead - Buffer.byteLength(incomplete, "utf8");
	const newOffset = startOffset + consumedBytes;

	let sessionId = stateEntry?.sessionId ?? "";

	for (const line of completeLines) {
		if (!line.trim()) continue;
		let entry: { type?: string; payload?: Record<string, unknown> };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type === "session_meta") {
			const p = entry.payload ?? {};
			sessionId = typeof p.id === "string" ? p.id : sessionId;
			const cwd = typeof p.cwd === "string" ? p.cwd : undefined;
			const model = typeof p.model === "string" ? p.model : undefined;
			if (sessionId) {
				await postHook(serverUrl, apiKey, {
					session_id: sessionId,
					hook_event_name: "SessionStart",
					cwd,
					model,
				});
			}
			continue;
		}

		if (!sessionId) continue;

		if (entry.type === "response_item") {
			const p = entry.payload ?? {};
			const kind = typeof p.type === "string" ? p.type : "";

			if (kind === "message") {
				const role = typeof p.role === "string" ? p.role : "";
				const text = extractTextContent(p.content);
				if (!text) continue;
				if (role === "user") {
					await postHook(serverUrl, apiKey, {
						session_id: sessionId,
						hook_event_name: "UserPromptSubmit",
						prompt: text,
					});
				} else if (role === "assistant") {
					await postHook(serverUrl, apiKey, {
						session_id: sessionId,
						hook_event_name: "Stop",
						last_assistant_message: text,
					});
				}
				continue;
			}

			if (kind === "function_call") {
				const callId = typeof p.call_id === "string" ? p.call_id : "";
				const toolName = typeof p.name === "string" ? p.name : "unknown_tool";
				const toolInput = tryParseJson(p.arguments);
				if (callId) callMap.set(callId, toolName);
				await postHook(serverUrl, apiKey, {
					session_id: sessionId,
					hook_event_name: "PreToolUse",
					tool_name: toolName,
					tool_input: toolInput,
				});
				continue;
			}

			if (kind === "function_call_output") {
				const callId = typeof p.call_id === "string" ? p.call_id : "";
				const toolName = callMap.get(callId) ?? "unknown_tool";
				const rawOutput = (p as { output?: unknown }).output;
				const toolResponse = tryParseJson(rawOutput);
				await postHook(serverUrl, apiKey, {
					session_id: sessionId,
					hook_event_name: "PostToolUse",
					tool_name: toolName,
					tool_response: toolResponse,
				});
				continue;
			}
		}

		if (entry.type === "event_msg") {
			const p = entry.payload ?? {};
			if (p.type === "task_completed") {
				await postHook(serverUrl, apiKey, {
					session_id: sessionId,
					hook_event_name: "Stop",
				});
			}
		}
	}

	return { offset: newOffset, sessionId };
}

export async function startCodexObserver(options: {
	serverUrl: string;
	apiKey: string | null;
}) {
	if (!existsSync(CODEX_SESSIONS_ROOT)) {
		console.log("[codex-observer] no ~/.codex/sessions directory; observer idle");
		return;
	}

	const state = loadState();
	const callMapsByFile = new Map<string, CallMap>();

	async function scan() {
		const files = listRolloutFiles(BACKFILL_DAYS);
		for (const file of files) {
			try {
				let callMap = callMapsByFile.get(file);
				if (!callMap) {
					callMap = new Map<string, string>();
					callMapsByFile.set(file, callMap);
				}
				const next = await processRolloutFile(
					file,
					state.files[file],
					options.serverUrl,
					options.apiKey,
					callMap,
				);
				state.files[file] = next;
				saveState(state);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[codex-observer] ${file}: ${message}`);
			}
		}
	}

	console.log("[codex-observer] scanning ~/.codex/sessions every", SCAN_INTERVAL_MS / 1000, "s");
	await scan();
	setInterval(scan, SCAN_INTERVAL_MS).unref();
}
