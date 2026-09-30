import { describe, expect, test } from "bun:test";
import type { AgentType, Session } from "../../shared/types.js";
import {
	applyManualRename,
	nameSourceCaption,
	nameSourceTitle,
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
		expect(caption).toContain("Renamed by you");
		expect(caption).toContain("codex-thread-name");
	});

	test("'user' with nativeName === displayName omits the suffix", () => {
		const caption = nameSourceCaption("user", "same-name", "same-name", "codex_cli");
		expect(caption).toBe("Renamed by you");
	});

	test("'user' with nativeName null still shows the caption (Claude/Codex hasNameSource)", () => {
		const caption = nameSourceCaption("user", null, "human-chosen-name", "claude_code");
		expect(caption).toBe("Renamed by you");
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
		expect(nameSourceCaption("user", null, "x", unknown)).toBe("Renamed by you");
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

describe("nameSourceTitle — the caption's tooltip (D26/F98/F199)", () => {
	test("'user' explains that the agent's names won't replace the rename", () => {
		expect(nameSourceTitle("user", null, "human-chosen-name", "codex_cli")).toBe(
			"You renamed this session, so names from Codex won't replace it.",
		);
		expect(nameSourceTitle("user", null, "human-chosen-name", "claude_code")).toBe(
			"You renamed this session, so names from Claude won't replace it.",
		);
	});

	test("an unknown agent gets a generic label", () => {
		expect(nameSourceTitle("user", null, "human-chosen-name", "some_future_agent" as never)).toBe(
			"You renamed this session, so names from the agent won't replace it.",
		);
	});

	// F199: the caption's own text (which carries the agent name when it
	// differs) was lost once this tooltip replaced it — folded back in here.
	test("a differing nativeName is folded into the tooltip", () => {
		expect(nameSourceTitle("user", "codex-thread-name", "human-chosen-name", "codex_cli")).toBe(
			'You renamed this session, so names from Codex won\'t replace it. Agent name: "codex-thread-name"',
		);
	});

	test("nativeName === displayName omits the agent-name suffix", () => {
		expect(nameSourceTitle("user", "same-name", "same-name", "codex_cli")).toBe(
			"You renamed this session, so names from Codex won't replace it.",
		);
	});

	test("nativeName null omits the agent-name suffix", () => {
		expect(nameSourceTitle("user", null, "human-chosen-name", "claude_code")).toBe(
			"You renamed this session, so names from Claude won't replace it.",
		);
	});

	test("'native' and 'generated' have no tooltip beyond the caption", () => {
		expect(nameSourceTitle("native", "n", "n", "codex_cli")).toBeNull();
		expect(nameSourceTitle("generated", null, "brave-falcon", "codex_cli")).toBeNull();
	});
});
