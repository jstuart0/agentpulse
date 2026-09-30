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
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
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

/**
 * Slices out just ap_write_private_no_follow's own body — never the
 * AGEN-21 doc-comment above it, which quotes the old predictable pattern
 * verbatim as documentation.
 */
function extractFunctionBody(block: string): string {
	const start = block.indexOf("ap_write_private_no_follow() {");
	if (start === -1) throw new Error("ap_write_private_no_follow not found");
	const afterStart = block.indexOf("\n", start) + 1;
	const closeIdx = block.indexOf("\n}", afterStart);
	if (closeIdx === -1) throw new Error("ap_write_private_no_follow has no closing brace");
	return block.slice(start, closeIdx + 2);
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

/**
 * AGEN-21 (xander, High): same pre-plant-at-the-old-predictable-name proof
 * as scripts/write-private-no-follow.test.ts — the child publishes its
 * real PID via a handshake file and blocks at a busy-wait gate until the
 * test has planted the decoy, so this is deterministic rather than racing
 * the child's own startup/parsing time.
 */
async function runWritePrivateNoFollowWithPredictableNameDecoy(
	path: string,
	content: string,
	dir: string,
): Promise<{ code: number | null; stderr: string; decoyPaths: string[]; decoyTarget: string }> {
	const pidFile = join(dir, ".ap-test-pid-handshake");
	const goFile = join(dir, ".ap-test-go-handshake");
	const script = `${extractPrivateWriteBlock()}
echo "$$" > "$3"
while [ ! -f "$4" ]; do sleep 0.02; done
ap_write_private_no_follow "$1" "$2"`;
	const proc = Bun.spawn(["bash", "-c", script, "_", path, content, pidFile, goFile], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const deadline = Date.now() + 10_000;
	let pid: number | null = null;
	while (Date.now() < deadline) {
		if (existsSync(pidFile)) {
			const raw = readFileSync(pidFile, "utf-8").trim();
			if (raw) {
				pid = Number(raw);
				break;
			}
		}
		await Bun.sleep(10);
	}
	if (pid === null) throw new Error("child bash process never published its PID");

	const decoyTarget = join(dir, "decoy-target");
	writeFileSync(decoyTarget, "should never change\n");
	const decoyPaths: string[] = [];
	for (const candidate of [pid - 1, pid, pid + 1, pid + 2]) {
		const decoyPath = `${path}.${candidate}.tmp`;
		symlinkSync(decoyTarget, decoyPath);
		decoyPaths.push(decoyPath);
	}

	writeFileSync(goFile, "go\n");
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	return { code: exitCode, stderr, decoyPaths, decoyTarget };
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

	test("the function body no longer uses the predictable ${path}.$$.tmp temp name", () => {
		const fnBody = extractFunctionBody(extractPrivateWriteBlock());
		expect(fnBody).not.toMatch(/\$\{?path\}?\.\$\$\.tmp/);
		expect(fnBody).toContain("mktemp");
	});

	test("AGEN-21 (xander, High): a decoy symlink pre-planted at the old predictable temp name is never followed", async () => {
		dir = mkdtempSync(join(tmpdir(), "ap-install-local-private-write-"));
		try {
			const target = join(dir, "supervisor.json");

			const result = await runWritePrivateNoFollowWithPredictableNameDecoy(
				target,
				'{"supervisorCredential":"aps_test_value"}\n',
				dir,
			);

			expect(result.code).toBe(0);
			expect(readFileSync(target, "utf-8")).toBe('{"supervisorCredential":"aps_test_value"}\n');
			expect(statSync(target).mode & 0o777).toBe(0o600);

			expect(readFileSync(result.decoyTarget, "utf-8")).toBe("should never change\n");
			for (const decoyPath of result.decoyPaths) {
				const st = lstatSync(decoyPath);
				expect(st.isSymbolicLink()).toBe(true);
			}
		} finally {
			cleanup();
		}
	});

	test("AGEN-21 (xander, High): no leftover temp file matches the old predictable *.<pid>.tmp pattern after a normal write", async () => {
		dir = mkdtempSync(join(tmpdir(), "ap-install-local-private-write-"));
		try {
			const target = join(dir, "supervisor.json");

			await runWritePrivateNoFollow(target, '{"supervisorCredential":"aps_test_value"}\n');

			const leftovers = readdirSync(dir).filter((name) =>
				/^supervisor\.json\.\d+\.tmp$/.test(name),
			);
			expect(leftovers).toEqual([]);
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

	test("AGEN-21 (xander, High): Write-ApPrivateFile narrows the parent directory's ACL before writing the file, same as New-ApHookAuthHeaderFile (F208)", () => {
		const fnBody = source.slice(
			source.indexOf("function Write-ApPrivateFile"),
			source.indexOf("function Write-ApPrivateJsonFile"),
		);
		const dirIcaclsIdx = fnBody.search(/icacls \$dir \/inheritance:r \/grant:r/);
		const newItemIdx = fnBody.indexOf("New-Item -ItemType Directory -Force -Path $dir");
		const writeNoFollowIdx = fnBody.indexOf("Write-ApFileNoFollow -Path $Path");
		expect(dirIcaclsIdx).toBeGreaterThan(-1);
		// F208's ordering: narrow the directory's ACL BEFORE the file is
		// created inside it, so the file inherits a private ACL from the
		// instant it exists — never New-Item, then write, then narrow the
		// dir (which would leave a window where a freshly-created file
		// briefly held the directory's broader, inherited ACL).
		expect(newItemIdx).toBeGreaterThan(-1);
		expect(dirIcaclsIdx).toBeGreaterThan(newItemIdx);
		expect(writeNoFollowIdx).toBeGreaterThan(dirIcaclsIdx);
	});

	test("AGEN-21 (xander, Medium): every icacls call is wrapped in try/catch (best-effort, matching the TS side's tightenWindowsAclBestEffort contract)", () => {
		// $ErrorActionPreference = "Stop" only converts terminating
		// PowerShell-cmdlet errors; a native icacls.exe failure (missing
		// binary, non-NTFS volume, policy restriction) needs an explicit
		// try/catch to not crash the install over an ACL narrowing that
		// couldn't be verified. Forward stack-based scan (never a
		// reimplementation of PowerShell parsing, just brace-depth
		// tracking): each '{' pushes a frame tagged by whether its line
		// opens a try block; each '}' pops. A line combining both (the
		// codebase's "} catch {" style) processes its '}' before its '{',
		// matching real evaluation order.
		type Frame = { isTry: boolean };
		const stack: Frame[] = [];
		const lines = source.split("\n");
		const unwrapped: number[] = [];
		let totalIcaclsCalls = 0;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			const trimmed = line.trim();
			if (/^icacls\s/.test(trimmed)) {
				totalIcaclsCalls++;
				if (!stack.some((f) => f.isTry)) unwrapped.push(i);
			}
			for (const ch of line) {
				if (ch === "{") {
					stack.push({ isTry: /^try\s*\{?$/.test(trimmed) || trimmed === "try {" });
				} else if (ch === "}") {
					stack.pop();
				}
			}
		}
		// Population floor: this codebase currently has 4 icacls call sites
		// (New-ApHookAuthHeaderFile's directory + file, Write-ApPrivateFile's
		// directory + file). A count of 0 would make the loop above vacuous.
		expect(totalIcaclsCalls).toBe(4);
		expect(unwrapped.length, unwrapped.map((i) => `line ${i + 1}: ${lines[i]}`).join("\n")).toBe(0);
	});
});
