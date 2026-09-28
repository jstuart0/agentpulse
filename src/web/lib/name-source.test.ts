import { describe, expect, test } from "bun:test";
import type { AgentType, Session } from "../../shared/types.js";
import {
	applyManualRename,
	nameSourceCaption,
	resetButtonState,
	shouldShowPin,
} from "./name-source.js";

describe("shouldShowPin — truth table over nameSource x nativeName x hasNameSource (D14)", () => {
	test("false when nameSource is not 'user'", () => {
		expect(shouldShowPin("native", null, "claude_code")).toBe(false);
		expect(shouldShowPin("generated", "codex-thread-name", "claude_code")).toBe(false);
	});

	test("true when nameSource is 'user' and nativeName is non-null", () => {
		expect(shouldShowPin("user", "codex-thread-name", "claude_code")).toBe(true);
	});

	test("true when nameSource is 'user' and the agent hasNameSource, even with nativeName null", () => {
		expect(shouldShowPin("user", null, "claude_code")).toBe(true);
		expect(shouldShowPin("user", null, "codex_cli")).toBe(true);
	});
});

describe("nameSourceCaption — copy strings for each nameSource (D14)", () => {
	test("'user' with a differing nativeName adds the agent-name suffix", () => {
		const caption = nameSourceCaption(
			"user",
			"codex-thread-name",
			"human-chosen-name",
			"codex_cli",
		);
		expect(caption).toContain("Pinned by you");
		expect(caption).toContain("codex-thread-name");
	});

	test("'user' with nativeName === displayName omits the suffix", () => {
		const caption = nameSourceCaption("user", "same-name", "same-name", "codex_cli");
		expect(caption).toBe("Pinned by you");
	});

	test("'user' with nativeName null still shows the caption (Claude/Codex hasNameSource)", () => {
		const caption = nameSourceCaption("user", null, "human-chosen-name", "claude_code");
		expect(caption).toBe("Pinned by you");
	});

	test("'native' shows a muted 'from <shortLabel>' caption", () => {
		expect(nameSourceCaption("native", "codex-thread-name", "codex-thread-name", "codex_cli")).toBe(
			"from Codex",
		);
		expect(
			nameSourceCaption("native", "claude-native-name", "claude-native-name", "claude_code"),
		).toBe("from Claude");
	});

	test("'generated' has no caption", () => {
		expect(nameSourceCaption("generated", null, "brave-falcon", "claude_code")).toBeNull();
	});
});

describe("resetButtonState — idle -> pending -> error -> idle (D14)", () => {
	test("start moves idle to pending", () => {
		expect(resetButtonState("idle", "start")).toBe("pending");
	});

	test("error moves pending to error", () => {
		expect(resetButtonState("pending", "error")).toBe("error");
	});

	test("reset (retry) moves error back to idle", () => {
		expect(resetButtonState("error", "reset")).toBe("idle");
	});

	test("success moves pending back to idle", () => {
		expect(resetButtonState("pending", "success")).toBe("idle");
	});
});

// ruby F101: an agent type the web bundle doesn't know yet (a newer server,
// or a legacy row) must not crash the header.
describe("unknown agent types fall back safely (F101)", () => {
	const unknown = "future_cli" as AgentType;

	test("shouldShowPin treats an unknown agent as unable to report a name", () => {
		expect(shouldShowPin("user", null, unknown)).toBe(false);
		expect(shouldShowPin("user", "reported", unknown)).toBe(true);
	});

	test("nameSourceCaption uses a generic label", () => {
		expect(nameSourceCaption("native", "n", "n", unknown)).toBe("from agent");
		expect(nameSourceCaption("user", null, "x", unknown)).toBe("Pinned by you");
	});
});

// ruby F95: a local manual rename must flip the caption to the pin at once,
// not keep "from <agent>" until the next poll.
describe("applyManualRename (F95)", () => {
	const base = {
		sessionId: "s1",
		displayName: "codex-title",
		nameSource: "native",
		nativeName: "codex-title",
	} as Session;

	test("sets displayName and nameSource together, keeps nativeName", () => {
		const next = applyManualRename(base, "my-manual-name");
		expect(next.displayName).toBe("my-manual-name");
		expect(next.nameSource).toBe("user");
		expect(next.nativeName).toBe("codex-title");
		expect(base.displayName).toBe("codex-title");
	});
});
