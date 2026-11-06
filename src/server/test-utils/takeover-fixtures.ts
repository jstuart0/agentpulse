/**
 * Fixtures for the take-over and resume suites (AGEN-115): a host that advertises everything a takeover needs,
 * an observed Codex session, a degraded launched one, and the actors. Not a test file.
 */
import { CLAUDE_STOP, CODEX_FOLLOW_UP_PROMPTS } from "../../shared/constants.js";
import { HOST_RESTARTED_SYNC_ERROR } from "../../shared/managed-messages.js";
import { RESUMES_SESSIONS } from "../../shared/session-resume.js";
import type { Actor } from "../auth/actor.js";
import { getDb } from "../db/client.js";
import { launchRequests, managedSessions, sessions, supervisors } from "../db/schema/index.js";
import { ENFORCES_LAUNCH_PRIVILEGES } from "../services/launch-compatibility.js";
import { cleanApprovalFixtures } from "./codex-approvals-harness.js";
import { seedKey } from "./team-fixtures.js";

export const WORK = "/work";
export const CWD = "/work/project";
export const MIN = 60_000;

export const TAKEOVER_CAPABILITIES = {
	version: 1,
	agentTypes: ["claude_code", "codex_cli"],
	launchModes: ["headless", "interactive_terminal", "managed_codex"],
	os: "linux",
	terminalSupport: ["terminal"],
	features: [CODEX_FOLLOW_UP_PROMPTS, CLAUDE_STOP, ENFORCES_LAUNCH_PRIVILEGES, RESUMES_SESSIONS],
	executables: {
		claude: { available: true, command: "claude", resolvedPath: "/usr/bin/claude", source: "auto" },
		codex: { available: true, command: "codex", resolvedPath: "/usr/bin/codex", source: "auto" },
	},
};

const sessionsUsed: string[] = [];
const hostsUsed: string[] = [];
let counter = 0;

/** Removes every row these fixtures made. */
export async function cleanTakeoverFixtures(): Promise<void> {
	await cleanApprovalFixtures(sessionsUsed.splice(0), hostsUsed.splice(0));
}

export function trackSession(sessionId: string): void {
	sessionsUsed.push(sessionId);
}

export async function seedTakeoverHost(
	opts: {
		ownerUserId?: string | null;
		capabilities?: unknown;
		leaseMs?: number;
		enrollmentState?: string;
		trustedRoots?: string[];
	} = {},
): Promise<string> {
	counter++;
	const id = `takeover-host-${counter}-${crypto.randomUUID().slice(0, 6)}`;
	hostsUsed.push(id);
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: `${id}-name`,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: (opts.capabilities ?? TAKEOVER_CAPABILITIES) as Record<string, unknown>,
			trustedRoots: opts.trustedRoots ?? [WORK],
			status: "connected",
			capabilitySchemaVersion: 2,
			configSchemaVersion: 1,
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + (opts.leaseMs ?? 60 * MIN)).toISOString(),
			enrollmentState: opts.enrollmentState ?? "active",
			ownerUserId: opts.ownerUserId ?? null,
			createdAt: now,
			updatedAt: now,
		});
	return id;
}

export interface ObservedOptions {
	ownerUserId?: string | null;
	/** undefined: a key owned by the owner (when there is one); null: no key recorded. */
	ingestKeyId?: string | null;
	cwd?: string | null;
	agentType?: string;
	lastActivityMs?: number;
	isWorking?: boolean;
	status?: string;
	endedAt?: string | null;
	semanticStatus?: string | null;
	metadata?: Record<string, unknown> | null;
	displayName?: string;
}

export async function seedObservedSession(opts: ObservedOptions = {}): Promise<string> {
	const sessionId = crypto.randomUUID();
	sessionsUsed.push(sessionId);
	const ingestKeyId =
		opts.ingestKeyId !== undefined
			? opts.ingestKeyId
			: opts.ownerUserId
				? (await seedKey("takeover-reporter", ["ingest"], opts.ownerUserId)).id
				: null;
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			agentType: opts.agentType ?? "codex_cli",
			cwd: opts.cwd === undefined ? CWD : opts.cwd,
			displayName: opts.displayName ?? "refactor the parser",
			ownerUserId: opts.ownerUserId ?? null,
			ingestKeyId,
			lastActivityAt: new Date(Date.now() - 10 * MIN).toISOString(),
			...(opts.lastActivityMs !== undefined
				? { lastActivityAt: new Date(opts.lastActivityMs).toISOString() }
				: {}),
			isWorking: opts.isWorking ?? false,
			status: opts.status ?? "idle",
			endedAt: opts.endedAt ?? null,
			semanticStatus: opts.semanticStatus ?? null,
			metadata: (opts.metadata ?? null) as Record<string, unknown> | null,
		});
	return sessionId;
}

/**
 * A launched managed Codex session whose process is gone: a launch the host claimed, a degraded managed row
 * with a thread id, recorded privileges that differ from the takeover pair (the agent's default approval policy + read-only;
 * the server's vocabulary has no `on-request`), under the host's trusted root.
 */
export async function seedDegradedLaunched(
	hostId: string,
	opts: { ownerUserId?: string | null; threadId?: string | null; cwd?: string } = {},
): Promise<{ sessionId: string; launchId: string; threadId: string | null }> {
	const sessionId = crypto.randomUUID();
	sessionsUsed.push(sessionId);
	const threadId = opts.threadId === undefined ? crypto.randomUUID() : opts.threadId;
	const cwd = opts.cwd ?? "/work/launched";
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			agentType: "codex_cli",
			cwd,
			displayName: "launched",
			ownerUserId: opts.ownerUserId ?? null,
			status: "idle",
		});
	const [launch] = await getDb()
		.insert(launchRequests)
		.values({
			launchCorrelationId: sessionId,
			agentType: "codex_cli",
			cwd,
			approvalPolicy: "default",
			sandboxMode: "read-only",
			requestedLaunchMode: "managed_codex",
			requestedSupervisorId: hostId,
			claimedBySupervisorId: hostId,
			resolvedSupervisorId: hostId,
			status: "completed",
			requestedByUserId: opts.ownerUserId ?? null,
		})
		.returning();
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId: launch.id,
			supervisorId: hostId,
			providerThreadId: threadId,
			managedState: "degraded",
			providerSyncState: "failed",
			providerSyncError: HOST_RESTARTED_SYNC_ERROR,
			hostName: `${hostId}-name`,
		});
	return { sessionId, launchId: launch.id, threadId };
}

export const SOLO: Actor = { userId: null, label: "anonymous", role: "admin", mode: "solo" };
export const adminActor = (userId: string): Actor => ({
	userId,
	label: "user",
	role: "admin",
	mode: "team",
});
export const memberActor = (userId: string): Actor => ({
	userId,
	label: "user",
	role: "member",
	mode: "team",
});
