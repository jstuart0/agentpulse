/**
 * Ad-hoc parser smoke tests for Phase B reply parsers and cancel keyword check.
 * Run with: bun run scripts/smoke-parsers.ts
 */

// Replicate the parsers inline (they're not exported, but we can test via the
// exported isCancelKeyword + by importing the handler directly).
// Actually isCancelKeyword IS exported. For parsers, we test through behavior.

import { isCancelKeyword } from "../src/server/services/ask/ask-add-project-handler.js";

let passed = 0;
let failed = 0;

function expect(label: string, actual: unknown, expected: unknown): void {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) {
		console.log(`  ✓ ${label}`);
		passed++;
	} else {
		console.error(`  ✗ ${label}`);
		console.error(`    expected: ${JSON.stringify(expected)}`);
		console.error(`    actual:   ${JSON.stringify(actual)}`);
		failed++;
	}
}

// ---- Inline parser definitions (same logic as the handler) -----------

function parseName(reply: string): { ok: true; value: string } | { ok: false } {
	const v = reply.trim();
	if (v.length === 0 || v.length > 80) return { ok: false };
	return { ok: true, value: v };
}

function parseCwd(reply: string): { ok: true; value: string } | { ok: false } {
	const v = reply.trim();
	if (!v.startsWith("/")) return { ok: false };
	return { ok: true, value: v };
}

function parseDefaultAgentType(reply: string): { ok: true; value: string | null } | { ok: false } {
	const v = reply.trim().toLowerCase();
	if (v === "1" || v === "claude" || v === "claude_code" || v.includes("claude code"))
		return { ok: true, value: "claude_code" };
	if (v === "2" || v === "codex" || v === "codex_cli" || v.includes("codex cli"))
		return { ok: true, value: "codex_cli" };
	if (v === "3" || v === "skip" || v === "none" || v === "no default")
		return { ok: true, value: null };
	return { ok: false };
}

function parseDefaultLaunchMode(reply: string): { ok: true; value: string | null } | { ok: false } {
	const v = reply.trim().toLowerCase();
	if (v === "1" || v === "interactive_terminal" || v.includes("interactive"))
		return { ok: true, value: "interactive_terminal" };
	if (v === "2" || v === "headless") return { ok: true, value: "headless" };
	if (v === "3" || v === "managed_codex" || v.includes("managed"))
		return { ok: true, value: "managed_codex" };
	if (v === "4" || v === "skip" || v === "none") return { ok: true, value: null };
	return { ok: false };
}

function parseDefaultModel(reply: string): { ok: true; value: string | null } | { ok: false } {
	const v = reply.trim();
	if (v.toLowerCase() === "skip" || v === "") return { ok: true, value: null };
	return { ok: true, value: v };
}

function parseGithubRepoUrl(reply: string): { ok: true; value: string | null } | { ok: false } {
	const v = reply.trim();
	if (v.toLowerCase() === "skip" || v === "") return { ok: true, value: null };
	if (v.startsWith("https://")) return { ok: true, value: v };
	return { ok: false };
}

// ---- name parser tests -----------------------------------------------
console.log("\nname parser:");
expect("'myapp' → ok", parseName("myapp"), { ok: true, value: "myapp" });
expect("'' → reject", parseName(""), { ok: false });
expect("81-char string → reject", parseName("a".repeat(81)), { ok: false });
expect("'  spaces  ' → trim and accept", parseName("  spaces  "), { ok: true, value: "spaces" });
expect("80-char string → accept", parseName("a".repeat(80)), { ok: true, value: "a".repeat(80) });

// ---- cwd parser tests ------------------------------------------------
console.log("\ncwd parser:");
expect("'/abs/path' → ok", parseCwd("/abs/path"), { ok: true, value: "/abs/path" });
expect("'rel/path' → reject", parseCwd("rel/path"), { ok: false });
expect("'' → reject", parseCwd(""), { ok: false });
expect("'  /trimmed  ' → trim and accept", parseCwd("  /trimmed  "), {
	ok: true,
	value: "/trimmed",
});

// ---- defaultAgentType parser tests -----------------------------------
console.log("\ndefaultAgentType parser:");
expect("'1' → claude_code", parseDefaultAgentType("1"), { ok: true, value: "claude_code" });
expect("'2' → codex_cli", parseDefaultAgentType("2"), { ok: true, value: "codex_cli" });
expect("'3' → null (skip)", parseDefaultAgentType("3"), { ok: true, value: null });
expect("'skip' → null", parseDefaultAgentType("skip"), { ok: true, value: null });
expect("'claude' → claude_code", parseDefaultAgentType("claude"), {
	ok: true,
	value: "claude_code",
});
expect("'codex' → codex_cli", parseDefaultAgentType("codex"), { ok: true, value: "codex_cli" });
expect("'nonsense' → reject", parseDefaultAgentType("nonsense"), { ok: false });

// ---- defaultLaunchMode parser tests ----------------------------------
console.log("\ndefaultLaunchMode parser:");
expect("'1' → interactive_terminal", parseDefaultLaunchMode("1"), {
	ok: true,
	value: "interactive_terminal",
});
expect("'2' → headless", parseDefaultLaunchMode("2"), { ok: true, value: "headless" });
expect("'3' → managed_codex", parseDefaultLaunchMode("3"), {
	ok: true,
	value: "managed_codex",
});
expect("'4' → null", parseDefaultLaunchMode("4"), { ok: true, value: null });
expect("'skip' → null", parseDefaultLaunchMode("skip"), { ok: true, value: null });

// ---- defaultModel parser tests ---------------------------------------
console.log("\ndefaultModel parser:");
expect("'claude-opus-4-5' → ok", parseDefaultModel("claude-opus-4-5"), {
	ok: true,
	value: "claude-opus-4-5",
});
expect("'skip' → null", parseDefaultModel("skip"), { ok: true, value: null });
expect("'' → null", parseDefaultModel(""), { ok: true, value: null });

// ---- githubRepoUrl parser tests -------------------------------------
console.log("\ngithubRepoUrl parser:");
expect("'https://github.com/foo/bar' → ok", parseGithubRepoUrl("https://github.com/foo/bar"), {
	ok: true,
	value: "https://github.com/foo/bar",
});
expect("'skip' → null", parseGithubRepoUrl("skip"), { ok: true, value: null });
expect("'' → null", parseGithubRepoUrl(""), { ok: true, value: null });
expect("'ftp://foo' → reject", parseGithubRepoUrl("ftp://foo"), { ok: false });
expect("'http://foo' → reject", parseGithubRepoUrl("http://foo"), { ok: false });

// ---- cancel keyword tests -------------------------------------------
// Spec: exact match after trim().toLowerCase()
console.log("\ncancel keyword check (exact match after trim+lower):");
expect("'cancel' matches", isCancelKeyword("cancel"), true);
expect("'Cancel' matches", isCancelKeyword("Cancel"), true);
expect("'  abort  ' matches", isCancelKeyword("  abort  "), true);
expect("'never mind' matches", isCancelKeyword("never mind"), true);
expect("'nevermind' matches", isCancelKeyword("nevermind"), true);
expect("'stop drafting' matches", isCancelKeyword("stop drafting"), true);
// Negatives — these do NOT match (exact equality, not substring)
expect("'cancellation' does NOT match", isCancelKeyword("cancellation"), false);
expect(
	"'i should cancel my plans' does NOT match",
	isCancelKeyword("i should cancel my plans"),
	false,
);

// ---- Summary --------------------------------------------------------
console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
