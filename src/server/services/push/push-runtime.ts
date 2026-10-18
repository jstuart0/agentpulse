/**
 * Starts mobile push at boot and says whether it is available.
 *
 * Push needs two things from the operator: a relay (`AGENTPULSE_PUSH_RELAY_URL`)
 * and the instance secrets key (`AGENTPULSE_SECRETS_KEY`), which encrypts each
 * phone's send token. With either missing push stays off: dispatch is a no-op,
 * `/devices/:id/test` answers 503, and capabilities don't advertise it. Nothing
 * else about the server changes.
 *
 * Solo mode is the only targeting policy shipped here: every live phone hears
 * about every event. Team targeting arrives with the triggers.
 */
import { and, eq, isNull } from "drizzle-orm";
import { config } from "../../config.js";
import { getDb } from "../../db/client.js";
import { mobileDeviceActivities } from "../../db/schema/index.js";
import { decryptSecretAsync } from "../ai/secrets.js";
import { getMode } from "../instance-mode.js";
import { revokeDeviceRow } from "../mobile-devices-service.js";
import { DbPushDeviceSource } from "./device-source.js";
import { configurePushRuntime, getPushRuntime } from "./dispatch.js";
import { pushCapability } from "./push-capability.js";
import { PushService } from "./push-service.js";
import { SoloPushTargets } from "./push-targets.js";
import { RelayClient, loadRelayUrl } from "./relay-client.js";
import { type PushLogger, type PushRevocationSink, consolePushLogger } from "./types.js";

export type PushOffReason = "relay_not_configured" | "relay_url_invalid" | "secrets_key_missing";

export type PushAvailability =
	| { available: true; relayOrigin: string }
	| { available: false; reason: PushOffReason };

let relayOrigin: string | null = null;
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

	const revocations = createRevocationSink(logger);
	configurePushRuntime({
		targets: new SoloPushTargets(new DbPushDeviceSource(), getMode),
		service: new PushService({
			relay: new RelayClient({ relayUrl, logger }),
			revocations,
			readSendToken: decryptSecretAsync,
			logger,
		}),
		logger,
	});
	relayOrigin = capability.push.relayOrigin;
	logger.info("push enabled", { relay: relayOrigin });
	return { available: true, relayOrigin };
}

export function stopPush(): void {
	configurePushRuntime(null);
	relayOrigin = null;
}

/** Live answer: the runtime is installed and the secrets key is still set. */
export function pushAvailability(): PushAvailability {
	if (!getPushRuntime() || relayOrigin === null) return { available: false, reason: offReason };
	if (!config.secretsKey) return { available: false, reason: "secrets_key_missing" };
	return { available: true, relayOrigin };
}
