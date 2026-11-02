/**
 * "Can't reach the server" appears once a probe has failed, not the moment some request does: with the
 * server answering and only one route failing it would flash for a second. In a real outage the first probe
 * (after 1 s) fails and the notice is up.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { retryDelayMs } from "../lib/network-retry.js";
import { noticeMessage } from "./ServerUnreachableNotice.js";

const off = { unreachable: false, attempt: 0, unconfirmed: false };

describe("noticeMessage", () => {
	test("a request failed but no probe has: nothing is shown", () => {
		expect(noticeMessage({ ...off, unreachable: true, attempt: 0 })).toBeNull();
	});

	test("once a probe has failed (a real outage) it says so", () => {
		expect(noticeMessage({ ...off, unreachable: true, attempt: 1 })).toBe(
			"Can't reach the server. Retrying…",
		);
		expect(noticeMessage({ ...off, unreachable: true, attempt: 5 })).toBe(
			"Can't reach the server. Retrying…",
		);
	});

	test("the first probe comes about a second after the first failure, so a real outage shows it within about two seconds", () => {
		expect(retryDelayMs(1)).toBeLessThanOrEqual(1_000);
	});

	test("nothing when the server is fine", () => {
		expect(noticeMessage(off)).toBeNull();
	});

	test("the sign-in notice is unchanged: shown at once, and it wins", () => {
		expect(noticeMessage({ ...off, unconfirmed: true })).toBe(
			"Can't confirm you're still signed in. Retrying…",
		);
		expect(noticeMessage({ unreachable: true, attempt: 3, unconfirmed: true })).toBe(
			"Can't confirm you're still signed in. Retrying…",
		);
	});

	test("the component shows exactly that message and still arms its retry from the first failure", () => {
		const source = readFileSync(join(import.meta.dir, "ServerUnreachableNotice.tsx"), "utf-8");
		expect(source).toContain("noticeMessage({ unreachable, attempt, unconfirmed })");
		expect(source).toMatch(/if \(!unreachable && !unconfirmed\) return;/);
	});
});
