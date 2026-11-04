/**
 * The protocol gate (AGEN-87, D18): approvals are answered only for a Codex whose approval-relevant
 * schema has the shape this supervisor recorded, not by version. The shapes come from a stub generator
 * fed the committed Phase 0 subset; the real binary is checked only with CODEX_PROTOCOL_REAL=1.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BLOCKED_CODEX_VERSIONS,
	CODEX_VERSION_FLOOR,
	type CodexBinary,
	SUPPORTED_CODEX_SHAPES,
	type ShapeInputs,
	_resetProtocolCacheForTest,
	bindVerdictToUserAgent,
	codexProtocolVerdict,
	inputsFromCommittedSubset,
	inputsFromGeneratedDir,
	runSchemaGenerator,
	shapeHash,
	userAgentVersion,
} from "./codex-protocol.js";

const SCHEMA = join(import.meta.dir, "__fixtures__", "codex-0.163", "schema");
const LOOPBACK = "http://localhost:3000";
const binary = (version: string | null = "0.170.0"): CodexBinary => ({
	path: "/opt/fake/codex",
	version,
	size: 1,
	mtimeMs: 1,
});

let committed: ShapeInputs;
const clone = (): ShapeInputs => structuredClone(committed);

function counting(make: () => ShapeInputs | Promise<ShapeInputs> = clone) {
	const calls: CodexBinary[] = [];
	return {
		calls,
		generator: async (b: CodexBinary) => {
			calls.push(b);
			return await make();
		},
	};
}

beforeEach(async () => {
	_resetProtocolCacheForTest();
	committed = await inputsFromCommittedSubset(SCHEMA);
});

describe("the recorded shape", () => {
	test("the first SUPPORTED entry is the committed subset's, recomputed here rather than copied", () => {
		const recorded = JSON.parse(readFileSync(join(SCHEMA, "shape-hashes.json"), "utf8")).combined;
		expect(shapeHash(committed)).toBe(recorded);
		expect(SUPPORTED_CODEX_SHAPES[0].hash).toBe(recorded);
		expect(SUPPORTED_CODEX_SHAPES[0].measuredVersion).toBe("0.163.0");
	});

	test("the floor is 0.163 and nothing is blocked yet", () => {
		expect(CODEX_VERSION_FLOOR).toEqual({ major: 0, minor: 163 });
		expect(BLOCKED_CODEX_VERSIONS).toEqual([]);
	});

	test("key order doesn't change the hash, a description on a non-decision field is ignored", () => {
		const shuffled = clone();
		const params = shuffled.roots["CommandExecutionRequestApprovalParams.json"] as any;
		params.properties = Object.fromEntries(Object.entries(params.properties).reverse());
		params.properties.command.description = "reworded";
		expect(shapeHash(shuffled)).toBe(shapeHash(committed));
	});

	test("one enum value added to a decision enum changes it, and so does a decision enum's description", () => {
		const base = shapeHash(committed);
		const added = clone();
		const decision = (added.roots["CommandExecutionRequestApprovalResponse.json"] as any)
			.definitions.CommandExecutionApprovalDecision;
		decision.oneOf[0].enum.push("acceptForever");
		expect(shapeHash(added)).not.toBe(base);

		const reworded = clone();
		const def = (reworded.roots["CommandExecutionRequestApprovalResponse.json"] as any).definitions
			.CommandExecutionApprovalDecision;
		def.oneOf[0].description = "Approved, and also anything else you like.";
		expect(shapeHash(reworded)).not.toBe(base);
	});

	test("a missing schema file is an error, not a hash of nothing", () => {
		const { "FileChangeRequestApprovalParams.json": _dropped, ...roots } = clone().roots;
		expect(() => shapeHash({ roots, fileChangeItem: committed.fileChangeItem })).toThrow(/missing/);
	});
});

describe("the verdict", () => {
	test("a new version with the same subset is supported", async () => {
		const { generator } = counting();
		expect(await codexProtocolVerdict(binary("0.170.0"), LOOPBACK, { generator })).toEqual({
			verdict: "supported",
			reason: "ok",
		});
	});

	test("one enum change declines", async () => {
		const { generator } = counting(() => {
			const changed = clone();
			(
				changed.roots["FileChangeRequestApprovalResponse.json"] as any
			).definitions.FileChangeApprovalDecision.oneOf[0].enum.push("acceptAlways");
			return changed;
		});
		expect(await codexProtocolVerdict(binary(), LOOPBACK, { generator })).toEqual({
			verdict: "unsupported",
			reason: "shape_unknown",
		});
	});

	test("a description change on a non-decision field passes; on a decision enum it declines", async () => {
		const plain = counting(() => {
			const changed = clone();
			(
				changed.roots["CommandExecutionRequestApprovalParams.json"] as any
			).properties.cwd.description = "new words";
			return changed;
		});
		expect(
			(await codexProtocolVerdict(binary(), LOOPBACK, { generator: plain.generator })).verdict,
		).toBe("supported");
		_resetProtocolCacheForTest();
		const decision = counting(() => {
			const changed = clone();
			(
				changed.roots["CommandExecutionRequestApprovalResponse.json"] as any
			).definitions.CommandExecutionApprovalDecision.oneOf[0].description = "changed meaning";
			return changed;
		});
		expect(
			(await codexProtocolVerdict(binary(), LOOPBACK, { generator: decision.generator })).verdict,
		).toBe("unsupported");
	});

	test("a generator that fails, or never answers, declines and never throws", async () => {
		const failing = await codexProtocolVerdict(binary(), LOOPBACK, {
			generator: async () => {
				throw new Error("boom");
			},
		});
		expect(failing).toEqual({ verdict: "unsupported", reason: "generator_failed" });
		const hung = await codexProtocolVerdict(binary("0.171.0"), LOOPBACK, {
			generator: () => new Promise<ShapeInputs>(() => {}),
			generatorTimeoutMs: 30,
		});
		expect(hung).toEqual({ verdict: "unsupported", reason: "generator_failed" });
	});

	test("a failure isn't remembered: the next call tries again", async () => {
		let fail = true;
		const { generator, calls } = counting(() => {
			if (fail) throw new Error("transient");
			return clone();
		});
		expect((await codexProtocolVerdict(binary(), LOOPBACK, { generator })).verdict).toBe(
			"unsupported",
		);
		fail = false;
		expect((await codexProtocolVerdict(binary(), LOOPBACK, { generator })).verdict).toBe(
			"supported",
		);
		expect(calls).toHaveLength(2);
	});

	test("the shape is computed once per binary identity", async () => {
		const { generator, calls } = counting();
		await codexProtocolVerdict(binary(), LOOPBACK, { generator });
		await codexProtocolVerdict(binary(), LOOPBACK, { generator });
		expect(calls).toHaveLength(1);
		await codexProtocolVerdict({ ...binary(), mtimeMs: 2 }, LOOPBACK, { generator });
		expect(calls).toHaveLength(2);
	});

	test("a version below the floor declines without running the generator", async () => {
		const { generator, calls } = counting();
		for (const version of ["0.162.9", "0.100.0"]) {
			expect(await codexProtocolVerdict(binary(version), LOOPBACK, { generator })).toEqual({
				verdict: "unsupported",
				reason: "below_floor",
			});
		}
		expect((await codexProtocolVerdict(binary("0.163.0"), LOOPBACK, { generator })).verdict).toBe(
			"supported",
		);
		expect((await codexProtocolVerdict(binary("1.0.0"), LOOPBACK, { generator })).verdict).toBe(
			"supported",
		);
		expect(calls).toHaveLength(2);
	});

	test("a blocked version declines, and an unreadable one does too", async () => {
		const { generator, calls } = counting();
		expect(
			await codexProtocolVerdict(binary("0.170.0"), LOOPBACK, {
				generator,
				blockedVersions: ["0.170.0"],
			}),
		).toEqual({ verdict: "unsupported", reason: "blocked_version" });
		for (const version of [null, "", "garbage"]) {
			expect(await codexProtocolVerdict(binary(version), LOOPBACK, { generator })).toEqual({
				verdict: "unsupported",
				reason: "version_unknown",
			});
		}
		expect(calls).toHaveLength(0);
	});

	test("plain http to another machine is insecure_transport; https and loopback pass", async () => {
		const { generator } = counting();
		for (const url of [
			"http://ap.example.com",
			"http://192.0.2.5:3000",
			"ftp://x",
			"",
			"not a url",
		]) {
			expect((await codexProtocolVerdict(binary(), url, { generator })).verdict, url).toBe(
				"insecure_transport",
			);
		}
		for (const url of [
			"https://ap.example.com",
			"http://localhost:3000",
			"http://127.0.0.1:3000",
			"http://[::1]:3000",
		]) {
			expect((await codexProtocolVerdict(binary(), url, { generator })).verdict, url).toBe(
				"supported",
			);
		}
		expect((await codexProtocolVerdict(binary(), undefined, { generator })).verdict).toBe(
			"insecure_transport",
		);
	});
});

describe("binding the verdict to the process that answered", () => {
	const agent = (version: string) =>
		`agentpulse-supervisor/${version} (Mac OS 26.3.0; arm64) Termius (x; 0)`;

	test("the version is read from between the first / and the first space", () => {
		expect(userAgentVersion(agent("0.163.0"))).toBe("0.163.0");
		for (const bad of [
			undefined,
			null,
			5,
			"",
			"nothing",
			"x/ y",
			"x/not-a-version (z)",
			"x/1.2 (z)",
		]) {
			expect(userAgentVersion(bad), String(bad)).toBeNull();
		}
	});

	test("a matching version keeps the verdict and runs nothing", async () => {
		const { generator, calls } = counting();
		const first = await codexProtocolVerdict(binary("0.170.0"), LOOPBACK, { generator });
		const bound = await bindVerdictToUserAgent(
			first,
			binary("0.170.0"),
			LOOPBACK,
			agent("0.170.0"),
			{
				generator,
			},
		);
		expect(bound).toEqual(first);
		expect(calls).toHaveLength(1);
	});

	test("a mismatched version recomputes from a fresh run, and what that gives stands", async () => {
		const { generator, calls } = counting();
		const first = await codexProtocolVerdict(binary("0.170.0"), LOOPBACK, { generator });
		const bound = await bindVerdictToUserAgent(
			first,
			binary("0.170.0"),
			LOOPBACK,
			agent("0.171.0"),
			{
				generator,
			},
		);
		expect(bound.verdict).toBe("supported");
		expect(calls).toHaveLength(2);
		expect(calls[1].version).toBe("0.171.0");

		let fail = false;
		const flaky = counting(() => {
			if (fail) throw new Error("changed under us");
			return clone();
		});
		_resetProtocolCacheForTest();
		const ok = await codexProtocolVerdict(binary("0.170.0"), LOOPBACK, {
			generator: flaky.generator,
		});
		fail = true;
		expect(
			await bindVerdictToUserAgent(ok, binary("0.170.0"), LOOPBACK, agent("0.171.0"), {
				generator: flaky.generator,
			}),
		).toEqual({ verdict: "unsupported", reason: "generator_failed" });
	});

	test("a mismatch onto a version under the floor declines", async () => {
		const { generator } = counting();
		const first = await codexProtocolVerdict(binary("0.170.0"), LOOPBACK, { generator });
		expect(
			await bindVerdictToUserAgent(first, binary("0.170.0"), LOOPBACK, agent("0.100.0"), {
				generator,
			}),
		).toEqual({ verdict: "unsupported", reason: "below_floor" });
	});

	test("an unreadable userAgent is never supported", async () => {
		const { generator } = counting();
		const first = await codexProtocolVerdict(binary("0.170.0"), LOOPBACK, { generator });
		for (const ua of [undefined, 7, "", "no version here"]) {
			expect(
				await bindVerdictToUserAgent(first, binary("0.170.0"), LOOPBACK, ua, { generator }),
			).toEqual({
				verdict: "unsupported",
				reason: "useragent_unparseable",
			});
		}
	});
});

describe("the real binary", () => {
	test.skipIf(!process.env.CODEX_PROTOCOL_REAL)(
		"the installed codex generates the recorded shape",
		async () => {
			const exe =
				process.env.CODEX_PROTOCOL_REAL === "1" ? "codex" : process.env.CODEX_PROTOCOL_REAL;
			const inputs = await runSchemaGenerator({
				path: Bun.which(exe as string) ?? (exe as string),
				version: null,
				size: null,
				mtimeMs: null,
			});
			expect(shapeHash(inputs)).toBe(SUPPORTED_CODEX_SHAPES[0].hash);
			expect(typeof inputsFromGeneratedDir).toBe("function");
		},
		60_000,
	);
});
