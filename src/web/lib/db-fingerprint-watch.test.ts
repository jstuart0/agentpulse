import { describe, expect, test } from "bun:test";
import { detectSplitDatabase } from "./db-fingerprint-watch.js";

const MIN = 60_000;

describe("detectSplitDatabase", () => {
	test("fewer than 2 observations → never detected", () => {
		expect(detectSplitDatabase([])).toBe(false);
		expect(detectSplitDatabase([{ fingerprint: "a", atMs: 0 }])).toBe(false);
	});

	test("the same fingerprint repeated forever → not detected", () => {
		expect(
			detectSplitDatabase([
				{ fingerprint: "a", atMs: 0 },
				{ fingerprint: "a", atMs: 10 * MIN },
				{ fingerprint: "a", atMs: 20 * MIN },
				{ fingerprint: "a", atMs: 30 * MIN },
			]),
		).toBe(false);
	});

	test("a single clean transition (A -> B), well-separated in time, is tolerated (server restart)", () => {
		expect(
			detectSplitDatabase([
				{ fingerprint: "a", atMs: 0 },
				{ fingerprint: "b", atMs: 60 * MIN },
			]),
		).toBe(false);
	});

	test("A -> B -> A alternation within the session is detected, even well-separated in time", () => {
		expect(
			detectSplitDatabase([
				{ fingerprint: "a", atMs: 0 },
				{ fingerprint: "b", atMs: 60 * MIN },
				{ fingerprint: "a", atMs: 120 * MIN },
			]),
		).toBe(true);
	});

	test("two different fingerprints observed within 5 minutes of each other is detected, even with no alternation", () => {
		expect(
			detectSplitDatabase([
				{ fingerprint: "a", atMs: 0 },
				{ fingerprint: "b", atMs: 4 * MIN },
			]),
		).toBe(true);
	});

	test("two different fingerprints more than 5 minutes apart, no alternation, is tolerated", () => {
		expect(
			detectSplitDatabase([
				{ fingerprint: "a", atMs: 0 },
				{ fingerprint: "b", atMs: 6 * MIN },
			]),
		).toBe(false);
	});

	test("exactly 5 minutes apart is still within the window (inclusive boundary)", () => {
		expect(
			detectSplitDatabase([
				{ fingerprint: "a", atMs: 0 },
				{ fingerprint: "b", atMs: 5 * MIN },
			]),
		).toBe(true);
	});

	test("three distinct fingerprints, monotonic, well-separated, no repeats → tolerated", () => {
		expect(
			detectSplitDatabase([
				{ fingerprint: "a", atMs: 0 },
				{ fingerprint: "b", atMs: 60 * MIN },
				{ fingerprint: "c", atMs: 120 * MIN },
			]),
		).toBe(false);
	});

	test("unordered input (out-of-order timestamps) is still detected correctly", () => {
		expect(
			detectSplitDatabase([
				{ fingerprint: "b", atMs: 60 * MIN },
				{ fingerprint: "a", atMs: 0 },
				{ fingerprint: "a", atMs: 120 * MIN },
			]),
		).toBe(true);
	});
});
