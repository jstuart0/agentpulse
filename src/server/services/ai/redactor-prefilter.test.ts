import { describe, expect, test } from "bun:test";
import benign from "./__fixtures__/redaction-benign.json";
import { fuzzCorpus, inShapes, redactionSamples } from "./__fixtures__/redaction-samples.js";
import { DEFAULT_RULES, redact } from "./redactor.js";

/** The loop `redact()` ran before the gates existed: every rule, every pass. */
function redactUngated(input: string): string {
	let text = input;
	for (const rule of DEFAULT_RULES) {
		rule.pattern.lastIndex = 0;
		text = text.replace(rule.pattern, (match) =>
			typeof rule.replacement === "function" ? rule.replacement(match) : rule.replacement,
		);
	}
	return text;
}

const lowerOf = (t: string) => () => t.toLowerCase();

describe("rule gates", () => {
	test("every built-in rule has a gate", () => {
		const missing = DEFAULT_RULES.filter((r) => !r.gate).map((r) => r.name);
		expect(missing).toEqual([]);
	});

	test("gated redact() equals the ungated loop on the benign corpus", () => {
		for (const text of benign.strings) {
			expect(redact(text).text).toBe(redactUngated(text));
			expect(redact(text).text).toBe(text);
		}
	});

	test("gated redact() equals the ungated loop for every family in nine shapes", () => {
		let compared = 0;
		for (const sample of redactionSamples()) {
			inShapes(sample.text).forEach((text, shape) => {
				const gated = redact(text).text;
				expect(gated).toBe(redactUngated(text));
				// Line-anchored rules (yaml, cookie, curl) don't apply mid-line by design; the
				// secret must be gone wherever the rule's own context holds.
				if ([0, 2, 3].includes(shape)) expect(gated).not.toContain(sample.secret);
				compared++;
			});
		}
		expect(compared).toBe(redactionSamples().length * 9);
	});

	test("gated redact() equals the ungated loop on a 3,000-string token-soup fuzz", () => {
		const corpus = fuzzCorpus(3000, 7);
		expect(corpus.length).toBe(3000);
		for (const text of corpus) expect(redact(text).text).toBe(redactUngated(text));
	});

	test("a gate is a necessary condition: where the pattern matches, the gate is true", () => {
		const texts = [
			...fuzzCorpus(3000, 11),
			...redactionSamples().flatMap((s) => inShapes(s.text)),
			...benign.strings,
		];
		const matchedRules = new Set<string>();
		for (const text of texts) {
			for (const rule of DEFAULT_RULES) {
				rule.pattern.lastIndex = 0;
				if (rule.pattern.test(text)) {
					matchedRules.add(rule.name);
					expect(rule.gate?.(text, lowerOf(text))).toBe(true);
				}
				rule.pattern.lastIndex = 0;
			}
		}
		// Every rule must have been exercised, or the property says nothing about it.
		expect([...matchedRules].sort()).toEqual(DEFAULT_RULES.map((r) => r.name).sort());
	});

	test("a replacement from an earlier rule never hides an anchor from a later one", () => {
		// The url rule's output contains `://`, `@` and `[REDACTED]`; the json rule needs a key
		// only the earlier text supplies.
		const text = `{"to": "https://u:pw12345@host.test/", "password":"hunter2hunter2"}`;
		expect(redact(text).text).toBe(redactUngated(text));
		expect(redact(text).text).not.toContain("hunter2hunter2");
	});

	test("user rules stay ungated", () => {
		const out = redact("plain text with xyzzy inside", [
			{ name: "x", pattern: /xyzzy/g, replacement: "[X]" },
		]);
		expect(out.text).toBe("plain text with [X] inside");
	});
});
