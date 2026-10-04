/**
 * Shared world for tests that drive whole Ask turns: a default provider, AI
 * and vector search switched on, a counting fake embedding adapter, and two
 * active sessions with events and stored vectors. The LLM is the scripted one
 * in `scripted-llm.ts`; the test file must mock `registry.js` with it before
 * importing the service.
 */
import { config } from "../config.js";
import { getSqlite, initializeDatabase } from "../db/client.js";
import {
	__resetEmbeddingAdapterForTests,
	__setEmbeddingAdapterForTests,
} from "../services/ai/embeddings/embedding-service.js";
import { invalidateAiFlagsCache } from "../services/ai/feature.js";
import { createProvider } from "../services/ai/providers-service.js";
import { bumpVersionAndReload } from "../services/projects/cache.js";
import { resetScriptedLlm } from "./scripted-llm.js";

export const ASK_ACTOR = { userId: null, label: "anonymous" as const };
export const EMBED_MODEL = "fake-8";
export const EMBED_DIM = 8;

/** Every query string the fake embedding adapter was asked to embed. */
export const embedCalls: string[] = [];

const originalSecretsKey = config.secretsKey;
const originalVectorSearch = config.vectorSearchEnabled;

function setSetting(key: string, value: unknown) {
	getSqlite()
		.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
		.run(key, JSON.stringify(value));
}

export async function setupAskFixture(): Promise<void> {
	await initializeDatabase();
	config.secretsKey = "test-secrets-key-32-characters!!";
	(config as Record<string, unknown>).vectorSearchEnabled = true;
	await createProvider({
		userId: "local",
		name: "ask-fixture-provider",
		kind: "anthropic",
		model: "claude-test",
		apiKey: "sk-test-not-real",
		isDefault: true,
	});
	setSetting("ai.enabled", true);
	setSetting("vectorSearch.enabled", true);
	setSetting("labs", { askAssistant: true });
	invalidateAiFlagsCache();
	const query = new Float32Array(EMBED_DIM);
	query[0] = 1;
	__setEmbeddingAdapterForTests({
		kind: "ollama",
		model: EMBED_MODEL,
		dim: EMBED_DIM,
		embed: async (input: string) => {
			embedCalls.push(input);
			return query;
		},
	});
}

export function teardownAskFixture(): void {
	config.secretsKey = originalSecretsKey;
	(config as Record<string, unknown>).vectorSearchEnabled = originalVectorSearch;
	__resetEmbeddingAdapterForTests();
}

/** Fresh threads, sessions, events, vectors and one project (`gizmo`); a fresh script and call log. */
export async function resetAskWorld(): Promise<void> {
	const sqlite = getSqlite();
	for (const table of [
		"ask_messages",
		"ask_threads",
		"event_embeddings",
		"events",
		"sessions",
		"launch_requests",
		"ai_action_requests",
		"ai_pending_project_drafts",
		"projects",
	]) {
		sqlite.exec(`DELETE FROM ${table}`);
	}
	resetScriptedLlm();
	embedCalls.length = 0;
	sqlite.exec("INSERT INTO projects (id, name, cwd) VALUES ('proj-gizmo', 'gizmo', '/tmp/gizmo')");
	await bumpVersionAndReload();

	const insertSession = sqlite.prepare(
		`INSERT INTO sessions (id, session_id, agent_type, status, display_name, cwd, last_activity_at, started_at)
		 VALUES (?, ?, 'claude_code', 'active', ?, ?, '2026-01-02 03:04:05', '2026-01-01 00:00:00')`,
	);
	const insertEvent = sqlite.prepare(
		`INSERT INTO events (id, session_id, event_type, content, raw_payload, created_at)
		 VALUES (?, ?, 'UserPromptSubmit', ?, ?, '2026-01-02 03:04:05')`,
	);
	const insertVector = sqlite.prepare(
		"INSERT INTO event_embeddings (event_id, model, dim, vector) VALUES (?, ?, ?, ?)",
	);
	const near = new Float32Array(EMBED_DIM);
	near[0] = 1;
	const far = new Float32Array(EMBED_DIM);
	far[1] = 1;
	const rows: Array<[number, string, string, string, string, Float32Array]> = [
		[1, "sess-alpha", "Alpha caching work", "/work/alpha", "fix the caching bug", near],
		[2, "sess-beta", "Beta billing work", "/work/beta", "reconcile the invoices", far],
	];
	for (const [id, sessionId, name, cwd, prompt, vector] of rows) {
		insertSession.run(`row-${sessionId}`, sessionId, name, cwd);
		insertEvent.run(id, sessionId, prompt, JSON.stringify({ prompt }));
		insertVector.run(id, EMBED_MODEL, EMBED_DIM, new Uint8Array(vector.buffer));
	}
}
