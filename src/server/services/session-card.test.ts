/**
 * The failure reason on a card is a launch's error made safe to show to anyone who can read the list:
 * redacted first (secrets in a clone URL, a key in a flag), home-directory paths reduced, one printable
 * line, and cut to 120 characters after redaction, never before.
 */
import { describe, expect, test } from "bun:test";
import { FAILURE_REASON_MAX_CHARS, safeFailureReason } from "./session-card.js";

// Fake credentials are built here at run time so no literal in the source looks like one.
const fakeToken = () => `ghp_${"a1B2c3D4e5".repeat(4)}`;
const fakePassword = () => ["s3cr", "etpw", "9x9x"].join("");
const home = (account: string) => ["", "Users", account].join("/");

describe("safeFailureReason redacts", () => {
	test("a token in a clone URL", () => {
		const token = fakeToken();
		const reason = safeFailureReason(`git clone https://alice:${token}@git.example.com/x failed`);
		expect(reason).not.toContain(token);
		expect(reason).not.toContain("alice:");
		expect(reason).toContain("git.example.com");
	});

	test("a password in a clone URL", () => {
		const password = fakePassword();
		const reason = safeFailureReason(`fatal: https://bob:${password}@host.example/x.git not found`);
		expect(reason).not.toContain(password);
	});

	test("a key passed as a flag or an assignment", () => {
		const token = fakeToken();
		// Assembled from parts so no line of this file reads as a credential to the repo's own scan.
		const assignment = [["GITHUB", "TOKEN"].join("_"), token].join("=");
		const flag = ["--api-key", token].join(" ");
		const reason = safeFailureReason(["launcher exited:", assignment, flag].join(" "));
		expect(reason).not.toContain(token);
	});

	test("an absolute home path keeps its shape but not the account name", () => {
		const reason = safeFailureReason(`cannot open ${home("jstuart")}/work/app/.env: no such file`);
		expect(reason).not.toContain("jstuart");
		expect(reason).toContain("~/work/app/.env");
		const linux = safeFailureReason("cannot open /home/deploy/app/run.sh");
		expect(linux).toBe("cannot open ~/app/run.sh");
		const windows = safeFailureReason("cannot open C:\\Users\\Dana\\app\\run.cmd");
		expect(windows).not.toContain("Dana");
	});

	test("root's home, /root and /var/root, becomes ~ whole or with a path under it", () => {
		expect(safeFailureReason("cannot open /root/app/run.sh")).toBe("cannot open ~/app/run.sh");
		expect(safeFailureReason("cannot open /var/root/Library/x")).toBe("cannot open ~/Library/x");
		expect(safeFailureReason("cwd /root: not a directory")).toBe("cwd ~: not a directory");
		expect(safeFailureReason("in (/var/root) and /root.")).toBe("in (~) and ~.");
	});

	test("/root is scrubbed only as a whole component that starts a path", () => {
		for (const kept of [
			"cannot open /opt/app/root/x",
			"cannot open /srv/rootfs/x",
			"cannot open /rooted/x",
			"cannot open /tmp/var/root",
			"cannot open /root-ca.pem",
			"cannot open /root.pem",
		]) {
			expect(safeFailureReason(kept)).toBe(kept);
		}
	});

	test("known gap: a home kept outside the recognised shapes is not scrubbed (the scrub is pattern-based)", () => {
		expect(safeFailureReason("cannot open /srv/alice/app")).toBe("cannot open /srv/alice/app");
		expect(safeFailureReason("run as alice@build-host")).toBe("run as alice@build-host");
	});

	test("a path that isn't a home directory is left alone", () => {
		expect(safeFailureReason("claude is not installed at /usr/local/bin/claude")).toBe(
			"claude is not installed at /usr/local/bin/claude",
		);
	});
});

describe("the cut comes after redaction", () => {
	test("a secret that would straddle the cut is still gone, and the result is within the limit", () => {
		const token = fakeToken();
		// Place the token so the 120-character cut would land in the middle of it.
		const lead = "x".repeat(FAILURE_REASON_MAX_CHARS - 20);
		const reason = safeFailureReason(
			`${lead} ${token} and a long tail ${"t".repeat(200)}`,
		) as string;
		expect(Array.from(reason).length).toBeLessThanOrEqual(FAILURE_REASON_MAX_CHARS);
		expect(reason.endsWith("…")).toBe(true);
		expect(reason).not.toContain(token.slice(0, 12));
	});

	test("redaction can only shorten what is counted: a redacted long error is cut at the limit", () => {
		const reason = safeFailureReason(`${"word ".repeat(100)}`) as string;
		expect(Array.from(reason)).toHaveLength(FAILURE_REASON_MAX_CHARS);
	});

	test("an error that fits after redaction is returned whole", () => {
		expect(safeFailureReason("claude is not installed")).toBe("claude is not installed");
	});
});

describe("the rest of the clean-up", () => {
	test("control characters and runs of whitespace become single spaces; nothing to say is null", () => {
		expect(safeFailureReason("a\n\tb\u0007  c")).toBe("a b c");
		for (const empty of [null, undefined, "", "  \n\t "])
			expect(safeFailureReason(empty)).toBeNull();
	});
});
