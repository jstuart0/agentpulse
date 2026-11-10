import { describe, expect, test } from "bun:test";
import benign from "./__fixtures__/redaction-benign.json";
import {
	fuzzCorpus,
	inShapes,
	redactionSamples,
	seededRandom,
} from "./__fixtures__/redaction-samples.js";
import {
	REDACTION_AFTER,
	REDACTION_BEFORE,
	REDACTION_CHUNK,
	REDACTION_MAX_EXTENSION,
	RUN_TOO_LONG_MARKER,
	type RedactionJobOptions,
	createRedactionJob,
	redact,
} from "./redactor.js";

function runJob(text: string, options?: RedactionJobOptions, maxUnits = 1_000_000) {
	const job = createRedactionJob(text, options);
	let steps = 0;
	let maxSliceUnits = 0;
	while (!job.done) {
		const r = job.step(1000, maxUnits);
		maxSliceUnits = Math.max(maxSliceUnits, r.units);
		steps++;
	}
	return { ...job.result(), steps, maxSliceUnits };
}

/** Text with `sample` starting `k` characters past the first multiple of `chunk` beyond `lead`. */
function straddle(sample: string, chunk: number, k: number, filler: string, lead = 2): string {
	const target = chunk * lead + k;
	let pre = "";
	while (pre.length < target) pre += filler;
	return `${pre.slice(0, target)}${sample} ${filler.repeat(40)}`;
}

describe("the sliced engine equals redact()", () => {
	test("a small text takes one window and equals redact()", () => {
		for (const text of benign.strings) {
			expect(runJob(text).text).toBe(redact(text).text);
		}
	});

	test("every family straddling every offset around a window edge, chunk 64 to 512", () => {
		let compared = 0;
		for (const sample of redactionSamples()) {
			for (const chunk of [64, 128, 256, 512]) {
				for (let k = -80; k <= 80; k += 1) {
					for (const filler of ["lorem ipsum ", "x"]) {
						const text = straddle(sample.text, chunk, k, filler);
						const expected = redact(text).text;
						// The default look-ahead, and a small one so growth at the edge is exercised.
						for (const after of [undefined, 300]) {
							const got = runJob(text, { chunk, after }).text;
							if (got !== expected) {
								throw new Error(
									`${sample.family} chunk ${chunk} after ${after} k ${k} filler ${JSON.stringify(filler)} differs`,
								);
							}
							compared++;
						}
					}
				}
			}
		}
		expect(compared).toBe(redactionSamples().length * 4 * 161 * 2 * 2);
	}, 120_000);

	test("secrets bigger than a window: a 4,000-character PEM body and a 6,000-character token", () => {
		const pem = `-----BEGIN PRIVATE KEY-----\n${"QUJD".repeat(1000)}\n-----END PRIVATE KEY-----`;
		const longToken = `sk-ant-${"A".repeat(6000)}`;
		for (const sample of [pem, longToken]) {
			for (const chunk of [64, 256, 1024]) {
				for (let k = -80; k <= 80; k += 7) {
					const text = straddle(sample, chunk, k, "word ");
					expect(runJob(text, { chunk }).text).toBe(redact(text).text);
				}
			}
		}
	});

	test("F4: a quoted env value over 1 KiB whose first space lies beyond the overlap", () => {
		const value = `${"a".repeat(1500)} tail words`;
		const sample = `API_TOKEN="${value}"`;
		for (const chunk of [64, 256, 512]) {
			for (let k = -80; k <= 80; k += 5) {
				const text = straddle(sample, chunk, k, "word ");
				const expected = redact(text).text;
				expect(expected).not.toContain("tail words");
				expect(runJob(text, { chunk }).text).toBe(expected);
			}
		}
	});

	test("a quoted env value whose closing quote is further past the edge than the first space", () => {
		const sample = `API_TOKEN="${"a".repeat(1500)} ${"b".repeat(600)}"`;
		for (const chunk of [64, 512]) {
			for (let k = -80; k <= 80; k += 3) {
				const text = straddle(sample, chunk, k, "word ");
				expect(runJob(text, { chunk, after: 1024 }).text).toBe(redact(text).text);
			}
		}
	});

	test("a key after a long blank run that does not open a member is not read as one", () => {
		// The window's edge must not look like a line start to the JSON rule's look-behind.
		const text = `x${" ".repeat(2000)}"password":"hunter2hunter2"`;
		const expected = redact(text).text;
		expect(expected).toContain("hunter2hunter2");
		for (const chunk of [64, 300, 1000]) expect(runJob(text, { chunk }).text).toBe(expected);
	});

	test("the blank-run look-behind is bounded, so whole-text and windowed output agree", () => {
		for (const blanks of [100, 400, 700]) {
			const text = `{${" ".repeat(blanks)}"password":"hunter2hunter2"}`;
			const expected = redact(text).text;
			for (const chunk of [64, 300, 1000]) expect(runJob(text, { chunk }).text).toBe(expected);
			expect(expected.includes("hunter2hunter2")).toBe(blanks > 500);
		}
	});

	test("a cookie line, a yaml value and a JSON value that run past a window", () => {
		const samples = [
			`Cookie: ${Array.from({ length: 80 }, (_, i) => `n${i}=v${i}`).join("; ")}`,
			`password: ${"b".repeat(3000)}`,
			`{"token":"${"c".repeat(3000)}"}`,
		];
		for (const sample of samples) {
			for (const chunk of [64, 200, 512]) {
				for (let k = -80; k <= 80; k += 9) {
					const text = `${straddle(sample, chunk, k, "word ").replace(/ /g, (m, i) => (i % 70 === 0 ? "\n" : m))}`;
					expect(runJob(text, { chunk }).text).toBe(redact(text).text);
				}
			}
		}
	});

	test("the fuzz corpus with random chunk sizes", () => {
		const rnd = seededRandom(99);
		const corpus = fuzzCorpus(3000, 5);
		for (const text of corpus) {
			const chunk = 16 + Math.floor(rnd() * 100);
			// Pad so most strings span several windows without changing what they hold.
			const padded = `${text}\n${"filler line\n".repeat(Math.floor(rnd() * 20))}${text}`;
			expect(runJob(padded, { chunk, after: 4096 }).text).toBe(redact(padded).text);
		}
	});

	test("every family in nine shapes, forced small windows", () => {
		for (const sample of redactionSamples()) {
			for (const text of inShapes(sample.text)) {
				expect(runJob(text, { chunk: 37 }).text).toBe(redact(text).text);
			}
		}
	});

	test("the default window sizes on a 200,000-character mixed text", () => {
		const parts: string[] = [];
		const samples = redactionSamples();
		for (let i = 0; parts.join("").length < 200_000; i++) {
			parts.push("function demo() { return 1; }\n".repeat(30));
			parts.push(`${samples[i % samples.length]?.text}\n`);
		}
		const text = parts.join("");
		expect(runJob(text).text).toBe(redact(text).text);
	});
});

describe("window limits", () => {
	test("the look-behind and look-ahead defaults are the documented ones", () => {
		expect(REDACTION_BEFORE).toBe(600);
		expect(REDACTION_AFTER).toBe(4096);
	});

	test("curl's 500-character look-behind straddling a window edge", () => {
		const text = `${"y".repeat(1000)}curl ${"z".repeat(470)} -u bob:hunter2pw https://example.test`;
		for (const chunk of [64, 256, 1000, 1030]) {
			expect(runJob(text, { chunk }).text).toBe(redact(text).text);
		}
	});

	test("F3: a 1 MiB single token costs bounded slices and is replaced by a marker", () => {
		const text = `before sk-ant-${"A".repeat(1 << 20)} after`;
		const r = runJob(text, undefined, 16 * 1024);
		expect(r.text).toContain(RUN_TOO_LONG_MARKER);
		expect(r.text).not.toContain("AAAAAAAA");
		expect(r.runsCut).toBeGreaterThan(0);
		// A slice is one window (16 KiB) or one rescan of a grown window: at most about 33 KiB.
		expect(r.maxSliceUnits).toBeLessThanOrEqual(
			REDACTION_MAX_EXTENSION + REDACTION_CHUNK + 2 * REDACTION_AFTER + REDACTION_BEFORE + 8,
		);
		expect(r.steps).toBeGreaterThan(3);
	});

	test("a job that is not finished refuses to hand out a result", () => {
		const job = createRedactionJob("x".repeat(100_000));
		expect(() => job.result()).toThrow();
	});

	test("an empty text finishes at once", () => {
		expect(runJob("").text).toBe("");
	});
});
