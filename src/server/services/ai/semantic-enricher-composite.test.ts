import { describe, expect, test } from "bun:test";
import {
	CompositeEnricher,
	type EnrichmentResult,
	type SemanticEnricher,
} from "./semantic-enricher.js";

class StubEnricher implements SemanticEnricher {
	readonly name = "llm-expansion" as const;
	constructor(private readonly result: EnrichmentResult) {}
	async enrich(): Promise<EnrichmentResult> {
		return this.result;
	}
}

class FailingEnricher implements SemanticEnricher {
	readonly name = "llm-expansion" as const;
	async enrich(): Promise<EnrichmentResult> {
		throw new Error("boom");
	}
}

describe("CompositeEnricher", () => {
	test("unions extraTerms and dedupes", async () => {
		const a = new StubEnricher({
			extraTerms: ["coupling", "decouple", "Refactor"],
			directHits: new Map(),
		});
		const b = new StubEnricher({
			extraTerms: ["refactor", "modular", "decouple"],
			directHits: new Map(),
		});
		const c = new CompositeEnricher([a, b]);
		const out = await c.enrich("anything");
		// Case-insensitive dedupe but original casing preserved.
		expect(new Set(out.extraTerms.map((t) => t.toLowerCase()))).toEqual(
			new Set(["coupling", "decouple", "refactor", "modular"]),
		);
	});

	test("merges directHits keeping the max score per session", async () => {
		const a = new StubEnricher({
			extraTerms: [],
			directHits: new Map([
				["s1", 0.4],
				["s2", 0.9],
			]),
		});
		const b = new StubEnricher({
			extraTerms: [],
			directHits: new Map([
				["s1", 0.7], // bigger — wins
				["s3", 0.2],
			]),
		});
		const c = new CompositeEnricher([a, b]);
		const out = await c.enrich("");
		expect(out.directHits.get("s1")).toBeCloseTo(0.7, 6);
		expect(out.directHits.get("s2")).toBeCloseTo(0.9, 6);
		expect(out.directHits.get("s3")).toBeCloseTo(0.2, 6);
	});

	test("a failing enricher doesn't poison the result", async () => {
		const ok = new StubEnricher({ extraTerms: ["a"], directHits: new Map([["s1", 0.5]]) });
		const c = new CompositeEnricher([ok, new FailingEnricher()]);
		const out = await c.enrich("");
		expect(out.extraTerms).toEqual(["a"]);
		expect(out.directHits.get("s1")).toBeCloseTo(0.5, 6);
	});
});
