import { describe, expect, test } from "bun:test";
import { bufferToVector, cosineSimilarity, vectorToBuffer } from "./types.js";

describe("cosineSimilarity", () => {
	test("identical vectors yield 1", () => {
		const v = Float32Array.from([0.6, 0.8, 0]);
		expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
	});

	test("opposite vectors yield -1", () => {
		const a = Float32Array.from([1, 0, 0]);
		const b = Float32Array.from([-1, 0, 0]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
	});

	test("orthogonal vectors yield 0", () => {
		const a = Float32Array.from([1, 0]);
		const b = Float32Array.from([0, 1]);
		expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
	});

	test("zero-magnitude vector returns 0 instead of NaN", () => {
		const a = Float32Array.from([0, 0, 0]);
		const b = Float32Array.from([1, 2, 3]);
		expect(cosineSimilarity(a, b)).toBe(0);
	});

	test("dimension mismatch throws", () => {
		const a = Float32Array.from([1, 0]);
		const b = Float32Array.from([1, 0, 0]);
		expect(() => cosineSimilarity(a, b)).toThrow(/length mismatch/);
	});
});

describe("vector buffer round-trip", () => {
	test("preserves values exactly", () => {
		const original = Float32Array.from([0.1, -0.5, 1.2345, -3.14182]);
		const buf = vectorToBuffer(original);
		const restored = bufferToVector(buf);
		expect(restored.length).toBe(original.length);
		for (let i = 0; i < original.length; i++) {
			expect(restored[i]).toBeCloseTo(original[i], 6);
		}
	});
});
