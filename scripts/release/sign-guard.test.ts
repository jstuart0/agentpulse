import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	NOW,
	TEST_KEYS,
	TEST_KEY_LIST,
	pkcs8Pem,
	testPayload,
} from "../../src/shared/__fixtures__/release-test-signer.ts";
import { encodeEnvelope, verifyManifest } from "../../src/shared/release-manifest.ts";
import { createFixtureRepo } from "./fixture-repo.ts";
import { checkPayloadForSigning, computeSeq } from "./sign-guard.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const REPO_NAME = "acme/agentpulse";
const cleanup: string[] = [];
afterAll(() => {
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
});

describe("computeSeq", () => {
	test("equals git rev-list --count and rises with each merge", () => {
		const repo = createFixtureRepo();
		cleanup.push(repo.dir);
		repo.commit({ a: "1" });
		repo.commit({ a: "2" });
		const third = repo.commit({ a: "3" });
		expect(computeSeq(repo.dir, third)).toBe(3);
		expect(computeSeq(repo.dir, third)).toBe(Number(repo.git("rev-list", "--count", third)));
		const fourth = repo.commit({ a: "4" });
		expect(computeSeq(repo.dir, fourth)).toBeGreaterThan(computeSeq(repo.dir, third));
	});
});

describe("checkPayloadForSigning", () => {
	const sha = "b".repeat(40);
	const fresh = {
		sourceCommit: sha,
		issuedAt: new Date(NOW - 60_000).toISOString(),
		expiresAt: new Date(NOW - 60_000 + 10 * 86_400_000).toISOString(),
	};
	const ok = (over: Record<string, unknown> = {}) =>
		checkPayloadForSigning({ ...testPayload(fresh), ...over }, { githubSha: sha, now: NOW });

	test("accepts a good payload", () => {
		expect(ok()).toEqual({ ok: true });
	});

	const bad: [string, Record<string, unknown>][] = [
		["schema 2", { schema: 2 }],
		["a sourceCommit one commit behind", { sourceCommit: "c".repeat(40) }],
		["seq 0", { seq: 0 }],
		["seq 1.5", { seq: 1.5 }],
		["expiresAt 9 days on", { expiresAt: new Date(NOW - 60_000 + 9 * 86_400_000).toISOString() }],
		["expiresAt 11 days on", { expiresAt: new Date(NOW - 60_000 + 11 * 86_400_000).toISOString() }],
		[
			"issuedAt an hour old",
			{ issuedAt: "2026-11-19T10:50:00.000Z", expiresAt: "2026-11-29T10:50:00.000Z" },
		],
		[
			"issuedAt in the future",
			{ issuedAt: "2026-11-19T12:30:00.000Z", expiresAt: "2026-11-29T12:30:00.000Z" },
		],
		["latest not in releases", { latest: "9.9.9" }],
		["31 releases", { releases: Array.from({ length: 31 }, () => testPayload().releases[0]) }],
		["revokedKeyIds not an array", { revokedKeyIds: "x" }],
	];
	for (const [name, over] of bad) {
		test(`refuses ${name}`, () => {
			const r = ok(over);
			expect(r.ok).toBe(false);
		});
	}
});

// ---- the `sign` job's own shell, extracted from pages.yml and run against a fixture repo ----

interface Step {
	id?: string;
	if?: string;
	run?: string;
	env?: Record<string, string>;
	uses?: string;
}

function signSteps(): Step[] {
	const workflow = Bun.YAML.parse(
		readFileSync(join(REPO_ROOT, ".github/workflows/pages.yml"), "utf-8"),
	) as {
		jobs?: Record<string, { steps?: Step[] }>;
	};
	const steps = workflow.jobs?.sign?.steps;
	expect(steps, "pages.yml has a sign job with steps").toBeDefined();
	return steps as Step[];
}

interface Scenario {
	githubSha: string;
	ref?: string;
	payload: unknown;
	key?: string;
	/** What `git ls-remote` of the repo's main reports. */
	origin: string;
}

interface Outcome {
	steps: { id: string; ran: boolean; status: number | null; stdout: string; stderr: string }[];
	outputs: Record<string, Record<string, string>>;
	ghCalls: string[];
	work: string;
}

function runSign(scenario: Scenario): Outcome {
	const work = mkdtempSync(join(tmpdir(), "ap-sign-"));
	cleanup.push(work);
	const bin = join(work, "bin");
	const runnerTemp = join(work, "runner-temp");
	mkdirSync(bin);
	mkdirSync(runnerTemp);
	const ghLog = join(work, "gh.log");
	writeFileSync(ghLog, "");
	writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> '${ghLog}'\n`);
	chmodSync(join(bin, "gh"), 0o755);

	const payloadBytes = new TextEncoder().encode(
		typeof scenario.payload === "string" ? scenario.payload : JSON.stringify(scenario.payload),
	);
	const expressions: Record<string, string> = {
		"github.ref": scenario.ref ?? "refs/heads/main",
		"github.sha": scenario.githubSha,
		"github.repository": REPO_NAME,
		"github.token": "test-token",
		"needs.manifest.outputs.payload": Buffer.from(payloadBytes).toString("base64url"),
		"secrets.AGENTPULSE_RELEASE_SIGNING_KEY": scenario.key ?? pkcs8Pem("active"),
	};
	const steps = signSteps();
	const outputs: Outcome["outputs"] = {};
	const result: Outcome["steps"] = [];
	for (const [index, step] of steps.entries()) {
		if (!step.run) continue;
		const id = step.id ?? `step${index}`;
		if (step.if) {
			const m = /^\$?\{?\{?\s*steps\.(\w+)\.outputs\.(\w+) == '([^']*)'\s*\}?\}?$/.exec(
				step.if.trim(),
			);
			expect(m, `unsupported if: ${step.if}`).not.toBeNull();
			const [, stepId, name, want] = m as RegExpExecArray;
			if (outputs[stepId as string]?.[name as string] !== want) {
				result.push({ id, ran: false, status: null, stdout: "", stderr: "" });
				continue;
			}
		}
		const env: Record<string, string> = {
			PATH: `${bin}:${process.env.PATH}`,
			HOME: work,
			RUNNER_TEMP: runnerTemp,
			GITHUB_OUTPUT: join(work, `out-${id}`),
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: `url.${scenario.origin}.insteadOf`,
			GIT_CONFIG_VALUE_0: `https://github.com/${REPO_NAME}`,
		};
		writeFileSync(env.GITHUB_OUTPUT as string, "");
		for (const [name, raw] of Object.entries(step.env ?? {})) {
			env[name] = String(raw).replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr: string) => {
				expect(expressions[expr], `unmapped expression in env: ${expr}`).toBeDefined();
				return expressions[expr] as string;
			});
		}
		const script = join(work, `${id}.sh`);
		writeFileSync(script, step.run);
		const proc = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", script], {
			cwd: work,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		outputs[id] = Object.fromEntries(
			readFileSync(env.GITHUB_OUTPUT as string, "utf-8")
				.split("\n")
				.filter((l) => l.includes("="))
				.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
		);
		result.push({
			id,
			ran: true,
			status: proc.exitCode,
			stdout: proc.stdout.toString(),
			stderr: proc.stderr.toString(),
		});
		if (proc.exitCode !== 0) break;
	}
	return {
		steps: result,
		outputs,
		ghCalls: readFileSync(ghLog, "utf-8").split("\n").filter(Boolean),
		work,
	};
}

function mainRepo() {
	const repo = createFixtureRepo();
	cleanup.push(repo.dir);
	const first = repo.commit({ a: "1" });
	const second = repo.commit({ a: "2" });
	const tip = repo.commit({ a: "3" });
	repo.pushMain();
	return { repo, first, second, tip };
}

/** A payload shaped for the real clock, since the shell reads `date`. */
function livePayload(sourceCommit: string, over: Record<string, unknown> = {}) {
	const issued = Date.now();
	return {
		...testPayload({
			sourceCommit,
			issuedAt: new Date(issued).toISOString(),
			expiresAt: new Date(issued + 10 * 86_400_000).toISOString(),
		}),
		...over,
	};
}

describe("the sign job's shell (extracted from pages.yml)", () => {
	test("(a) signs when GITHUB_SHA is the main tip and sourceCommit matches; WebCrypto verifies the result", async () => {
		const { repo, tip } = mainRepo();
		const payload = livePayload(tip);
		const out = runSign({ githubSha: tip, payload, origin: repo.origin });
		expect(out.steps.map((s) => s.status)).toEqual([0, 0]);
		const signed = out.outputs[out.steps[1]?.id as string] ?? {};
		expect(signed.signed).toBe("true");
		expect(signed.key_id).toBe(TEST_KEYS.active.keyId);
		expect(signed.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
		expect(out.ghCalls).toEqual([]);
		const bytes = new TextEncoder().encode(JSON.stringify(payload));
		const envelope = encodeEnvelope(
			signed.key_id as string,
			bytes,
			new Uint8Array(Buffer.from(signed.sig as string, "base64url")),
		);
		const verdict = await verifyManifest(envelope, {
			keys: TEST_KEY_LIST,
			revoked: new Set(),
			now: Date.now(),
			last: null,
		});
		expect(verdict.ok).toBe(true);
	});

	test("(b) when GITHUB_SHA is an older commit, signs nothing, dispatches pages.yml on main once and exits 0", () => {
		const { repo, second, tip } = mainRepo();
		const out = runSign({ githubSha: second, payload: livePayload(second), origin: repo.origin });
		expect(out.steps.map((s) => s.status)).toEqual([0, null]);
		expect(out.steps[0]?.stdout).toContain(`superseded by ${tip}`);
		expect(out.ghCalls).toHaveLength(1);
		expect(out.ghCalls[0]).toContain("workflow run pages.yml");
		expect(out.ghCalls[0]).toContain("--ref main");
		expect(Object.values(out.outputs).some((o) => o.signed === "true")).toBe(false);
	});

	test("(c) refuses a ref other than refs/heads/main, and never dispatches or signs", () => {
		const { repo, tip } = mainRepo();
		for (const ref of ["refs/heads/dev", "refs/tags/v0.12.0", "refs/pull/1/merge", ""]) {
			const out = runSign({ githubSha: tip, ref, payload: livePayload(tip), origin: repo.origin });
			expect(out.steps[0]?.status, ref).not.toBe(0);
			expect(out.steps.length, ref).toBe(1);
			expect(out.ghCalls, ref).toEqual([]);
		}
	});

	describe("(d) refuses a payload that fails the jq checks", () => {
		const cases: [string, (tip: string, second: string) => unknown][] = [
			["sourceCommit one commit behind (named member)", (_tip, second) => livePayload(second)],
			[
				"expiresAt not 10 days on",
				(tip) =>
					livePayload(tip, { expiresAt: new Date(Date.now() + 9 * 86_400_000).toISOString() }),
			],
			["latest not in releases", (tip) => livePayload(tip, { latest: "9.9.9" })],
			[
				"issuedAt an hour old",
				(tip) =>
					livePayload(tip, {
						issuedAt: new Date(Date.now() - 3_600_000).toISOString(),
						expiresAt: new Date(Date.now() + 10 * 86_400_000 - 3_600_000).toISOString(),
					}),
			],
			[
				"31 releases",
				(tip) =>
					livePayload(tip, {
						releases: Array.from({ length: 31 }, () => testPayload().releases[0]),
					}),
			],
			["seq 0", (tip) => livePayload(tip, { seq: 0 })],
			["not JSON", () => "this is not json"],
		];
		for (const [name, make] of cases) {
			test(name, () => {
				const { repo, second, tip } = mainRepo();
				const out = runSign({ githubSha: tip, payload: make(tip, second), origin: repo.origin });
				expect(out.steps[0]?.status).not.toBe(0);
				expect(out.steps.some((s) => s.id && out.outputs[s.id]?.signed === "true")).toBe(false);
				expect(out.ghCalls).toEqual([]);
			});
		}
	});
});
