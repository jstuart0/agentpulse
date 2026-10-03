// The Codex observer names the machine it runs on (X-AgentPulse-Host) on every
// hook it posts, so a Codex session the server only hears about through the
// observer still shows where it ran. Display only; the exclude rule and the
// delivery identity are untouched by it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_EXCLUDE_RULES } from "./codex-observer-test-support.js";

const { processRolloutFile, scanRolloutFiles } = await import("./codex-observer.js");
const { HOST_HEADER } = await import("../../shared/hook-headers.js");
const { parseReportedHostHeader } = await import("../../shared/reported-host.js");

const FIXTURE_RAW = readFileSync(
	join(import.meta.dir, "__fixtures__", "codex-rollout-0.145", "rollout-sanitized.jsonl"),
	"utf8",
);
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";

type Captured = { url: string; headers: Record<string, string> };

const tmpDirs: string[] = [];
function mkTmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "ap-observer-host-"));
	tmpDirs.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function fakeFetch(captured: Captured[]) {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		captured.push({
			url: String(input),
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
		});
		return new Response("{}", { status: 200 });
	};
}

function rolloutIn(dir: string): string {
	const path = join(dir, "rollout.jsonl");
	writeFileSync(path, FIXTURE_RAW.replaceAll(PLACEHOLDER_ID, crypto.randomUUID()));
	return path;
}

describe("codex observer host header", () => {
	test("is named X-AgentPulse-Host", () => {
		expect(HOST_HEADER).toBe("X-AgentPulse-Host");
	});

	test("every hook it posts names this machine, encoded so any name is a valid header", async () => {
		const dir = mkTmp();
		const home = join(dir, "home");
		mkdirSync(home);
		const captured: Captured[] = [];
		await processRolloutFile(
			rolloutIn(dir),
			undefined,
			"http://x",
			null,
			new Map(),
			fakeFetch(captured),
			home,
			NO_EXCLUDE_RULES,
			"Jay’s MacBook Pro",
		);

		expect(captured.length).toBeGreaterThan(1);
		for (const call of captured) {
			expect(call.url).toBe("http://x/api/v1/hooks");
			expect(parseReportedHostHeader(call.headers[HOST_HEADER.toLowerCase()])).toBe(
				"Jay’s MacBook Pro",
			);
		}
	});

	test("sends no header at all when it has no host name", async () => {
		const dir = mkTmp();
		const home = join(dir, "home");
		mkdirSync(home);
		const captured: Captured[] = [];
		await processRolloutFile(
			rolloutIn(dir),
			undefined,
			"http://x",
			null,
			new Map(),
			fakeFetch(captured),
			home,
			NO_EXCLUDE_RULES,
		);
		expect(captured.length).toBeGreaterThan(0);
		for (const call of captured) expect(call.headers[HOST_HEADER.toLowerCase()]).toBeUndefined();
	});

	test("a scan carries the host name through to every file it posts", async () => {
		const dir = mkTmp();
		const home = join(dir, "home");
		mkdirSync(home);
		const captured: Captured[] = [];
		await scanRolloutFiles([rolloutIn(dir)], {
			state: { files: {} },
			callMapsByFile: new Map(),
			serverUrl: "http://x",
			apiKey: null,
			rules: NO_EXCLUDE_RULES,
			fetchImpl: fakeFetch(captured),
			homeDir: home,
			hostName: "scan-box",
			save: () => {},
		});
		expect(captured.length).toBeGreaterThan(0);
		for (const call of captured) {
			expect(parseReportedHostHeader(call.headers[HOST_HEADER.toLowerCase()])).toBe("scan-box");
		}
	});
});
