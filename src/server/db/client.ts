import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { config } from "../config.js";
import * as schema from "./schema.js";

function createDatabase() {
	if (config.useSqlite) {
		const dbPath = config.sqlitePath;
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const sqlite = new Database(dbPath);
		sqlite.exec("PRAGMA journal_mode = WAL;");
		sqlite.exec("PRAGMA foreign_keys = ON;");
		return drizzle(sqlite, { schema });
	}

	// PostgreSQL support can be added here with drizzle-orm/postgres-js
	// For now, fall back to SQLite
	console.warn("PostgreSQL not yet configured, falling back to SQLite");
	const dbPath = config.sqlitePath;
	const dir = dirname(dbPath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	const sqlite = new Database(dbPath);
	sqlite.exec("PRAGMA journal_mode = WAL;");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	return drizzle(sqlite, { schema });
}

export const db = createDatabase();
export type Db = typeof db;

// Initialize database tables
export function initializeDatabase() {
	const sqlite = new Database(config.sqlitePath);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL UNIQUE,
			display_name TEXT,
			agent_type TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active',
			cwd TEXT,
			transcript_path TEXT,
			model TEXT,
			started_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
			ended_at TEXT,
			semantic_status TEXT,
			current_task TEXT,
			plan_summary TEXT,
			total_tool_uses INTEGER NOT NULL DEFAULT 0,
			metadata TEXT DEFAULT '{}'
		);

		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL REFERENCES sessions(session_id),
			event_type TEXT NOT NULL,
			category TEXT,
			source TEXT NOT NULL DEFAULT 'observed_hook',
			content TEXT,
			is_noise INTEGER NOT NULL DEFAULT 0,
			provider_event_type TEXT,
			tool_name TEXT,
			tool_input TEXT,
			tool_response TEXT,
			raw_payload TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS api_keys (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			key_hash TEXT NOT NULL UNIQUE,
			key_prefix TEXT NOT NULL,
			is_active INTEGER NOT NULL DEFAULT 1,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			last_used_at TEXT
		);

		CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS session_templates (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			description TEXT,
			agent_type TEXT NOT NULL,
			cwd TEXT NOT NULL,
			base_instructions TEXT NOT NULL DEFAULT '',
			task_prompt TEXT NOT NULL DEFAULT '',
			model TEXT,
			approval_policy TEXT,
			sandbox_mode TEXT,
			env TEXT NOT NULL DEFAULT '{}',
			tags TEXT NOT NULL DEFAULT '[]',
			is_favorite INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS supervisors (
			id TEXT PRIMARY KEY,
			host_name TEXT NOT NULL,
			platform TEXT NOT NULL,
			arch TEXT NOT NULL,
			version TEXT NOT NULL,
			capabilities_json TEXT NOT NULL DEFAULT '{}',
			trusted_roots_json TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'connected',
			capability_schema_version INTEGER NOT NULL DEFAULT 1,
			config_schema_version INTEGER NOT NULL DEFAULT 1,
			last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
			heartbeat_lease_expires_at TEXT NOT NULL DEFAULT (datetime('now', '+90 seconds')),
			enrollment_state TEXT NOT NULL DEFAULT 'active',
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS supervisor_enrollment_tokens (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			supervisor_id TEXT,
			token_hash TEXT NOT NULL UNIQUE,
			token_prefix TEXT NOT NULL,
			is_active INTEGER NOT NULL DEFAULT 1,
			expires_at TEXT,
			used_at TEXT,
			revoked_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS supervisor_credentials (
			id TEXT PRIMARY KEY,
			supervisor_id TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			token_hash TEXT NOT NULL UNIQUE,
			token_prefix TEXT NOT NULL,
			is_active INTEGER NOT NULL DEFAULT 1,
			last_used_at TEXT,
			revoked_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS launch_requests (
			id TEXT PRIMARY KEY,
			template_id TEXT,
			launch_correlation_id TEXT NOT NULL UNIQUE,
			agent_type TEXT NOT NULL,
			cwd TEXT NOT NULL,
			base_instructions TEXT NOT NULL DEFAULT '',
			task_prompt TEXT NOT NULL DEFAULT '',
			model TEXT,
			approval_policy TEXT,
			sandbox_mode TEXT,
			requested_launch_mode TEXT NOT NULL DEFAULT 'interactive_terminal',
			env_json TEXT NOT NULL DEFAULT '{}',
			launch_spec_json TEXT NOT NULL DEFAULT '{}',
			requested_by TEXT,
			requested_supervisor_id TEXT,
			routing_policy TEXT,
			resolved_supervisor_id TEXT,
			routing_decision_json TEXT,
			claimed_by_supervisor_id TEXT,
			claim_token TEXT,
			status TEXT NOT NULL DEFAULT 'draft',
			error TEXT,
			validation_warnings_json TEXT NOT NULL DEFAULT '[]',
			validation_summary TEXT,
			dispatch_started_at TEXT,
			dispatch_finished_at TEXT,
			awaiting_session_deadline_at TEXT,
			pid INTEGER,
			provider_launch_metadata_json TEXT,
			retry_of_launch_request_id TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS managed_sessions (
			session_id TEXT PRIMARY KEY,
			launch_request_id TEXT NOT NULL,
			supervisor_id TEXT NOT NULL,
			provider_session_id TEXT,
			provider_thread_id TEXT,
			managed_state TEXT NOT NULL DEFAULT 'pending',
			correlation_source TEXT,
			desired_thread_title TEXT,
			provider_thread_title TEXT,
			provider_sync_state TEXT NOT NULL DEFAULT 'pending',
			provider_sync_error TEXT,
			last_provider_sync_at TEXT,
			provider_protocol_version TEXT,
			provider_capability_snapshot_json TEXT,
			active_control_action_id TEXT,
			control_lock_expires_at TEXT,
			host_name TEXT,
			host_affinity_reason TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS control_actions (
			id TEXT PRIMARY KEY,
			session_id TEXT,
			launch_request_id TEXT,
			action_type TEXT NOT NULL,
			requested_by TEXT,
			status TEXT NOT NULL DEFAULT 'queued',
			error TEXT,
			metadata_json TEXT,
			idempotency_key TEXT,
			claimed_by_supervisor_id TEXT,
			finished_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
		CREATE INDEX IF NOT EXISTS idx_sessions_agent_type ON sessions(agent_type);
		CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);
		CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
		CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);
		CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
		CREATE INDEX IF NOT EXISTS idx_templates_agent_type ON session_templates(agent_type);
		CREATE INDEX IF NOT EXISTS idx_templates_updated_at ON session_templates(updated_at);
		CREATE INDEX IF NOT EXISTS idx_supervisors_status ON supervisors(status);
		CREATE INDEX IF NOT EXISTS idx_supervisors_lease ON supervisors(heartbeat_lease_expires_at);
		CREATE INDEX IF NOT EXISTS idx_supervisor_enrollment_active ON supervisor_enrollment_tokens(is_active);
		CREATE INDEX IF NOT EXISTS idx_supervisor_credentials_supervisor ON supervisor_credentials(supervisor_id);
		CREATE INDEX IF NOT EXISTS idx_launch_requests_status ON launch_requests(status);
		CREATE INDEX IF NOT EXISTS idx_launch_requests_supervisor ON launch_requests(requested_supervisor_id);
		CREATE INDEX IF NOT EXISTS idx_control_actions_session ON control_actions(session_id);
		CREATE INDEX IF NOT EXISTS idx_control_actions_status ON control_actions(status);
	`);

	// AI watcher tables are always created. The AGENTPULSE_AI_ENABLED flag
	// gates runtime service startup, not schema shape, so migrations are
	// deterministic across environments (Phase 1 of AI control-plane plan).
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS llm_providers (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL DEFAULT 'local',
			name TEXT NOT NULL,
			kind TEXT NOT NULL,
			model TEXT NOT NULL,
			base_url TEXT,
			credential_ciphertext TEXT NOT NULL,
			credential_hint TEXT NOT NULL,
			is_default INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS watcher_configs (
			session_id TEXT PRIMARY KEY,
			enabled INTEGER NOT NULL DEFAULT 0,
			provider_id TEXT NOT NULL,
			policy TEXT NOT NULL DEFAULT 'ask_always',
			channel_id TEXT,
			max_continuations INTEGER NOT NULL DEFAULT 10,
			continuations_used INTEGER NOT NULL DEFAULT 0,
			max_daily_cents INTEGER,
			system_prompt TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_watcher_configs_enabled ON watcher_configs(enabled);

		CREATE TABLE IF NOT EXISTS ai_daily_spend (
			user_id TEXT NOT NULL,
			date TEXT NOT NULL,
			spend_cents INTEGER NOT NULL DEFAULT 0,
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (user_id, date)
		);

		CREATE TABLE IF NOT EXISTS watcher_proposals (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			provider_id TEXT NOT NULL,
			state TEXT NOT NULL DEFAULT 'pending',
			decision TEXT,
			next_prompt TEXT,
			report_summary TEXT,
			raw_response_json TEXT,
			trigger_event_id TEXT,
			tokens_in INTEGER NOT NULL DEFAULT 0,
			tokens_out INTEGER NOT NULL DEFAULT 0,
			cost_cents INTEGER NOT NULL DEFAULT 0,
			usage_estimated INTEGER NOT NULL DEFAULT 0,
			error_sub_type TEXT,
			error_message TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_watcher_proposals_session ON watcher_proposals(session_id);
		CREATE INDEX IF NOT EXISTS idx_watcher_proposals_state ON watcher_proposals(state);

		CREATE TABLE IF NOT EXISTS ai_watcher_runs (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			trigger_event_id INTEGER,
			trigger_kind TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'queued',
			dedupe_key TEXT NOT NULL,
			lease_owner TEXT,
			lease_expires_at TEXT,
			attempt_count INTEGER NOT NULL DEFAULT 0,
			last_error_sub_type TEXT,
			claimed_at TEXT,
			completed_at TEXT,
			proposal_id TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_ai_watcher_runs_status_lease
			ON ai_watcher_runs(status, lease_expires_at);
		CREATE INDEX IF NOT EXISTS idx_ai_watcher_runs_session_created
			ON ai_watcher_runs(session_id, created_at DESC);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_watcher_runs_open_per_session
			ON ai_watcher_runs(session_id)
			WHERE status IN ('queued', 'claimed', 'running');

		CREATE TABLE IF NOT EXISTS ai_hitl_requests (
			id TEXT PRIMARY KEY,
			proposal_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			channel_id TEXT,
			status TEXT NOT NULL DEFAULT 'awaiting_reply',
			reply_kind TEXT,
			reply_text TEXT,
			expires_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
		CREATE INDEX IF NOT EXISTS idx_ai_hitl_requests_session_status
			ON ai_hitl_requests(session_id, status);
		CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_hitl_requests_open_per_session
			ON ai_hitl_requests(session_id)
			WHERE status = 'awaiting_reply';
	`);

	// Migrations: add columns that may not exist on older databases
	const migrations = [
		"ALTER TABLE sessions ADD COLUMN display_name TEXT",
		"ALTER TABLE sessions ADD COLUMN notes TEXT DEFAULT ''",
		"ALTER TABLE sessions ADD COLUMN is_working INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE sessions ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE sessions ADD COLUMN git_branch TEXT",
		"ALTER TABLE sessions ADD COLUMN claude_md_content TEXT",
		"ALTER TABLE sessions ADD COLUMN claude_md_path TEXT",
		"ALTER TABLE sessions ADD COLUMN claude_md_checksum TEXT",
		"ALTER TABLE sessions ADD COLUMN claude_md_updated_at TEXT",
		"ALTER TABLE events ADD COLUMN category TEXT",
		"ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'observed_hook'",
		"ALTER TABLE events ADD COLUMN content TEXT",
		"ALTER TABLE events ADD COLUMN is_noise INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE events ADD COLUMN provider_event_type TEXT",
		"ALTER TABLE session_templates ADD COLUMN description TEXT",
		"ALTER TABLE session_templates ADD COLUMN base_instructions TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE session_templates ADD COLUMN task_prompt TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE session_templates ADD COLUMN model TEXT",
		"ALTER TABLE session_templates ADD COLUMN approval_policy TEXT",
		"ALTER TABLE session_templates ADD COLUMN sandbox_mode TEXT",
		"ALTER TABLE session_templates ADD COLUMN env TEXT NOT NULL DEFAULT '{}'",
		"ALTER TABLE session_templates ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'",
		"ALTER TABLE session_templates ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE session_templates ADD COLUMN created_at TEXT NOT NULL DEFAULT (datetime('now'))",
		"ALTER TABLE session_templates ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))",
		"ALTER TABLE supervisors ADD COLUMN capability_schema_version INTEGER NOT NULL DEFAULT 1",
		"ALTER TABLE supervisors ADD COLUMN config_schema_version INTEGER NOT NULL DEFAULT 1",
		"ALTER TABLE supervisors ADD COLUMN heartbeat_lease_expires_at TEXT NOT NULL DEFAULT (datetime('now', '+90 seconds'))",
		"ALTER TABLE supervisors ADD COLUMN enrollment_state TEXT NOT NULL DEFAULT 'active'",
		"ALTER TABLE supervisor_enrollment_tokens ADD COLUMN supervisor_id TEXT",
		"ALTER TABLE launch_requests ADD COLUMN requested_launch_mode TEXT NOT NULL DEFAULT 'interactive_terminal'",
		"ALTER TABLE launch_requests ADD COLUMN routing_policy TEXT",
		"ALTER TABLE launch_requests ADD COLUMN resolved_supervisor_id TEXT",
		"ALTER TABLE launch_requests ADD COLUMN routing_decision_json TEXT",
		"ALTER TABLE launch_requests ADD COLUMN validation_warnings_json TEXT NOT NULL DEFAULT '[]'",
		"ALTER TABLE launch_requests ADD COLUMN validation_summary TEXT",
		"ALTER TABLE launch_requests ADD COLUMN claimed_by_supervisor_id TEXT",
		"ALTER TABLE launch_requests ADD COLUMN claim_token TEXT",
		"ALTER TABLE launch_requests ADD COLUMN dispatch_started_at TEXT",
		"ALTER TABLE launch_requests ADD COLUMN dispatch_finished_at TEXT",
		"ALTER TABLE launch_requests ADD COLUMN awaiting_session_deadline_at TEXT",
		"ALTER TABLE launch_requests ADD COLUMN pid INTEGER",
		"ALTER TABLE launch_requests ADD COLUMN provider_launch_metadata_json TEXT",
		"ALTER TABLE launch_requests ADD COLUMN retry_of_launch_request_id TEXT",
		"ALTER TABLE managed_sessions ADD COLUMN correlation_source TEXT",
		"ALTER TABLE managed_sessions ADD COLUMN provider_thread_id TEXT",
		"ALTER TABLE managed_sessions ADD COLUMN desired_thread_title TEXT",
		"ALTER TABLE managed_sessions ADD COLUMN provider_thread_title TEXT",
		"ALTER TABLE managed_sessions ADD COLUMN provider_sync_state TEXT NOT NULL DEFAULT 'pending'",
		"ALTER TABLE managed_sessions ADD COLUMN provider_sync_error TEXT",
		"ALTER TABLE managed_sessions ADD COLUMN last_provider_sync_at TEXT",
		"ALTER TABLE managed_sessions ADD COLUMN provider_protocol_version TEXT",
		"ALTER TABLE managed_sessions ADD COLUMN provider_capability_snapshot_json TEXT",
		"ALTER TABLE managed_sessions ADD COLUMN active_control_action_id TEXT",
		"ALTER TABLE managed_sessions ADD COLUMN control_lock_expires_at TEXT",
		"ALTER TABLE managed_sessions ADD COLUMN host_name TEXT",
		"ALTER TABLE managed_sessions ADD COLUMN host_affinity_reason TEXT",
		// AI watcher session-level columns (safe additive)
		"ALTER TABLE sessions ADD COLUMN watcher_state TEXT",
		"ALTER TABLE sessions ADD COLUMN watcher_last_run_at TEXT",
		"ALTER TABLE sessions ADD COLUMN watcher_last_user_prompt_at TEXT",
		"ALTER TABLE sessions ADD COLUMN ai_spend_cents INTEGER NOT NULL DEFAULT 0",
		// Phase 5: template provenance (ai_distillation | null for manual).
		"ALTER TABLE session_templates ADD COLUMN metadata TEXT",
	];

	for (const migration of migrations) {
		try {
			sqlite.exec(migration);
			console.log(`[db] Migration applied: ${migration.slice(0, 60)}`);
		} catch {
			// Column already exists -- ignore
		}
	}

	// Phase 1 AI control-plane migration: backfill ai_hitl_requests for any
	// open watcher_proposals that still carry legacy `hitl_waiting` state.
	// Idempotent — only inserts when no hitl_request row already exists.
	try {
		sqlite.exec(`
			INSERT INTO ai_hitl_requests (id, proposal_id, session_id, status, created_at, updated_at)
			SELECT
				lower(hex(randomblob(16))),
				p.id,
				p.session_id,
				'awaiting_reply',
				p.updated_at,
				p.updated_at
			FROM watcher_proposals p
			WHERE p.state = 'hitl_waiting'
			AND NOT EXISTS (
				SELECT 1 FROM ai_hitl_requests h WHERE h.proposal_id = p.id
			)
		`);
	} catch (err) {
		console.warn("[db] HITL backfill skipped:", err);
	}

	sqlite.close();
	console.log("[db] Database initialized");
}
