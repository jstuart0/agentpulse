/**
 * What the phone is told about a watcher request and an Ask reply, beyond the ids:
 *  - `hitl_opened` carries `decision`: "continue" when approving would send a prompt,
 *    "ask" when it is a question with nothing to send;
 *  - `ask_reply` carries the thread's `title` (only to a device that shows content, and
 *    redacted like every other label) and `proposalCount`.
 * The sealed plaintext stays within its byte limit with the worst-case title; if a title
 * ever doesn't fit it is the title that gives way, before the session name.
 */
import { describe, expect, test } from "bun:test";
import { hitlOpenedEvent } from "../ai/runner.js";
import { MAX_PLAINTEXT_BYTES, fitPayload } from "./hpke-seal.js";
import type { PushPayload } from "./hpke-seal.js";
import { MAX_TITLE_CHARS, PushPayloadSchema, buildPushPayload } from "./push-payload.js";
import type { DevicePrefs, PushDevice, PushEvent } from "./types.js";

const ID64 = "a".repeat(64);

function device(prefs: DevicePrefs = {}): PushDevice {
	return {
		id: "dev-1",
		userId: "user-1",
		platform: "ios",
		relayDeviceId: "relay-device-0123456789",
		ownerlessKeyId: null,
		sendTokenCiphertext: "ciphertext",
		kid: ID64,
		publicKey: "unused",
		clientServerRef: ID64,
		prefs,
	};
}

function build(event: PushEvent, prefs: DevicePrefs = {}, redact = (text: string) => text) {
	const out = buildPushPayload({
		event,
		device: device(prefs),
		pushId: ID64,
		nowMs: 1_800_000_000_000,
		redact,
		level: "active",
	});
	if (!out.ok) throw new Error(`payload not built: ${out.reason}`);
	return out.payload;
}

const askReply = (extra: Record<string, unknown> = {}): PushEvent =>
	({
		type: "ask_reply",
		threadId: ID64,
		assistantMessageId: ID64,
		requesterUserId: "user-1",
		requesterKeyId: null,
		...extra,
	}) as PushEvent;

const bytes = (payload: unknown) => new TextEncoder().encode(JSON.stringify(payload)).length;

describe("hitl_opened carries the decision kind", () => {
	test("a request with a prompt to send is `continue`, and carries its hash", () => {
		const event = hitlOpenedEvent("s1", "h1", "p1", "run the tests");
		expect(event.decision).toBe("continue");
		expect(event.promptHash).toMatch(/^[0-9a-f]{64}$/);
		expect(build(event).decision).toBe("continue");
	});

	test("a request with nothing to send is `ask`, with no hash", () => {
		for (const nextPrompt of [null, ""]) {
			const event = hitlOpenedEvent("s1", "h1", "p1", nextPrompt);
			expect(event.decision).toBe("ask");
			expect("promptHash" in event).toBe(false);
			const payload = build(event);
			expect(payload.decision).toBe("ask");
			expect("promptHash" in payload).toBe(false);
		}
	});

	test("the payload still validates, and other events carry no decision", () => {
		const hitl = build(hitlOpenedEvent("s1", "h1", "p1", "go"));
		expect(PushPayloadSchema.safeParse(hitl).success).toBe(true);
		const other = build({ type: "turn_completed", sessionId: "s1" });
		expect("decision" in other).toBe(false);
	});

	test("the schema's decision enum is exactly continue and ask, and the payload version is still 1 (no bump: no phone has shipped)", () => {
		expect(PushPayloadSchema.shape.decision.unwrap().options).toEqual(["continue", "ask"]);
		expect(PushPayloadSchema.shape.v.value).toBe(1);
		expect(build(hitlOpenedEvent("s1", "h1", "p1", "go")).v).toBe(1);
	});

	test("a value outside continue|ask is not accepted by the schema", () => {
		const good = build(hitlOpenedEvent("s1", "h1", "p1", "go"));
		expect(PushPayloadSchema.safeParse({ ...good, decision: "approve" }).success).toBe(false);
	});
});

describe("ask_reply carries the thread title and the proposal count", () => {
	test("both are in the payload, and it validates", () => {
		const payload = build(askReply({ title: "What is blocking the auth work?", proposalCount: 2 }));
		expect(payload.title).toBe("What is blocking the auth work?");
		expect(payload.proposalCount).toBe(2);
		expect(PushPayloadSchema.safeParse(payload).success).toBe(true);
	});

	test("a reply with no title and no count says neither", () => {
		for (const event of [askReply({ title: null }), askReply()]) {
			const payload = build(event);
			expect("title" in payload).toBe(false);
			expect("proposalCount" in payload).toBe(false);
		}
	});

	test("zero proposals is a count, not an absence", () => {
		expect(build(askReply({ proposalCount: 0 })).proposalCount).toBe(0);
	});

	test("a device that doesn't show content gets the count and not the title", () => {
		const payload = build(askReply({ title: "private question", proposalCount: 1 }), {
			showContent: false,
		});
		expect("title" in payload).toBe(false);
		expect(payload.proposalCount).toBe(1);
	});

	test("the title goes through the redactor", () => {
		const payload = build(askReply({ title: "use key sk-abcdef0123456789 please" }), {}, (text) =>
			text.replace(/sk-[a-z0-9]+/g, "[REDACTED]"),
		);
		expect(payload.title).toBe("use key [REDACTED] please");
	});

	test("a title is cut to 80 whole characters, never through a surrogate pair", () => {
		const payload = build(askReply({ title: "🚀".repeat(200) }));
		expect(Array.from(payload.title ?? "")).toHaveLength(MAX_TITLE_CHARS);
		expect(Array.from(payload.title ?? "").every((c) => c === "🚀")).toBe(true);
	});

	test("the count is clamped, not refused", () => {
		expect(build(askReply({ proposalCount: 5_000_000 })).proposalCount).toBe(1_000);
		expect("proposalCount" in build(askReply({ proposalCount: Number.NaN }))).toBe(false);
	});

	test("an ask_reply member on any other event is never sent", () => {
		const payload = build({ type: "turn_completed", sessionId: "s1", title: "x" } as never);
		expect("title" in payload).toBe(false);
	});
});

describe("the sealed size", () => {
	test("the worst-case ask_reply (64-character ids everywhere, an 80-emoji title, a full count) fits with room to spare", () => {
		const payload = build(askReply({ title: "🚀".repeat(200), proposalCount: 1_000 }));
		const size = bytes(payload);
		console.log(`[budget] worst-case ask_reply plaintext: ${size} B of ${MAX_PLAINTEXT_BYTES}`);
		expect(size).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES);
		expect(size).toBeLessThan(MAX_PLAINTEXT_BYTES / 2);
		const fitted = fitPayload(payload);
		expect(fitted.trimmed).toEqual([]);
		expect(fitted.payload).toEqual(payload);
	});

	test("the worst-case hitl_opened, with a session name and agent text, still fits", () => {
		const payload = build(
			{
				...hitlOpenedEvent("s".repeat(128), ID64, ID64, "go"),
				sessionName: "n".repeat(200),
				agent: "a".repeat(64),
				machine: "m".repeat(128),
				text: "t".repeat(180),
			} as PushEvent,
			{ includeAgentText: true },
		);
		const size = bytes(payload);
		console.log(`[budget] worst-case hitl_opened plaintext: ${size} B of ${MAX_PLAINTEXT_BYTES}`);
		expect(size).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES);
		expect(fitPayload(payload).trimmed).toEqual([]);
	});

	test("if a title ever doesn't fit, it is cut before the session name, and only as far as needed", () => {
		const base = build(askReply({ title: "t".repeat(80), proposalCount: 3 })) as PushPayload;
		const crowded: PushPayload = { ...base, sname: "n".repeat(2_200) };
		expect(bytes(crowded)).toBeGreaterThan(MAX_PLAINTEXT_BYTES);
		const fitted = fitPayload(crowded);
		expect(fitted.trimmed[0]).toBe("title");
		expect(bytes(fitted.payload)).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES);
		// The title is cut first and as little as possible: one more character wouldn't have fit.
		if (fitted.payload.title !== undefined) {
			expect(bytes({ ...fitted.payload, title: `${fitted.payload.title}t` })).toBeGreaterThan(
				MAX_PLAINTEXT_BYTES,
			);
		}
		expect(fitted.payload.proposalCount).toBe(3);
	});
});
