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
 *   - Event kind (first boot vs heartbeat)
 *   - Install class and release channel
 *
 * What is NOT collected:
 *   - Session contents, prompts, or tool outputs
 *   - User names, emails, or API keys
 *   - IP addresses (the server does not log them)
 *   - Project paths or file contents
 */

import { count, eq } from "drizzle-orm";
import packageJson from "../../../package.json";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { sessions, settings } from "../db/schema.js";

// Telemetry reports anonymous usage data to the AgentPulse project maintainers.
// This helps us understand adoption and prioritize improvements.
// Opt out with AGENTPULSE_TELEMETRY=off or DO_NOT_TRACK=1.
const TELEMETRY_ENDPOINT = "https://telemetry-agentpulse.xmojo.net/v1/ping";
const INITIAL_PING_DELAY_MS = 5_000;
const PING_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const VERSION = typeof packageJson.version === "string" ? packageJson.version : "unknown";

const INSTALLATION_ID_KEY = "installation_id";
const INSTALLATION_CREATED_AT_KEY = "telemetry:installation_created_at";
const FIRST_BOOT_SENT_AT_KEY = "telemetry:first_boot_sent_at";
const LAST_ATTEMPT_AT_KEY = "telemetry:last_attempt_at";
const LAST_SUCCESS_AT_KEY = "telemetry:last_success_at";
const LAST_ERROR_KEY = "telemetry:last_error";
const LAST_EVENT_KIND_KEY = "telemetry:last_event_kind";
const LAST_PAYLOAD_KEY = "telemetry:last_payload";

type TelemetryEventKind = "first_boot" | "heartbeat";
export type TelemetryInstallClass =
	| "production"
	| "self_hosted_real"
	| "dev"
	| "test"
	| "ci";
export type TelemetryReleaseChannel = "stable" | "prerelease" | "dev";

interface TelemetryPing {
	installation_id: string;
	version: string;
	release_channel: TelemetryReleaseChannel;
	install_class: TelemetryInstallClass;
	platform: string;
	db_type: string;
	auth_disabled: boolean;
	total_sessions: number;
	active_sessions: number;
	agent_types: Record<string, number>;
	event_kind: TelemetryEventKind;
	timestamp: string;
}

export interface TelemetryDiagnostics {
	enabled: boolean;
	endpoint: string;
	version: string;
	releaseChannel: TelemetryReleaseChannel;
	installClass: TelemetryInstallClass;
	installationId: string | null;
	installationCreatedAt: string | null;
	firstBootSentAt: string | null;
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	lastError: string | null;
	lastEventKind: TelemetryEventKind | null;
	lastPayload: TelemetryPing | null;
	initialPingDelayMs: number;
	pingIntervalMs: number;
}

function isEnabled(): boolean {
	const telemetryEnv = process.env.AGENTPULSE_TELEMETRY?.toLowerCase();
	if (telemetryEnv === "off" || telemetryEnv === "false" || telemetryEnv === "0") return false;
	if (process.env.DO_NOT_TRACK === "1") return false;
	return true;
}

function detectReleaseChannel(version: string): TelemetryReleaseChannel {
	const normalized = version.toLowerCase();
	if (normalized === "unknown" || normalized === "dev" || normalized.includes("dev")) {
		return "dev";
	}
	if (normalized.includes("-pre") || normalized.includes("alpha") || normalized.includes("beta")) {
		return "prerelease";
	}
	return "stable";
}

function detectInstallClass(releaseChannel: TelemetryReleaseChannel): TelemetryInstallClass {
	const explicit = process.env.AGENTPULSE_TELEMETRY_MODE?.trim().toLowerCase();
	switch (explicit) {
		case "production":
		case "self_hosted_real":
		case "dev":
		case "test":
		case "ci":
			return explicit;
	}

	const ciEnv = process.env.CI?.toLowerCase();
	if (ciEnv === "1" || ciEnv === "true") return "ci";
	if (process.env.AGENTPULSE_TELEMETRY_TEST === "1") return "test";
	if (releaseChannel !== "stable") return "dev";
	if (process.env.NODE_ENV !== "production") return "dev";
	return "self_hosted_real";
}

async function getSettingValue<T>(key: string): Promise<T | null> {
	const [existing] = await db
		.select()
		.from(settings)
		.where(eq(settings.key, key))
		.limit(1);
	return (existing?.value as T | undefined) ?? null;
}

async function setSettingValue(key: string, value: unknown): Promise<void> {
	await db
		.insert(settings)
		.values({ key, value, updatedAt: new Date().toISOString() })
		.onConflictDoUpdate({
			target: settings.key,
			set: { value, updatedAt: new Date().toISOString() },
		});
}

async function getOrCreateInstallationId(): Promise<{ id: string; created: boolean }> {
	const existing = await getSettingValue<string>(INSTALLATION_ID_KEY);

	if (existing) {
		return { id: existing, created: false };
	}

	const id = crypto.randomUUID();
	const createdAt = new Date().toISOString();
	await setSettingValue(INSTALLATION_ID_KEY, id);
	await setSettingValue(INSTALLATION_CREATED_AT_KEY, createdAt);

	return { id, created: true };
}

async function nextEventKind(installationCreated: boolean): Promise<TelemetryEventKind> {
	if (installationCreated) return "first_boot";
	const firstBootSentAt = await getSettingValue<string>(FIRST_BOOT_SENT_AT_KEY);
	return firstBootSentAt ? "heartbeat" : "first_boot";
}

async function collectPing(): Promise<TelemetryPing> {
	const installation = await getOrCreateInstallationId();
	const eventKind = await nextEventKind(installation.created);
	const releaseChannel = detectReleaseChannel(VERSION);
	const installClass = detectInstallClass(releaseChannel);

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
		installation_id: installation.id,
		version: VERSION,
		release_channel: releaseChannel,
		install_class: installClass,
		platform: `${process.platform}/${process.arch}`,
		db_type: config.useSqlite ? "sqlite" : "postgres",
		auth_disabled: config.disableAuth,
		total_sessions: totalSessions[0]?.count ?? 0,
		active_sessions: activeSessions[0]?.count ?? 0,
		agent_types: agentTypes,
		event_kind: eventKind,
		timestamp: new Date().toISOString(),
	};
}

async function markAttempt(ping: TelemetryPing): Promise<void> {
	await setSettingValue(LAST_ATTEMPT_AT_KEY, ping.timestamp);
	await setSettingValue(LAST_EVENT_KIND_KEY, ping.event_kind);
	await setSettingValue(LAST_PAYLOAD_KEY, ping);
}

async function markSuccess(ping: TelemetryPing): Promise<void> {
	await setSettingValue(LAST_SUCCESS_AT_KEY, ping.timestamp);
	await setSettingValue(LAST_ERROR_KEY, null);
	if (ping.event_kind === "first_boot") {
		await setSettingValue(FIRST_BOOT_SENT_AT_KEY, ping.timestamp);
	}
}

async function markFailure(error: unknown): Promise<void> {
	const message = error instanceof Error ? error.message : String(error);
	await setSettingValue(LAST_ERROR_KEY, message);
}

export async function sendTelemetryNow(): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const ping = await collectPing();
		await markAttempt(ping);

		const response = await fetch(TELEMETRY_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(ping),
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) {
			throw new Error(`Telemetry endpoint returned ${response.status}`);
		}
		await markSuccess(ping);
		return { ok: true };
	} catch (error) {
		await markFailure(error);
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function getTelemetryDiagnostics(): Promise<TelemetryDiagnostics> {
	return {
		enabled: isEnabled(),
		endpoint: TELEMETRY_ENDPOINT,
		version: VERSION,
		releaseChannel: detectReleaseChannel(VERSION),
		installClass: detectInstallClass(detectReleaseChannel(VERSION)),
		installationId: await getSettingValue<string>(INSTALLATION_ID_KEY),
		installationCreatedAt: await getSettingValue<string>(INSTALLATION_CREATED_AT_KEY),
		firstBootSentAt: await getSettingValue<string>(FIRST_BOOT_SENT_AT_KEY),
		lastAttemptAt: await getSettingValue<string>(LAST_ATTEMPT_AT_KEY),
		lastSuccessAt: await getSettingValue<string>(LAST_SUCCESS_AT_KEY),
		lastError: await getSettingValue<string>(LAST_ERROR_KEY),
		lastEventKind: await getSettingValue<TelemetryEventKind>(LAST_EVENT_KIND_KEY),
		lastPayload: await getSettingValue<TelemetryPing>(LAST_PAYLOAD_KEY),
		initialPingDelayMs: INITIAL_PING_DELAY_MS,
		pingIntervalMs: PING_INTERVAL_MS,
	};
}

export function startTelemetry(): void {
	if (!isEnabled()) {
		console.log("[telemetry] Disabled (set AGENTPULSE_TELEMETRY=off or DO_NOT_TRACK=1)");
		return;
	}

	console.log("[telemetry] Anonymous usage telemetry enabled");
	console.log("[telemetry] Disable with AGENTPULSE_TELEMETRY=off or DO_NOT_TRACK=1");

	// Send the first signal quickly so short-lived evals aren't invisible.
	setTimeout(() => {
		void sendTelemetryNow();
	}, INITIAL_PING_DELAY_MS);

	// Then every 24 hours
	setInterval(() => {
		void sendTelemetryNow();
	}, PING_INTERVAL_MS);
}
