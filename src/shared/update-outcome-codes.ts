/** Outcome codes the updater writes (phase 4) and the web explains; one closed set. */
export const UPDATE_OUTCOME_CODES = [
	// consent and install
	"no_consent",
	"container",
	"kubernetes",
	"no_service_manager",
	"tracking_ref",
	"fork_install",
	"no_install_record",
	"symlinked_install",
	// manifest and target
	"unverified",
	"update_check_off",
	"stale",
	"pulled",
	"downgrade",
	"refused_before",
	"server_version_unknown",
	"up_to_date",
	"canary_wait",
	// migrations
	"migration_needs_consent",
	"postgres_migration",
	// preflight
	"dirty_tree",
	"untracked_files",
	"disk_space",
	"not_fast_forward",
	"commit_mismatch",
	"db_path_mismatch",
	"outside_window",
	"locked",
	"backoff",
	// staging
	"install_failed",
	"build_failed",
	"smoke_failed",
	"snapshot_failed",
	// supervisor and services
	"supervisor_busy",
	"drain_timeout",
	"stop_failed",
	"health_failed",
	"supervisor_failed",
	// result
	"rolled_back",
	"rollback_failed",
	"nothing_to_roll_back",
	"downgrade_schema",
	"updated",
] as const;
