/**
 * AGEN-69 phase 3: the command classifier (TC-3.3, 3.4, 3.5, 3.39, 3.45,
 * 3.51, 3.53, 3.54 and the BN-4 additions). Pure. Every secret and credential
 * path here is an obviously fake placeholder.
 */
import { describe, expect, test } from "bun:test";
import { prng } from "../../../test-utils/random-sessions.js";
import { classifyCommand, validationResult } from "./command-class.js";

const kind = (input: unknown) => classifyCommand(input).kind;

describe("TC-3.3 clean validation table", () => {
	const positives = [
		"bun test",
		"bun run test",
		"npm test",
		"npx vitest",
		"vitest",
		"jest",
		"pytest",
		"go test ./...",
		"cargo test",
		"tsc --noEmit",
		"bun run typecheck",
		"biome check",
		"bun run check",
		"CI=1 bun test",
		"env FOO=1 bun test",
		"cd x && bun test",
	];
	for (const command of positives) {
		test(`TC-3.3 ${command} is a clean validation`, () => {
			expect(kind(command)).toBe("validation");
		});
	}
	for (const command of ["docker build .", "terraform plan", "make deploy", "kubectl apply -f x"]) {
		test(`TC-3.3 ${command} is not a validation`, () => {
			expect(kind(command)).not.toBe("validation");
		});
	}
});

describe("TC-3.4 command position, not substring", () => {
	for (const command of [
		"echo bun test",
		'git commit -m "run pytest"',
		'grep "bun test" README.md',
		"cat tests.md",
		"git log --grep=pytest",
	]) {
		test(`TC-3.4 ${command} is not a validation`, () => {
			expect(kind(command)).not.toBe("validation");
		});
	}
});

describe("TC-3.5 validation results from the full response", () => {
	test("TC-3.5a passing outputs are ok", () => {
		for (const out of ["212 pass\n0 fail", "Found 0 errors.", "Tests: 0 failed, 12 passed"]) {
			expect(validationResult(out, false, false), out).toBe("ok");
		}
	});
	test("TC-3.5b failing outputs are failed", () => {
		for (const out of ["1 fail", "FAIL src/a.test.ts", "src/a.ts(3,1): error TS2345: bad"]) {
			expect(validationResult(out, false, false), out).toBe("failed");
		}
	});
	test("TC-3.5c a failure marker hidden from the 300+300 excerpt is still failed", () => {
		const out = `${"ok line\n".repeat(150)}FAIL src/deep.test.ts\n${"ok line\n".repeat(100)}`;
		const marker = out.indexOf("FAIL");
		expect(marker).toBeGreaterThan(1000);
		expect(marker).toBeLessThan(1400);
		expect(validationResult(out, false, false)).toBe("failed");
	});
	test("TC-3.5d no pass and no failure pattern is unknown; empty is unknown; a failure hook is failed", () => {
		expect(validationResult("compiling...\ndone", false, false)).toBe("unknown");
		expect(validationResult("", false, false)).toBe("unknown");
		expect(validationResult(null, false, false)).toBe("unknown");
		expect(validationResult("", true, false)).toBe("failed");
		expect(validationResult("212 pass", true, false)).toBe("failed");
	});
});

describe("TC-3.39 exit masking and redirection", () => {
	const masked = [
		"bun test | tail -5",
		"bun test | head",
		"bun test | grep pass",
		"bun test | tee out.log",
		"bun test || true",
		"bun test; true",
	];
	for (const command of masked) {
		test(`TC-3.39a ${command} is masked: unknown even with a pass pattern`, () => {
			const cls = classifyCommand(command);
			expect(cls.kind).toBe("validation");
			if (cls.kind !== "validation") return;
			expect(cls.masked).toBe(true);
			expect(validationResult("212 pass\n0 fail", false, cls.masked)).toBe("unknown");
		});
	}
	test("TC-3.39b redirection and && echo are not masking: the result follows the output", () => {
		const redirected = classifyCommand("bun test > out.log");
		const echoed = classifyCommand("bun test && echo done");
		expect(redirected).toEqual({ kind: "validation", masked: false });
		expect(echoed).toEqual({ kind: "validation", masked: false });
		expect(validationResult("", false, false), "empty recorded output").toBe("unknown");
		expect(validationResult("212 pass\n0 fail", false, false)).toBe("ok");
	});
	test("TC-3.39c a failure pattern is failed even when masked", () => {
		expect(validationResult("1 fail", false, true)).toBe("failed");
	});
});

describe("TC-3.45 withheld commands", () => {
	const withheld = [
		"cat .env",
		"cat ~/.aws/credentials",
		"cat id_rsa",
		"head -5 .env",
		"printenv",
		"env",
		"/usr/bin/env",
		"env | grep KEY",
		"kubectl get secret x -o yaml",
		"kubectl --context thor -n a get secrets",
		"kubectl get secret x -o jsonpath=... | base64 -d",
		"security find-generic-password -s x",
		"op read op://v/i/f",
		"echo $API_KEY",
		'echo "$TOKEN"',
		"echo $?",
		"cd x && cat .env",
		"FOO=1 printenv",
		"sudo cat .env",
		'bash -c "cat .env"',
		"bash -lc 'printenv'",
		["bash", "-lc", "cat .env"],
		"set",
		"export -p",
		"declare -x",
		"cat /proc/1/environ",
		"bw get item x",
		"pass show x",
		"doppler secrets",
		"vault kv get x",
		"vault read secret/x",
		"gh auth token",
		"gcloud auth print-access-token",
		"az account get-access-token",
		"aws secretsmanager get-secret-value --secret-id x",
		"aws ssm get-parameter --name x --with-decryption",
		"aws sts get-session-token",
		"git config --get remote.origin.url",
		"git config -l",
		"docker inspect c",
		"docker exec c printenv",
		"kubectl exec p -- env",
		"kubectl config view --raw",
		"terraform output",
		"terraform show",
		'python -c "import os;print(os.environ)"',
		'node -e "console.log(process.env)"',
		"bun test && cat .env",
		"cat .env; bun test",
	];
	for (const command of withheld) {
		test(`TC-3.45a ${JSON.stringify(command)} is withheld`, () => {
			expect(kind(command)).toBe("withheld");
		});
	}
	const viewers = [
		"cat",
		"less",
		"more",
		"bat",
		"head",
		"tail",
		"sed",
		"awk",
		"grep",
		"jq",
		"strings",
		"xxd",
	];
	const files = [
		".env.local",
		".netrc",
		".npmrc",
		".pypirc",
		".git-credentials",
		"id_ed25519",
		"server.pem",
		"tls.key",
		"kubeconfig",
		"~/.kube/config",
		"credentials",
		"secrets.yaml",
		"config/prod.json",
		"vars.tfvars",
	];
	test("TC-3.45b every viewer over every listed file is withheld", () => {
		for (const viewer of viewers) {
			for (const file of files) {
				expect(kind(`${viewer} ${file}`), `${viewer} ${file}`).toBe("withheld");
			}
		}
	});
	test("TC-3.45c a clean segment does not let the rest through: no text for the bun test segment either", () => {
		expect(classifyCommand("bun test && cat .env")).toEqual({ kind: "withheld" });
		expect(classifyCommand("cat .env; bun test")).toEqual({ kind: "withheld" });
	});
	test("TC-3.45d negatives are shown normally", () => {
		for (const command of [
			"cat README.md",
			"cat environment.md",
			"grep ENV src/a.ts",
			"echo done",
		]) {
			expect(kind(command), command).toBe("ordinary");
		}
		expect(kind("bun test")).toBe("validation");
	});
});

describe("TC-3.51 fail-closed table", () => {
	const notShown = [
		'sh -c "make clean"',
		'eval "$X"',
		"cat <<EOF\nhello\nEOF",
		"echo aGk= | base64",
		'python -c "print(1)"',
		'node -e "1"',
		"echo $(date)",
		"echo `date`",
		["python3", "-c", "print(1)"],
		"cd $(git rev-parse --show-toplevel) && bun test",
	];
	for (const command of notShown) {
		test(`TC-3.51a ${JSON.stringify(command)} is not shown`, () => {
			expect(classifyCommand(command)).toEqual({ kind: "not_shown" });
		});
	}
	test("TC-3.51b positive controls do not fail closed", () => {
		expect(kind('bash -lc "cd x && bun test"')).toBe("validation");
		expect(kind(["bash", "-lc", "bun test"])).toBe("validation");
	});
	test("TC-3.51c the Codex array in its stored JSON-text form is read like the array", () => {
		expect(kind('["bash","-lc","bun test"]')).toBe("validation");
		expect(kind('["bash","-lc","cat .env"]')).toBe("withheld");
		expect(kind('["python3","-c","print(1)"]')).toBe("not_shown");
	});
});

describe("TC-3.53 normaliser", () => {
	const wrapped = [
		"sudo bun test",
		"env FOO=1 bun test",
		"FOO=1 BAR=2 bun test",
		"nice bun test",
		"time bun test",
		"timeout 60 bun test",
		"xargs bun test",
		"docker exec c bun test",
		"kubectl exec p -- pytest",
		"ssh h pytest",
		'bash -lc "cd x && bun test"',
		'sudo bash -c "env X=1 cargo test"',
		["bash", "-lc", "bun test"],
	];
	for (const command of wrapped) {
		test(`TC-3.53a ${JSON.stringify(command)} classifies as the inner validation`, () => {
			expect(kind(command)).toBe("validation");
		});
	}
	test("TC-3.53b a wrapper does not hide a credential read", () => {
		expect(kind('sudo bash -lc "cat .env"')).toBe("withheld");
		expect(kind("ssh h cat .env")).toBe("withheld");
		expect(kind("xargs printenv")).toBe("withheld");
		expect(kind('ssh h "cat .env"')).toBe("withheld");
	});
	test("TC-3.53c segments split on ; && || | and newlines, not inside quotes", () => {
		for (const sep of [";", "&&", "||", "|", "\n"]) {
			expect(kind(`bun test ${sep} cat .env`), JSON.stringify(sep)).toBe("withheld");
		}
		expect(kind('echo "a; b"')).toBe("ordinary");
		expect(kind('echo "a && cat .env"')).toBe("ordinary");
	});
	test("TC-3.53d an unbalanced quote or unterminated heredoc fails closed and never throws", () => {
		for (const command of [
			'echo "unterminated',
			"echo 'x",
			"cat <<EOF\nno end",
			"echo $(date",
			"echo `date",
		]) {
			expect(classifyCommand(command), command).toEqual({ kind: "not_shown" });
		}
	});
});

describe("TC-3.54 property: the classifier never leaks a credential read", () => {
	const wrappers = [
		(c: string) => c,
		(c: string) => `sudo ${c}`,
		(c: string) => `env X=1 ${c}`,
		(c: string) => `bash -c '${c}'`,
		(c: string) => `timeout 5 ${c}`,
		(c: string) => `nice ${c}`,
		(c: string) => `time ${c}`,
		(c: string) => `xargs ${c}`,
		(c: string) => `docker exec c ${c}`,
		(c: string) => `kubectl exec p -- ${c}`,
		(c: string) => `ssh h '${c}'`,
		(c: string) => `X=1 ${c}`,
	];
	const separators = [";", "&&", "||", "|", "\n"];
	const harmless = ["bun test", "cd src", "echo done", "ls -la", "git status"];
	const listed = [
		"printenv",
		"env",
		"set",
		"export -p",
		"declare -x",
		"cat .env",
		"head -3 .npmrc",
		"grep k id_rsa",
		"jq . kubeconfig",
		"cat /proc/1/environ",
		"bw get item x",
		"pass show x",
		"vault kv get x",
		"gh auth token",
		"git config --list",
		"docker inspect c",
		"kubectl get secrets",
		"terraform output",
		"aws sts get-session-token",
	];
	const rand = prng(20261004);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
	test("TC-3.54 at least 200 seeded compositions: never throws, always one of the four, listed means withheld", () => {
		let withheldCount = 0;
		for (let i = 0; i < 400; i++) {
			const segments = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(harmless));
			const verb = pick(listed);
			const position = Math.floor(rand() * (segments.length + 1));
			segments.splice(position, 0, verb);
			const sep = pick(separators);
			const inner = segments.join(` ${sep} `);
			const command = pick(wrappers)(inner);
			const run = () => classifyCommand(command);
			expect(run, command).not.toThrow();
			const cls = run();
			expect(["validation", "withheld", "not_shown", "ordinary"], command).toContain(cls.kind);
			expect(cls, command).toEqual({ kind: "withheld" });
			withheldCount++;
		}
		expect(withheldCount).toBeGreaterThanOrEqual(200);
	});
	test("TC-3.54 positive control: the same harness over only harmless segments is never withheld", () => {
		for (let i = 0; i < 100; i++) {
			const inner = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(harmless)).join(
				` ${pick(separators)} `,
			);
			expect(kind(pick(wrappers)(inner)), inner).not.toBe("withheld");
		}
	});
	test("TC-3.54 arbitrary junk never throws", () => {
		const junk = [
			"",
			" ",
			"'",
			'"',
			"$(",
			"`",
			"<<",
			"\\",
			";;",
			"&&&&",
			"|||",
			"((",
			"))",
			"{}",
			"\u0000",
			"a‮b",
		];
		for (let i = 0; i < 300; i++) {
			const text = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => pick(junk)).join(
				pick(["", " "]),
			);
			expect(() => classifyCommand(text), JSON.stringify(text)).not.toThrow();
		}
		for (const odd of [null, undefined, 5, {}, [], [1, 2], { a: 1 }, true]) {
			expect(() => classifyCommand(odd)).not.toThrow();
		}
	});
});

describe("BN-4 classifier additions", () => {
	test("BN-4a secret(s) file names, config/prod* and *.tfvars are credential files", () => {
		for (const command of [
			"cat secrets.yaml",
			"less secret.json",
			"cat config/production.yml",
			"head x.tfvars",
		]) {
			expect(kind(command), command).toBe("withheld");
		}
	});
	test("BN-4b a failed ordinary command with a viewer segment is flagged status-only; one without is not", () => {
		expect(classifyCommand("cat notes.txt; false")).toEqual({ kind: "ordinary", hasViewer: true });
		expect(classifyCommand("grep -r foo src")).toEqual({ kind: "ordinary", hasViewer: true });
		expect(classifyCommand("rm -rf build")).toEqual({ kind: "ordinary", hasViewer: false });
	});
	test("BN-4c an unparseable command is itself a fail-closed trigger, even if it names a credential", () => {
		expect(classifyCommand('cat .env "oops')).toEqual({ kind: "not_shown" });
	});
});
