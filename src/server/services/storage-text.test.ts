import { describe, expect, test } from "bun:test";
import {
	STORAGE_NUL_MARKER,
	boundedWellFormedValue,
	cutText,
	cutTextTail,
	wellFormedText,
} from "./storage-text.js";

const NUL = "\u0000";

describe("wellFormedText", () => {
	test("NUL becomes the marker, one unit for one", () => {
		expect(wellFormedText(`a${NUL}b`)).toBe("a␀b");
		expect(STORAGE_NUL_MARKER).toBe("␀");
		expect(wellFormedText(NUL.repeat(3))).toBe("␀␀␀");
	});

	test("a lone surrogate becomes U+FFFD; a pair is untouched", () => {
		expect(wellFormedText("a\udc00")).toBe("a�");
		expect(wellFormedText("\ud800b")).toBe("�b");
		const emoji = "x\u{1F600}y";
		expect(wellFormedText(emoji)).toBe(emoji);
	});

	test("clean text is the same reference; the rule is idempotent", () => {
		const clean = "plain \u{1F600} text";
		expect(wellFormedText(clean)).toBe(clean);
		const fixed = wellFormedText(`${NUL}\ud800`);
		expect(wellFormedText(fixed)).toBe(fixed);
		expect(fixed.length).toBe(2);
	});

	test("timing: a clean 16 MiB string and 1 M NULs stay cheap", () => {
		const big = "x".repeat(16 * 1024 * 1024);
		let start = performance.now();
		expect(wellFormedText(big)).toBe(big);
		expect(performance.now() - start).toBeLessThan(100);
		const nuls = NUL.repeat(1_000_000);
		start = performance.now();
		const out = wellFormedText(nuls);
		expect(performance.now() - start).toBeLessThan(250);
		expect(out.length).toBe(1_000_000);
	});
});

describe("cutText", () => {
	test("never ends on a high surrogate", () => {
		expect(cutText("x\u{1F600}", 2)).toBe("x");
		expect(cutText("x\u{1F600}", 3)).toBe("x\u{1F600}");
		expect(cutText("abc", 10)).toBe("abc");
		expect(cutText("abc", 2)).toBe("ab");
	});
});

describe("cutTextTail", () => {
	test("never starts on a low surrogate", () => {
		expect(cutTextTail("\u{1F600}x", 2)).toBe("x");
		expect(cutTextTail("a\u{1F600}x", 3)).toBe("\u{1F600}x");
		expect(cutTextTail("abc", 10)).toBe("abc");
	});
});

describe("boundedWellFormedValue", () => {
	test("fixes strings and keys, keeps order, copies only what changed", () => {
		const clean = { a: "x", b: [1, "y", { c: null }] };
		expect(boundedWellFormedValue(clean)).toBe(clean);
		const dirty = { "k\u0000": "v\ud800", keep: { n: 1 }, list: ["a\u0000"] };
		const out = boundedWellFormedValue(dirty);
		expect(Object.keys(out)).toEqual(["k␀", "keep", "list"]);
		expect(out["k␀" as keyof typeof out]).toBe("v�");
		expect(out.keep).toBe(dirty.keep);
		expect(out.list).toEqual(["a␀"]);
		expect(dirty["k\u0000"]).toBe("v\ud800");
	});

	test("an own __proto__ key stays data", () => {
		const source = JSON.parse('{"__proto__": {"x": "a\\u0000"}}');
		const out = boundedWellFormedValue(source) as Record<string, unknown>;
		expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
		expect(Object.keys(out)).toEqual(["__proto__"]);
		expect(JSON.stringify(out)).toBe('{"__proto__":{"x":"a␀"}}');
	});

	test("a subtree deeper than 64 becomes a marker", () => {
		let deep: Record<string, unknown> = { leaf: "x" };
		for (let i = 0; i < 70; i++) deep = { n: deep };
		const out = boundedWellFormedValue(deep) as Record<string, unknown>;
		let node: unknown = out;
		let depth = 0;
		while (typeof node === "object" && node !== null) {
			node = (node as Record<string, unknown>).n;
			depth++;
		}
		expect(node).toBe("[STORAGE:too_deep]");
		expect(depth).toBe(64);
	});

	test("a flat array of a million scalars hits the node bound", () => {
		const flat = Array.from({ length: 1_000_000 }, (_, i) => i);
		const out = boundedWellFormedValue(flat) as unknown[];
		expect(out).toHaveLength(1_000_000);
		expect(out[0]).toBe(0);
		expect(out[199_998]).toBe(199_998);
		expect(out[199_999]).toBe("[STORAGE:too_large]");
		expect(out[999_999]).toBe("[STORAGE:too_large]");
		const flatObject = boundedWellFormedValue({ a: "x", b: 1, c: null }, { maxNodes: 3 }) as Record<
			string,
			unknown
		>;
		expect(flatObject.c).toBe("[STORAGE:too_large]");
	});

	test("past the node bound the rest becomes a marker", () => {
		const out = boundedWellFormedValue([{}, {}, {}, {}], { maxNodes: 4 }) as unknown[];
		expect(out[2]).toEqual({});
		expect(out[3]).toBe("[STORAGE:too_large]");
	});

	test("timing: a clean 200k-node object stays cheap", () => {
		const o: Record<string, unknown> = {};
		for (let i = 0; i < 20_000; i++) o[`key${i}`] = { a: `hello ${i}`, b: [1, "x", { c: "d" }] };
		const start = performance.now();
		expect(boundedWellFormedValue(o)).toBe(o);
		expect(performance.now() - start).toBeLessThan(250);
	});
});
