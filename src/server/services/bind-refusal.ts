/**
 * A refusal to take over (or resume) a session: a code a client can branch on and the status it answers with.
 * Shared by the authorization rules and the binding service, which can't import each other.
 */
import type { ResumeRefusalCode } from "../../shared/session-resume.js";

export type BindRefusalCode = ResumeRefusalCode | "invalid_body";

const STATUS: Record<BindRefusalCode, number> = {
	invalid_body: 400,
	session_not_found: 404,
	not_owner: 403,
	host_not_allowed: 403,
	host_owner_mismatch: 403,
	session_key_mismatch: 403,
	human_required: 403,
	rate_limited: 429,
	session_active: 409,
	already_managed: 409,
	session_id_unsupported: 409,
	agent_not_supported: 409,
	cwd_unknown: 409,
	cwd_not_trusted: 409,
	host_offline: 409,
	host_gone: 409,
	host_upgrade_required: 409,
	takeover_in_progress: 409,
	retry_not_available: 409,
	not_resumable: 409,
};

export class BindRefusal extends Error {
	readonly status: number;

	constructor(readonly code: BindRefusalCode) {
		super(code);
		this.name = "BindRefusal";
		this.status = STATUS[code];
	}
}
