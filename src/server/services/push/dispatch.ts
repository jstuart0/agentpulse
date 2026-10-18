/**
 * The one call every push trigger makes: `void dispatchEvent(event)`.
 *
 * It is fire-and-forget. It never rejects and never throws, so a trigger sitting
 * in an ingest path can call it without a try/catch. It yields to the event loop
 * before the first read, so the trigger's own transaction has committed and its
 * response has been queued before any target lookup runs. When push is not set
 * up there is no runtime and the call returns at once, reading nothing.
 *
 * Devices are not notification channels: this path deliberately does not go
 * through the channel registry or add a channel kind.
 */
import { decryptSecretAsync } from "../ai/secrets.js";
import { PushService } from "./push-service.js";
import { RelayClient } from "./relay-client.js";
import {
	type PushEvent,
	type PushLogger,
	type PushRevocationSink,
	type PushTargetResolver,
	consolePushLogger,
} from "./types.js";

export interface PushRuntime {
	targets: PushTargetResolver;
	service: Pick<PushService, "sendToDevices">;
	logger?: PushLogger;
}

let runtime: PushRuntime | null = null;

/** Installs (or, with null, removes) the push runtime. Called once at startup by whatever wires push in. */
export function configurePushRuntime(next: PushRuntime | null): void {
	runtime = next;
}

export function getPushRuntime(): PushRuntime | null {
	return runtime;
}

/** Builds the runtime for a configured relay: the client, the service and the given targeting and revocation. */
export function createPushRuntime(options: {
	relayUrl: string;
	targets: PushTargetResolver;
	revocations: PushRevocationSink;
	logger?: PushLogger;
}): PushRuntime {
	const logger = options.logger ?? consolePushLogger;
	const relay = new RelayClient({ relayUrl: options.relayUrl, logger });
	return {
		targets: options.targets,
		service: new PushService({
			relay,
			revocations: options.revocations,
			readSendToken: decryptSecretAsync,
			logger,
		}),
		logger,
	};
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function dispatchEvent(event: PushEvent): Promise<void> {
	const current = runtime;
	if (!current) return;
	const logger = current.logger ?? consolePushLogger;
	try {
		await yieldToEventLoop();
		const devices = await current.targets.resolve(event);
		if (devices.length === 0) return;
		await current.service.sendToDevices(devices, event);
	} catch (err) {
		logger.warn("dispatch failed", {
			type: event.type,
			error: err instanceof Error ? err.name : "unknown",
		});
	}
}
