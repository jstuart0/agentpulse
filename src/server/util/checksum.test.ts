import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { computeChecksum } from "./checksum.js";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("computeChecksum", () => {
	test("default form is the first 16 hex characters (the /health `clients` form)", async () => {
		const out = await computeChecksum("hello");
		expect(out).toBe(sha256("hello").slice(0, 16));
		expect(out).toHaveLength(16);
	});

	test("{ length: 'full' } is the whole 64-hex digest, and its 16-hex prefix is the default form", async () => {
		const full = await computeChecksum("hello", { length: "full" });
		expect(full).toBe(sha256("hello"));
		expect(full).toHaveLength(64);
		expect(full.startsWith(await computeChecksum("hello"))).toBe(true);
	});

	test("trimEnd combines with the full length and ignores trailing newlines only", async () => {
		expect(await computeChecksum("a\n\n", { trimEnd: true, length: "full" })).toBe(sha256("a"));
		expect(await computeChecksum("a\n\n", { length: "full" })).toBe(sha256("a\n\n"));
		expect(await computeChecksum(" a", { trimEnd: true })).toBe(sha256(" a").slice(0, 16));
	});

	test("an explicit short length is the default form", async () => {
		const out = await computeChecksum("x", { length: "short" });
		expect(out).toHaveLength(16);
	});
});
