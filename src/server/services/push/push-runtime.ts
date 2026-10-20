/**
 * Starts mobile push at boot and says whether it is available.
 *
 * Push needs two things from the operator: a relay (`AGENTPULSE_PUSH_RELAY_URL`)
 * and the instance secrets key (`AGENTPULSE_SECRETS_KEY`), which encrypts each
 * phone's send token. With either missing push stays off: dispatch is a no-op,
 * `/devices/:id/test` answers 503, and capabilities don't advertise it. Nothing
 * else about the server changes.
 *
 * The Live Activity publisher and, in a build with AI, the health and digest triggers start and stop with push. Who hears about an event is `PolicyPushTargets`: solo, every eligible phone;
 * team, the session owner's phones (see push-targets.ts).
 */
import { and, eq, isNull } from "drizzle-orm";
import { config } from "../../config.js";
import { getDb } from "../../db/client.js";
import { mobileDeviceActivities } from "../../db/schema/index.js";
import { observeWsRevalidation } from "../../ws/revalidation.js";
import { isAiBuildEnabled } from "../ai/feature.js";
import { decryptSecretAsync } from "../ai/secrets.js";
import { getMode } from "../instance-mode.js";
import { revokeDeviceRow } from "../mobile-devices-service.js";
import { sessionBus } from "../notifier.js";
import { DbPushDeviceSource, DbPushSubjects, readSessionSnapshot } from "./device-source.js";
import { configurePushRuntime, getPushRuntime } from "./dispatch.js";
import {
	type LiveActivityPublisher,
	createDbLiveActivityPublisher,
} from "./live-activity-publisher.js";
import { pushCapability } from "./push-capability.js";
import { enrichPushEvent } from "./push-enrich.js";
import { PushTriggerScheduler } from "./push-scheduler.js";
import { PushService } from "./push-service.js";
import { PolicyPushTargets } from "./push-targets.js";
import { createDbTriggerPorts } from "./push-trigger-ports.js";
import { RelayClient, loadRelayUrl } from "./relay-client.js";
import { type PushLogger, type PushRevocationSink, consolePushLogger } from "./types.js";

/** How long the eligible-device list is reused between events. */
const ELIGIBLE_CACHE_MS = 1_500;

export type PushOffReason = "relay_not_configured" | "relay_url_invalid" | "secrets_key_missing";

export type PushAvailability =
	| { available: true; relayOrigin: string }
	| { available: false; reason: PushOffReason };

let relayOrigin: string | null = null;
let publisher: LiveActivityPublisher | null = null;
let triggers: PushTriggerScheduler | null = null;
let stopInvalidatingTargets: (() => void) | null = null;

/** The running Live Activity publisher, or null when push is off. */
export function getLiveActivityPublisher(): LiveActivityPublisher | null {
	return publisher;
}
/** The running health and digest triggers, or null when push is off or the build has no AI. */
export function getPushTriggers(): PushTriggerScheduler | null {
	return triggers;
}
let offReason: PushOffReason = "relay_not_configured";

/** What the relay's answers do to the device table. None of them touches an API key. */
export function createRevocationSink(logger: PushLogger = consolePushLogger): PushRevocationSink {
	return {
		deviceGone: async (device) => {
			await revokeDeviceRow(device.id, "relay_gone");
			logger.info("device revoked: gone at the relay", { device: device.id });
		},
		tokenRejected: async (device) => {
			await revokeDeviceRow(device.id, "relay_token_rejected");
			logger.warn("device revoked: relay rejected its send token", { device: device.id });
		},
		activityGone: async (device, slot) => {
			await getDb()
				.update(mobileDeviceActivities)
				.set({ endedAt: new Date().toISOString() })
				.where(
					and(
						eq(mobileDeviceActivities.deviceId, device.id),
						eq(mobileDeviceActivities.slot, slot),
						isNull(mobileDeviceActivities.endedAt),
					),
				);
		},
	};
}

/** Installs the push runtime when the operator has configured it. Safe to call once at boot. */
export function startPush(
	env: Record<string, string | undefined> = process.env,
	logger: PushLogger = consolePushLogger,
): PushAvailability {
	stopPush();
	let relayUrl: string | null;
	try {
		relayUrl = loadRelayUrl(env);
	} catch (err) {
		offReason = "relay_url_invalid";
		logger.warn("push disabled: relay URL is invalid", {
			error: err instanceof Error ? err.message : "unknown",
		});
		return { available: false, reason: offReason };
	}
	const capability = pushCapability(relayUrl);
	if (!relayUrl || !capability) {
		offReason = "relay_not_configured";
		return { available: false, reason: offReason };
	}
	if (!config.secretsKey) {
		offReason = "secrets_key_missing";
		logger.warn(
			"push disabled: AGENTPULSE_SECRETS_KEY is not set (it encrypts each phone's send token)",
		);
		return { available: false, reason: offReason };
	}

	const service = new PushService({
		relay: new RelayClient({ relayUrl, logger }),
		revocations: createRevocationSink(logger),
		readSendToken: decryptSecretAsync,
		logger,
	});
	const targets = new PolicyPushTargets(new DbPushDeviceSource(), getMode, new DbPushSubjects(), {
		ms: ELIGIBLE_CACHE_MS,
		now: Date.now,
	});
	// Every change that can make a device ineligible (a revoked device or key, a disabled user, a role
	// change) requests a revalidation once it has committed; the cached device list is dropped with it.
	stopInvalidatingTargets = observeWsRevalidation(async () => targets.invalidate());
	configurePushRuntime({
		targets,
		enrich: enrichPushEvent,
		readSession: readSessionSnapshot,
		service,
		logger,
	});
	publisher = createDbLiveActivityPublisher(service, sessionBus, logger);
	publisher.start();
	if (isAiBuildEnabled()) {
		triggers = new PushTriggerScheduler({ ports: createDbTriggerPorts(service), logger });
		triggers.start();
	}
	relayOrigin = capability.push.relayOrigin;
	logger.info("push enabled", { relay: relayOrigin });
	return { available: true, relayOrigin };
}

export function stopPush(): void {
	publisher?.stop();
	publisher = null;
	triggers?.stop();
	triggers = null;
	stopInvalidatingTargets?.();
	stopInvalidatingTargets = null;
	configurePushRuntime(null);
	relayOrigin = null;
}

/** Live answer: the runtime is installed and the secrets key is still set. */
export function pushAvailability(): PushAvailability {
	if (!getPushRuntime() || relayOrigin === null) return { available: false, reason: offReason };
	if (!config.secretsKey) return { available: false, reason: "secrets_key_missing" };
	return { available: true, relayOrigin };
}
