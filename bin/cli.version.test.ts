/**
 * `agentpulse version`: a real subprocess run against a temp HOME. It is read-only, so the cases
 * check what it prints for an install with and without a relay, a statusline and an install record.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };

setDefaultTimeout(30_000);

const CLI = join(import.meta.dir, "cli.ts");
const REPO = realpathSync(join(import.meta.dir, ".."));

function tempHome(): string {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "ap-cli-version-")));
	mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
	chmodSync(join(home, ".agentpulse"), 0o700);
	return home;
}

function runCli(home: string, args: string[], env: Record<string, string> = {}) {
	const proc = Bun.spawnSync(["bun", CLI, ...args], {
		cwd: home,
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...env },
	});
	return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

function installRecord(home: string, over: Record<string, unknown> = {}) {
	const file = join(home, ".agentpulse", "install.json");
	writeFileSync(
		file,
		JSON.stringify({
			schema: 1,
			kind: "local",
			components: ["server", "supervisor"],
			repoUrl: "https://example.invalid/agentpulse.git",
			track: "ref",
			ref: "main",
			installDir: REPO,
			dataDir: join(home, ".agentpulse", "data"),
			sqlitePath: join(home, ".agentpulse", "data", "agentpulse.db"),
			dialect: "sqlite",
			service: "none",
			serverUrl: "http://localhost:3000",
			serverTransport: "loopback",
			bunBin: "/bun/bin/bun",
			...over,
		}),
		{ mode: 0o600 },
	);
	chmodSync(file, 0o600);
}

function relayFile(home: string, version: string | null) {
	writeFileSync(
		join(home, ".agentpulse", "relay.ts"),
		`// relay\n${version === null ? "" : `export const RELAY_VERSION = "${version}";\n`}`,
	);
}
function statuslineFile(home: string, version: string | null) {
	mkdirSync(join(home, ".claude"), { recursive: true });
	writeFileSync(
		join(home, ".claude", "statusline-agentpulse.sh"),
		`#!/bin/bash\n${version === null ? "" : `AGENTPULSE_STATUSLINE_VERSION="${version}"\n`}input=$(cat)\n`,
	);
}

describe("agentpulse version", () => {
	test("--help lists it", () => {
		const home = tempHome();
		try {
			expect(runCli(home, ["--help"]).out).toContain("agentpulse version");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("prints the app version and, with no record, an install kind other than local", () => {
		const home = tempHome();
		try {
			const r = runCli(home, ["version"]);
			expect(r.code).toBe(0);
			expect(r.out).toContain(`AgentPulse ${pkg.version}`);
			expect(r.out).toContain("Install: source");
			expect(r.out).toContain("Relay: not installed");
			expect(r.out).toContain("Statusline: not installed");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("with a matching install record it says local, the track and the ref", () => {
		const home = tempHome();
		try {
			installRecord(home);
			const r = runCli(home, ["version"]);
			expect(r.code).toBe(0);
			expect(r.out).toContain("Install: local (tracking ref main)");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a record for another directory is not local", () => {
		const home = tempHome();
		try {
			installRecord(home, { installDir: join(home, "elsewhere") });
			expect(runCli(home, ["version"]).out).toContain("Install: source");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("reads the relay and statusline versions from the installed copies", () => {
		const home = tempHome();
		try {
			relayFile(home, "0.10.0");
			statuslineFile(home, "0.10.0");
			const r = runCli(home, ["version"]);
			expect(r.out).toContain("Relay: 0.10.0");
			expect(r.out).toContain("Statusline: 0.10.0");
			expect(r.out).not.toContain("not refreshed here");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a copy from before versions existed reads as unknown, not as the current version", () => {
		const home = tempHome();
		try {
			relayFile(home, null);
			statuslineFile(home, null);
			const r = runCli(home, ["version"]);
			expect(r.out).toContain("Relay: unknown version (older than 0.11.0)");
			expect(r.out).toContain("Statusline: unknown version (older than 0.11.0)");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a statusline with no relay on the machine says it isn't refreshed here", () => {
		const home = tempHome();
		try {
			statuslineFile(home, "0.11.0");
			const r = runCli(home, ["version"]);
			expect(r.out).toContain("Relay: not installed");
			expect(r.out).toContain("not refreshed here: no relay on this machine");
			expect(r.out).toContain("re-run setup after updating");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("an unreadable or non-version token in a copy is never echoed", () => {
		const home = tempHome();
		try {
			writeFileSync(
				join(home, ".agentpulse", "relay.ts"),
				'export const RELAY_VERSION = "1.2.3; rm -rf /";\n',
			);
			const r = runCli(home, ["version"]);
			expect(r.out).not.toContain("rm -rf");
			expect(r.out).toContain("Relay: unknown version");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
