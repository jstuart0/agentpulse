/**
 * launch_requests table — dual-dialect (Decision 21 / Decision 22).
 */
import { sql } from "drizzle-orm";
import { integer as pgInteger, pgTable, text as pgText } from "drizzle-orm/pg-core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { jsonColumn, tsColumn } from "../factory.js";

export const launchRequestsSqlite = sqliteTable("launch_requests", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	templateId: text("template_id"),
	launchCorrelationId: text("launch_correlation_id").notNull().unique(),
	agentType: text("agent_type").notNull(),
	cwd: text("cwd").notNull(),
	baseInstructions: text("base_instructions").notNull().default(""),
	taskPrompt: text("task_prompt").notNull().default(""),
	model: text("model"),
	approvalPolicy: text("approval_policy"),
	sandboxMode: text("sandbox_mode"),
	requestedLaunchMode: text("requested_launch_mode").notNull().default("interactive_terminal"),
	env: text("env_json", { mode: "json" }).$type<Record<string, string>>().notNull().default({}),
	launchSpec: text("launch_spec_json", { mode: "json" })
		.$type<Record<string, unknown>>()
		.notNull()
		.default({}),
	requestedBy: text("requested_by"),
	requestedSupervisorId: text("requested_supervisor_id"),
	routingPolicy: text("routing_policy"),
	resolvedSupervisorId: text("resolved_supervisor_id"),
	routingDecision: text("routing_decision_json", { mode: "json" }).$type<Record<string, unknown>>(),
	claimedBySupervisorId: text("claimed_by_supervisor_id"),
	claimToken: text("claim_token"),
	status: text("status").notNull().default("draft"),
	error: text("error"),
	validationWarnings: text("validation_warnings_json", { mode: "json" })
		.$type<string[]>()
		.notNull()
		.default([]),
	validationSummary: text("validation_summary"),
	dispatchStartedAt: text("dispatch_started_at"),
	dispatchFinishedAt: text("dispatch_finished_at"),
	awaitingSessionDeadlineAt: text("awaiting_session_deadline_at"),
	pid: integer("pid"),
	providerLaunchMetadata: text("provider_launch_metadata_json", { mode: "json" }).$type<
		Record<string, unknown>
	>(),
	retryOfLaunchRequestId: text("retry_of_launch_request_id"),
	parentSessionId: text("parent_session_id"),
	metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
	desiredDisplayName: text("desired_display_name"),
	createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
	updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
});

export const launchRequestsPg = pgTable("launch_requests", {
	id: pgText("id")
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID()),
	templateId: pgText("template_id"),
	launchCorrelationId: pgText("launch_correlation_id").notNull().unique(),
	agentType: pgText("agent_type").notNull(),
	cwd: pgText("cwd").notNull(),
	baseInstructions: pgText("base_instructions").notNull().default(""),
	taskPrompt: pgText("task_prompt").notNull().default(""),
	model: pgText("model"),
	approvalPolicy: pgText("approval_policy"),
	sandboxMode: pgText("sandbox_mode"),
	requestedLaunchMode: pgText("requested_launch_mode").notNull().default("interactive_terminal"),
	env: jsonColumn<Record<string, string>>("postgres", "env_json").notNull().default({}),
	launchSpec: jsonColumn<Record<string, unknown>>("postgres", "launch_spec_json")
		.notNull()
		.default({}),
	requestedBy: pgText("requested_by"),
	requestedSupervisorId: pgText("requested_supervisor_id"),
	routingPolicy: pgText("routing_policy"),
	resolvedSupervisorId: pgText("resolved_supervisor_id"),
	routingDecision: jsonColumn<Record<string, unknown>>("postgres", "routing_decision_json"),
	claimedBySupervisorId: pgText("claimed_by_supervisor_id"),
	claimToken: pgText("claim_token"),
	status: pgText("status").notNull().default("draft"),
	error: pgText("error"),
	validationWarnings: jsonColumn<string[]>("postgres", "validation_warnings_json")
		.notNull()
		.default([]),
	validationSummary: pgText("validation_summary"),
	dispatchStartedAt: pgText("dispatch_started_at"),
	dispatchFinishedAt: pgText("dispatch_finished_at"),
	awaitingSessionDeadlineAt: pgText("awaiting_session_deadline_at"),
	pid: pgInteger("pid"),
	providerLaunchMetadata: jsonColumn<Record<string, unknown>>(
		"postgres",
		"provider_launch_metadata_json",
	),
	retryOfLaunchRequestId: pgText("retry_of_launch_request_id"),
	parentSessionId: pgText("parent_session_id"),
	metadata: jsonColumn<Record<string, unknown>>("postgres", "metadata"),
	desiredDisplayName: pgText("desired_display_name"),
	createdAt: tsColumn("postgres", "created_at"),
	updatedAt: tsColumn("postgres", "updated_at"),
});
