/**
 * The Hosts card's offline-outbox line: words and an icon (never colour alone), amber only when events were
 * lost, and a visually hidden status element that is mounted whether or not there is anything to show.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupervisorRecord } from "../../shared/types.js";
import { HostOutboxNotice } from "./HostOutboxNotice.js";

const NOW = new Date(2026, 10, 5, 15, 30).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

type Props = Parameters<typeof HostOutboxNotice>[0]["supervisor"];
const render = (over: Partial<Props> = {}) =>
	renderToStaticMarkup(
		createElement(HostOutboxNotice, {
			supervisor: {
				id: "h1",
				status: "connected",
				enrollmentState: "active",
				heartbeatLeaseExpiresAt: iso(NOW + 60_000),
				capabilities: {
					features: ["offline_outbox"],
				} as unknown as SupervisorRecord["capabilities"],
				...over,
			},
			now: NOW,
		}),
	);

const outbox = (over: Partial<NonNullable<Props["outbox"]>> = {}) => ({
	pending: 0,
	oldestPendingAt: null,
	lastFlushAt: iso(NOW - 3_600_000),
	lastFlushDelivered: 0,
	lastFlushLost: 0,
	...over,
});

describe("HostOutboxNotice", () => {
	test("catching up: the sentence, an icon that screen readers skip, no amber", () => {
		const html = render({ outbox: outbox({ pending: 12 }) });
		expect(html).toContain("Catching up: sending 12 events saved while this host was offline.");
		expect(html).toContain('aria-hidden="true"');
		expect(html).not.toContain("amber");
	});

	test("recovered with lost events is amber; without, it isn't", () => {
		expect(render({ outbox: outbox({ lastFlushDelivered: 3, lastFlushLost: 1 }) })).toContain(
			"amber",
		);
		const calm = render({ outbox: outbox({ lastFlushDelivered: 3 }) });
		expect(calm).toContain("Sent 3 events saved while offline.");
		expect(calm).not.toContain("amber");
	});

	test("offline: the keep-and-send sentence", () => {
		expect(render({ heartbeatLeaseExpiresAt: iso(NOW - 1_000) })).toContain(
			"Offline. Events from its running sessions are kept on this host and sent when it reconnects.",
		);
	});

	test("the hidden status element is mounted with a notice and without one", () => {
		expect(render({ outbox: outbox({ pending: 2 }) })).toContain('<output class="sr-only">');
		const none = render();
		expect(none).toContain('<output class="sr-only"></output>');
		expect(none).not.toContain("Catching up");
	});

	test("a revoked host shows no notice but keeps the status element", () => {
		const html = render({ enrollmentState: "revoked", outbox: outbox({ pending: 5 }) });
		expect(html).not.toContain("Catching up");
		expect(html).toContain('<output class="sr-only">');
	});
});
