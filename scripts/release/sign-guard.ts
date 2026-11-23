#!/usr/bin/env bun
/**
 * The rules a payload must pass before anything signs it, in TypeScript. The `manifest` job in pages.yml
 * runs this on its own output, so a bad payload fails in the job that has bun. The `sign` job then
 * re-checks the same rules in shell with `jq` (it has no checkout and no bun), so neither check is the
 * only one. `computeSeq` is the monotonic counter in the payload.
 *
 * CLI: `bun scripts/release/sign-guard.ts check <payload.json>` with GITHUB_SHA in the environment.
 */
import { readFileSync } from "node:fs";

const TEN_DAYS_MS = 10 * 86_400_000;
const CLOCK_SKEW_MS = 10 * 60_000;
const MAX_RELEASES = 30;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** The number of commits reachable from `commit`: monotonic along a protected main. */
export function computeSeq(repoDir: string, commit: string): number {
	const proc = Bun.spawnSync(["git", "rev-list", "--count", commit], {
		cwd: repoDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode !== 0) throw new Error(`git rev-list failed: ${proc.stderr.toString().trim()}`);
	const seq = Number(proc.stdout.toString().trim());
	if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("git rev-list gave no commit count");
	return seq;
}

export type GuardResult = { ok: true } | { ok: false; reason: string };

const refuse = (reason: string): GuardResult => ({ ok: false, reason });

function time(value: unknown): number | null {
	return typeof value === "string" && ISO_TIME.test(value) && Number.isFinite(Date.parse(value))
		? Date.parse(value)
		: null;
}

export function checkPayloadForSigning(
	payload: unknown,
	ctx: { githubSha: string; now: number },
): GuardResult {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		return refuse("payload is not an object");
	}
	const p = payload as Record<string, unknown>;
	if (p.schema !== 1) return refuse("schema is not 1");
	if (p.sourceCommit !== ctx.githubSha) return refuse("sourceCommit is not the commit being built");
	if (typeof p.seq !== "number" || !Number.isSafeInteger(p.seq) || p.seq < 1) {
		return refuse("seq is not a positive integer");
	}
	const issued = time(p.issuedAt);
	const expires = time(p.expiresAt);
	if (issued === null || expires === null)
		return refuse("issuedAt or expiresAt is not an ISO time");
	if (expires - issued !== TEN_DAYS_MS) return refuse("expiresAt is not 10 days after issuedAt");
	if (Math.abs(issued - ctx.now) > CLOCK_SKEW_MS)
		return refuse("issuedAt is not within 10 minutes of now");
	if (!Array.isArray(p.releases) || p.releases.length < 1 || p.releases.length > MAX_RELEASES) {
		return refuse(`releases is not an array of 1 to ${MAX_RELEASES}`);
	}
	if (!p.releases.some((r) => (r as { version?: unknown })?.version === p.latest)) {
		return refuse("latest is not one of the releases");
	}
	if (!Array.isArray(p.revokedKeyIds)) return refuse("revokedKeyIds is not an array");
	return { ok: true };
}

if (import.meta.main) {
	const [command, file] = process.argv.slice(2);
	const sha = process.env.GITHUB_SHA ?? "";
	if (command !== "check" || !file) {
		console.error(
			"usage: bun scripts/release/sign-guard.ts check <payload.json>   (GITHUB_SHA in the environment)",
		);
		process.exit(2);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		console.error("sign-guard: payload is not JSON");
		process.exit(1);
	}
	const verdict = checkPayloadForSigning(payload, { githubSha: sha, now: Date.now() });
	if (!verdict.ok) {
		console.error(`sign-guard: ${verdict.reason}`);
		process.exit(1);
	}
	console.log("sign-guard: payload ok");
}
