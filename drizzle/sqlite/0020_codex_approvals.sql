CREATE TABLE `codex_approval_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`approval_id` text NOT NULL,
	`session_id` text NOT NULL,
	`host_name` text,
	`actor_user_id` text,
	`actor_key_id` text,
	`actor_label` text NOT NULL,
	`request_kind` text NOT NULL,
	`revision` integer NOT NULL,
	`presentation_hash` text NOT NULL,
	`decision` text NOT NULL,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_codex_approval_audit_approval` ON `codex_approval_audit` (`approval_id`);--> statement-breakpoint
CREATE INDEX `idx_codex_approval_audit_session_created` ON `codex_approval_audit` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `codex_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`runtime_epoch` text NOT NULL,
	`rpc_id` text NOT NULL,
	`request_kind` text NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`item_id` text NOT NULL,
	`provider_approval_id` text,
	`presentation` text,
	`reason_text` text,
	`presentation_hash` text NOT NULL,
	`presentation_revision` integer NOT NULL,
	`approvable` integer NOT NULL,
	`not_approvable_reason` text,
	`can_cancel` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`closed_reason` text,
	`host_outcome` text,
	`decision` text,
	`answered_by_user_id` text,
	`answered_by_key_id` text,
	`answered_at` text,
	`first_delivered_at` text,
	`last_issued_at` text,
	`fenced_at` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`closed_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_codex_approvals_session_epoch_rpc` ON `codex_approvals` (`session_id`,`runtime_epoch`,`rpc_id`);--> statement-breakpoint
CREATE INDEX `idx_codex_approvals_session_status` ON `codex_approvals` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_codex_approvals_session_created` ON `codex_approvals` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_codex_approvals_status_expires` ON `codex_approvals` (`status`,`expires_at`);--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_codex_approval_audit_update BEFORE UPDATE ON codex_approval_audit WHEN NEW.id IS NOT OLD.id OR NEW.approval_id IS NOT OLD.approval_id OR NEW.session_id IS NOT OLD.session_id OR NEW.host_name IS NOT OLD.host_name OR NEW.actor_user_id IS NOT OLD.actor_user_id OR NEW.actor_key_id IS NOT OLD.actor_key_id OR NEW.actor_label IS NOT OLD.actor_label OR NEW.request_kind IS NOT OLD.request_kind OR NEW.revision IS NOT OLD.revision OR NEW.presentation_hash IS NOT OLD.presentation_hash OR NEW.decision IS NOT OLD.decision OR NEW.created_at IS NOT OLD.created_at OR NOT (OLD.outcome = 'pending' AND NEW.outcome <> 'pending' AND NEW.completed_at IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'codex_approval_audit_append_only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_codex_approval_audit_delete BEFORE DELETE ON codex_approval_audit BEGIN SELECT RAISE(ABORT, 'codex_approval_audit_append_only'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS trg_codex_approvals_finalize_audit BEFORE DELETE ON codex_approvals BEGIN UPDATE codex_approval_audit SET outcome = CASE WHEN OLD.first_delivered_at IS NOT NULL THEN 'session_deleted_after_issue' ELSE 'session_deleted' END, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE approval_id = OLD.id AND outcome = 'pending'; END;
