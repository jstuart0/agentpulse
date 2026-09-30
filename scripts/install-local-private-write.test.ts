/**
 * AGEN-21 (security, Medium): scripts/install-local.sh previously wrote
 * .env.local (holds AGENTPULSE_INITIAL_API_KEY) and supervisor.json (holds
 * the supervisor credential / enrollment token) with a bare
 * `cat > path <<EOF` / python3 `open(path, "w")` — both follow a symlink at
 * the destination and leave the file at the OS-default create mode (0644
 * under a typical umask), readable by any local user. Both writers now
 * route through ap_write_private_no_follow, the same no-follow, 0600
 * primitive scripts/write-private-no-follow.test.ts already exercises for
 * setup-hooks.sh/setup-relay.sh/the rendered /setup.sh template.
 *
 * This sources the REAL function from install-local.sh (never
 * reimplements it), matching that file's existing pattern.
 */
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

function extractPrivateWriteBlock(): string {
	const source = readFileSync(join(ROOT, "scripts/install-local.sh"), "utf-8");
	const startMarker = "# >>> agentpulse-private-write";
	const endMarker = "# <<< agentpulse-private-write";
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker);
	if (start === -1 || end === -1) {
		throw new Error("agentpulse-private-write markers not found in scripts/install-local.sh");
	}
	return source.slice(start, end + endMarker.length);
}

async function runWritePrivateNoFollow(
	path: string,
	content: string,
): Promise<{ code: number | null; stderr: string }> {
	const script = `${extractPrivateWriteBlock()}\nap_write_private_no_follow "$1" "$2"`;
	const proc = Bun.spawn(["bash", "-c", script, "_", path, content], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { code: exitCode, stderr };
}

describe("ap_write_private_no_follow (AGEN-21) — scripts/install-local.sh", () => {
	let dir: string;

	function cleanup() {
		if (dir) rmSync(dir, { recursive: true, force: true });
	}

	test("a symlinked parent directory is refused before mkdir -p can follow it", async () => {
		dir = mkdtempSync(join(tmpdir(), "ap-install-local-private-write-"));
		try {
			const realDir = join(dir, "attacker-owned");
			mkdirSync(realDir);
			const fakeAgentpulseDir = join(dir, "fake-agentpulse");
			symlinkSync(realDir, fakeAgentpulseDir);
			const target = join(fakeAgentpulseDir, "supervisor.json");

			const result = await runWritePrivateNoFollow(target, '{"apiKey":"attacker-controlled"}');
			expect(result.code).not.toBe(0);
			expect(result.stderr).toMatch(/refusing to write into a symlinked directory/);
			expect(existsSync(join(realDir, "supervisor.json"))).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("a symlink at the final path is refused, target untouched", async () => {
		dir = mkdtempSync(join(tmpdir(), "ap-install-local-private-write-"));
		try {
			const real = join(dir, "outside-target");
			writeFileSync(real, "should never change\n");
			const target = join(dir, "supervisor.json");
			symlinkSync(real, target);

			const result = await runWritePrivateNoFollow(target, '{"apiKey":"attacker-controlled"}');
			expect(result.code).not.toBe(0);
			expect(result.stderr).toMatch(/refusing to write through a symlink/);
			expect(readFileSync(real, "utf-8")).toBe("should never change\n");
		} finally {
			cleanup();
		}
	});

	test("a normal write succeeds at 0600, creating the parent directory if needed", async () => {
		dir = mkdtempSync(join(tmpdir(), "ap-install-local-private-write-"));
		try {
			const target = join(dir, "agentpulse", "supervisor.json");

			const result = await runWritePrivateNoFollow(
				target,
				'{"serverUrl":"http://localhost:3000","supervisorCredential":"aps_test_value"}\n',
			);
			expect(result.code).toBe(0);
			expect(readFileSync(target, "utf-8")).toBe(
				'{"serverUrl":"http://localhost:3000","supervisorCredential":"aps_test_value"}\n',
			);
			expect(statSync(target).mode & 0o777).toBe(0o600);
		} finally {
			cleanup();
		}
	});

	test("a rewrite (rotation) of an existing file keeps it at 0600", async () => {
		dir = mkdtempSync(join(tmpdir(), "ap-install-local-private-write-"));
		try {
			const target = join(dir, "supervisor.json");
			await runWritePrivateNoFollow(target, '{"supervisorCredential":"aps_test_original"}\n');
			expect(statSync(target).mode & 0o777).toBe(0o600);

			const result = await runWritePrivateNoFollow(
				target,
				'{"supervisorCredential":"aps_test_rotated"}\n',
			);
			expect(result.code).toBe(0);
			expect(readFileSync(target, "utf-8")).toBe('{"supervisorCredential":"aps_test_rotated"}\n');
			expect(statSync(target).mode & 0o777).toBe(0o600);
		} finally {
			cleanup();
		}
	});
});

describe("install-local.sh secret writers are wired through ap_write_private_no_follow (AGEN-21)", () => {
	const source = readFileSync(join(ROOT, "scripts/install-local.sh"), "utf-8");

	test("the .env.local writer calls ap_write_private_no_follow, not a bare redirect", () => {
		expect(source).toMatch(/ap_write_private_no_follow "\$\{ENV_FILE\}"/);
		expect(source).not.toMatch(/cat > "\$\{ENV_FILE\}"/);
	});

	test("the supervisor.json writer calls ap_write_private_no_follow, not a bare python3 open(...)", () => {
		expect(source).toMatch(/ap_write_private_no_follow "\$\{SUPERVISOR_CONFIG_FILE\}"/);
		expect(source).not.toMatch(/with open\(path, "w"\) as f:/);
	});
});

/**
 * install-local.ps1's Write-ApPrivateFile/Write-ApPrivateJsonFile can't be
 * executed here (no pwsh in this environment/CI's non-Windows jobs — same
 * gap scripts/hook-command-parity.test.ts documents for the Codex/Copilot
 * hooks writers). Real execution coverage — including the single-ACE ACL
 * assertion — lives in scripts/test-install-local.ps1 (the Windows CI
 * job). This is a static structural check only: the two secret-file call
 * sites route through the private writer, not a bare Set-Content/
 * Set-JsonFile.
 */
describe("install-local.ps1 secret writers are wired through Write-ApPrivateFile (AGEN-21, static)", () => {
	const source = readFileSync(join(ROOT, "scripts/install-local.ps1"), "utf-8");

	test("Write-ApPrivateFile and Write-ApPrivateJsonFile are defined", () => {
		expect(source).toMatch(/function Write-ApPrivateFile/);
		expect(source).toMatch(/function Write-ApPrivateJsonFile/);
	});

	test("the .env.local writer calls Write-ApPrivateFile, not a bare Set-Content", () => {
		expect(source).toMatch(/Write-ApPrivateFile -Path \$EnvFile -Content \$envFileContent/);
		expect(source).not.toMatch(/"@ \| Set-Content -Path \$EnvFile/);
	});

	test("the supervisor.json writer calls Write-ApPrivateJsonFile, not Set-JsonFile", () => {
		expect(source).toMatch(
			/Write-ApPrivateJsonFile -Path \$SupervisorConfigPath -Data \$supervisorConfig/,
		);
		expect(source).not.toMatch(/Set-JsonFile -Path \$SupervisorConfigPath/);
	});
});
