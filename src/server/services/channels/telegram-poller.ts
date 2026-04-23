import { getTelegramBotToken } from "./telegram-credentials.js";
import { type TelegramUpdate, deleteTelegramWebhook, getTelegramUpdates } from "./telegram.js";

/**
 * Long-poll `getUpdates` loop for instances that can't accept a
 * Telegram webhook (e.g. behind NAT, home-lab with private-IP DNS).
 * We call out to Telegram on a 30-second long poll, process each
 * update via the shared handler passed at start time, and track the
 * last-seen `update_id` in memory so Telegram doesn't re-deliver.
 *
 * Only one poller should run per bot token — Telegram enforces that
 * webhook and getUpdates are mutually exclusive, so start() deletes
 * any existing webhook before the loop begins.
 */

const POLL_TIMEOUT_SECONDS = 25;
// Short sleep between polls; the long-poll timeout is the real pacing
// mechanism. This is just a safety net after errors.
const ERROR_BACKOFF_MS = 5000;

interface PollerStatus {
	running: boolean;
	lastPollAt: string | null;
	updatesReceived: number;
	lastError: string | null;
}

const status: PollerStatus = {
	running: false,
	lastPollAt: null,
	updatesReceived: 0,
	lastError: null,
};

let offset = 0;
let stopRequested = false;
let currentLoop: Promise<void> | null = null;
let currentHandler: ((update: TelegramUpdate) => Promise<void>) | null = null;

export function getTelegramPollerStatus(): PollerStatus {
	return { ...status };
}

export function isTelegramPollerRunning(): boolean {
	return status.running;
}

/**
 * Start the poll loop. Safe to call if already running — no-op. On
 * success, deletes any registered webhook first so Telegram will
 * accept the getUpdates call.
 */
export async function startTelegramPolling(
	handler: (update: TelegramUpdate) => Promise<void>,
): Promise<void> {
	if (status.running) {
		// Swap in the new handler but don't double-start the loop.
		currentHandler = handler;
		return;
	}
	if (!getTelegramBotToken()) {
		status.lastError = "bot token not configured";
		return;
	}

	// Telegram rejects getUpdates if a webhook is set. Idempotently clear it.
	await deleteTelegramWebhook().catch(() => {
		// ignore — we proceed and let Telegram surface the real error
	});

	stopRequested = false;
	status.running = true;
	status.lastError = null;
	currentHandler = handler;

	currentLoop = (async () => {
		while (!stopRequested) {
			try {
				const res = await getTelegramUpdates({
					offset: offset > 0 ? offset + 1 : 0,
					timeout: POLL_TIMEOUT_SECONDS,
				});
				status.lastPollAt = new Date().toISOString();
				if (!res.ok) {
					status.lastError = res.error;
					// Back off so we don't hammer Telegram during a 401/network issue.
					await sleep(ERROR_BACKOFF_MS);
					continue;
				}
				status.lastError = null;
				for (const update of res.updates) {
					offset = update.update_id;
					status.updatesReceived += 1;
					try {
						await currentHandler?.(update);
					} catch (err) {
						console.error("[telegram-poller] handler failed for update", update.update_id, err);
					}
				}
			} catch (err) {
				status.lastError = err instanceof Error ? err.message : String(err);
				console.error("[telegram-poller] poll failed:", err);
				await sleep(ERROR_BACKOFF_MS);
			}
		}
		status.running = false;
		currentLoop = null;
	})();
}

/**
 * Signal the loop to stop. The current long-poll may linger until its
 * server-side timeout; await the returned promise if you need to know
 * when the next poll cycle has actually exited.
 */
export async function stopTelegramPolling(): Promise<void> {
	stopRequested = true;
	if (currentLoop) {
		await Promise.race([currentLoop, sleep(500)]);
	}
	status.running = false;
	currentHandler = null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
