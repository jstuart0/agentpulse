/**
 * Anonymous, opt-out telemetry for AgentPulse.
 *
 * Collects minimal, anonymous data to understand how AgentPulse is used
 * and prioritize improvements. No personally identifiable information
 * is ever collected.
 *
 * Disable via:
 *   - Environment variable: AGENTPULSE_TELEMETRY=off
 *   - Environment variable: DO_NOT_TRACK=1
 *
 * What is collected:
 *   - A random installation ID (UUID, generated once, no PII)
 *   - AgentPulse version
 *   - Platform (OS and architecture)
 *   - Aggregate counts (total sessions, active sessions, agent type breakdown)
 *   - Database type (sqlite or postgres)
 *   - Whether auth is disabled
 *
 * What is NOT collected:
 *   - Session contents, prompts, or tool outputs
 *   - User names, emails, or API keys
 *   - IP addresses (the server does not log them)
 *   - Project paths or file contents
 */

import { db } from "../db/client.js";
import { sessions, settings } from "../db/schema.js";
import { eq, count } from "drizzle-orm";
import { config } from "../config.js";

const TELEMETRY_ENDPOINT = "https://telemetry.agentpulse.dev/v1/ping";
const PING_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const VERSION = "0.1.0";

interface TelemetryPing {
	installation_id: string;
	version: string;
	platform: string;
	db_type: string;
	auth_disabled: boolean;
	total_sessions: number;
	active_sessions: number;
	agent_types: Record<string, number>;
	timestamp: string;
}

function isEnabled(): boolean {
	const telemetryEnv = process.env.AGENTPULSE_TELEMETRY?.toLowerCase();
	if (telemetryEnv === "off" || telemetryEnv === "false" || telemetryEnv === "0") return false;
	if (process.env.DO_NOT_TRACK === "1") return false;
	return true;
}

async function getOrCreateInstallationId(): Promise<string> {
	const [existing] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, "installation_id"))
		.limit(1);

	if (existing && typeof existing.value === "string") {
		return existing.value;
	}

	const id = crypto.randomUUID();
	await db
		.insert(settings)
		.values({ key: "installation_id", value: id, updatedAt: new Date().toISOString() })
		.onConflictDoUpdate({ target: settings.key, set: { value: id } });

	return id;
}

async function collectPing(): Promise<TelemetryPing> {
	const installationId = await getOrCreateInstallationId();

	const totalSessions = await db.select({ count: count() }).from(sessions);
	const activeSessions = await db
		.select({ count: count() })
		.from(sessions)
		.where(eq(sessions.status, "active"));

	const byType = await db
		.select({ agentType: sessions.agentType, count: count() })
		.from(sessions)
		.groupBy(sessions.agentType);

	const agentTypes: Record<string, number> = {};
	for (const row of byType) {
		agentTypes[row.agentType] = row.count;
	}

	return {
		installation_id: installationId,
		version: VERSION,
		platform: `${process.platform}/${process.arch}`,
		db_type: config.useSqlite ? "sqlite" : "postgres",
		auth_disabled: config.disableAuth,
		total_sessions: totalSessions[0]?.count ?? 0,
		active_sessions: activeSessions[0]?.count ?? 0,
		agent_types: agentTypes,
		timestamp: new Date().toISOString(),
	};
}

async function sendPing(): Promise<void> {
	try {
		const ping = await collectPing();

		await fetch(TELEMETRY_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(ping),
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		// Telemetry failures are silently ignored -- never affect the user
	}
}

export function startTelemetry(): void {
	if (!isEnabled()) {
		console.log("[telemetry] Disabled (set AGENTPULSE_TELEMETRY=off or DO_NOT_TRACK=1)");
		return;
	}

	console.log("[telemetry] Anonymous usage telemetry enabled");
	console.log("[telemetry] Disable with AGENTPULSE_TELEMETRY=off or DO_NOT_TRACK=1");

	// Send initial ping after 60 seconds (let server stabilize)
	setTimeout(sendPing, 60_000);

	// Then every 24 hours
	setInterval(sendPing, PING_INTERVAL_MS);
}
