import { telegramAdapter } from "./telegram.js";
import type { NotificationChannelAdapter, NotificationChannelKind } from "./types.js";

/**
 * Registry of notification-channel adapters. Keyed by kind so the runner
 * and HITL service can resolve an adapter without importing each module.
 */
const REGISTRY: Record<NotificationChannelKind, NotificationChannelAdapter> = {
	telegram: telegramAdapter,
	// webhook / email can be plugged in here later.
	webhook: {
		kind: "webhook",
		isConfigured: () => false,
		async send() {
			return { ok: false, error: "webhook adapter not implemented" };
		},
	},
	email: {
		kind: "email",
		isConfigured: () => false,
		async send() {
			return { ok: false, error: "email adapter not implemented" };
		},
	},
};

export function getChannelAdapter(kind: NotificationChannelKind): NotificationChannelAdapter {
	return REGISTRY[kind];
}
