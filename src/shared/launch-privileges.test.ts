/**
 * The mapping from a launch's approvalPolicy / sandboxMode to each agent CLI's
 * real settings. Every value of both enums is asserted for both providers, so
 * adding a value (or changing a cell of the table) fails here first.
 */
import { describe, expect, test } from "bun:test";
import { LAUNCHABLE_AGENT_TYPES } from "./constants.js";
import {
	CODEX_SANDBOX_RESPONSE_TYPE,
	LaunchPrivilegeError,
	agentDefaultsWarning,
	describeEffectivePrivileges,
	describeUnsupportedPrivileges,
	privilegeCliArgs,
	requireLaunchPrivileges,
	resolveLaunchPrivileges,
	sanitizeReportedByAgent,
} from "./launch-privileges.js";
import { APPROVAL_POLICIES, SANDBOX_MODES } from "./types.js";

const CLAUDE_ASK = ["--permission-mode", "default"];
const CODEX_ASK = ["--ask-for-approval", "untrusted"];

// null = the value is refused for that provider.
const CLAUDE_APPROVAL: Record<string, string[] | null> = {
	default: [],
	manual: CLAUDE_ASK,
	suggest: CLAUDE_ASK,
	untrusted: CLAUDE_ASK,
	auto: null,
	"on-failure": null,
};
const CLAUDE_SANDBOX: Record<string, string[] | null> = {
	default: [],
	"read-only": null,
	"workspace-write": null,
	// True of Claude Code (nothing confines it), so accepted; it enforces nothing.
	"danger-full-access": [],
};
const CODEX_APPROVAL: Record<string, string[] | null> = {
	default: [],
	manual: CODEX_ASK,
	suggest: CODEX_ASK,
	untrusted: CODEX_ASK,
	auto: null,
	"on-failure": null,
};
const CODEX_SANDBOX: Record<string, string[] | null> = {
	default: [],
	"read-only": ["--sandbox", "read-only"],
	"workspace-write": ["--sandbox", "workspace-write"],
	"danger-full-access": ["--sandbox", "danger-full-access"],
};

describe("the table covers every enum value", () => {
	test("approvalPolicy and sandboxMode expectations list exactly the contract values", () => {
		for (const table of [CLAUDE_APPROVAL, CODEX_APPROVAL]) {
			expect(Object.keys(table).sort()).toEqual([...APPROVAL_POLICIES].sort());
		}
		for (const table of [CLAUDE_SANDBOX, CODEX_SANDBOX]) {
			expect(Object.keys(table).sort()).toEqual([...SANDBOX_MODES].sort());
		}
	});
});

describe("claude_code", () => {
	for (const [value, expected] of Object.entries(CLAUDE_APPROVAL)) {
		test(`approvalPolicy ${value} -> ${expected ? JSON.stringify(expected) : "refused"}`, () => {
			const result = resolveLaunchPrivileges("claude_code", value, null);
			if (expected === null) {
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.errors[0]).toContain(`'${value}'`);
			} else {
				expect(result).toMatchObject({ ok: true, cliArgs: expected, codexThread: null });
			}
		});
	}
	for (const [value, expected] of Object.entries(CLAUDE_SANDBOX)) {
		test(`sandboxMode ${value} -> ${expected ? "no flag" : "refused"}`, () => {
			const result = resolveLaunchPrivileges("claude_code", null, value);
			if (expected === null) {
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.errors[0]).toContain("no sandbox-mode launch flag");
			} else {
				expect(result).toMatchObject({ ok: true, cliArgs: expected });
			}
		});
	}
});

describe("codex_cli", () => {
	for (const [value, expected] of Object.entries(CODEX_APPROVAL)) {
		test(`approvalPolicy ${value} -> ${expected ? JSON.stringify(expected) : "refused"}`, () => {
			const result = resolveLaunchPrivileges("codex_cli", value, null);
			if (expected === null) {
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.errors[0]).toContain(`'${value}'`);
			} else {
				expect(result).toMatchObject({ ok: true, cliArgs: expected });
			}
		});
	}
	for (const [value, expected] of Object.entries(CODEX_SANDBOX)) {
		test(`sandboxMode ${value} -> ${JSON.stringify(expected)}`, () => {
			expect(resolveLaunchPrivileges("codex_cli", null, value)).toMatchObject({
				ok: true,
				cliArgs: expected,
			});
		});
	}

	test("both set: sandbox first, then approval, and the same values as thread/start parameters", () => {
		const result = resolveLaunchPrivileges("codex_cli", "untrusted", "read-only");
		expect(result).toMatchObject({
			ok: true,
			cliArgs: ["--sandbox", "read-only", "--ask-for-approval", "untrusted"],
			codexThread: { approvalPolicy: "untrusted", sandbox: "read-only" },
			agentDefaults: [],
		});
	});

	test("codexThread carries only what was set", () => {
		expect(resolveLaunchPrivileges("codex_cli", null, "workspace-write")).toMatchObject({
			codexThread: { sandbox: "workspace-write" },
		});
		const none = resolveLaunchPrivileges("codex_cli", "default", "default");
		expect(none).toMatchObject({ ok: true, cliArgs: [], codexThread: {} });
		if (none.ok) expect(Object.keys(none.codexThread ?? {})).toEqual([]);
	});

	test("every sandbox value has an expected app-server response type", () => {
		expect(Object.keys(CODEX_SANDBOX_RESPONSE_TYPE).sort()).toEqual(
			["danger-full-access", "read-only", "workspace-write"].sort(),
		);
	});
});

describe("agent defaults are explicit", () => {
	test.each([null, undefined, "default"])(
		"%p adds no flag and is listed as an agent default",
		(v) => {
			for (const agentType of LAUNCHABLE_AGENT_TYPES) {
				const result = resolveLaunchPrivileges(agentType, v, v);
				expect(result).toMatchObject({
					ok: true,
					cliArgs: [],
					agentDefaults: ["approvalPolicy", "sandboxMode"],
				});
			}
		},
	);

	test("an explicit setting is not listed as defaulted", () => {
		expect(resolveLaunchPrivileges("codex_cli", "untrusted", null)).toMatchObject({
			agentDefaults: ["sandboxMode"],
		});
	});

	test("the launch-record line names the defaulted settings and the agent", () => {
		const both = resolveLaunchPrivileges("claude_code", null, null);
		const none = resolveLaunchPrivileges("codex_cli", "untrusted", "read-only");
		if (!both.ok || !none.ok) throw new Error("expected both to resolve");
		expect(agentDefaultsWarning(both)).toBe(
			"No explicit approval policy and sandbox mode: Claude Code will use its own default (no flag is added).",
		);
		expect(agentDefaultsWarning(none)).toBeNull();
	});
});

describe("fail closed", () => {
	const unknownValues: unknown[] = [
		"bogus",
		"",
		" read-only",
		"READ-ONLY",
		"Default",
		"bypassPermissions",
		"never",
		"on-request",
		"full-auto",
		"__proto__",
		"constructor",
		"toString",
		"hasOwnProperty",
		0,
		true,
		{},
		[],
		["default"],
	];

	test("an unknown or malformed approvalPolicy is refused for both providers, never defaulted", () => {
		for (const agentType of LAUNCHABLE_AGENT_TYPES) {
			for (const value of unknownValues) {
				const result = resolveLaunchPrivileges(agentType, value, null);
				expect({ agentType, value, ok: result.ok }).toEqual({ agentType, value, ok: false });
				if (!result.ok) expect(result.errors[0]).toContain("Approval policy");
			}
		}
	});

	test("an unknown or malformed sandboxMode is refused for both providers, never defaulted", () => {
		for (const agentType of LAUNCHABLE_AGENT_TYPES) {
			for (const value of unknownValues) {
				const result = resolveLaunchPrivileges(agentType, null, value);
				expect({ agentType, value, ok: result.ok }).toEqual({ agentType, value, ok: false });
				if (!result.ok) expect(result.errors[0]).toContain("Sandbox mode");
			}
		}
	});

	test("both bad settings are both reported", () => {
		const result = resolveLaunchPrivileges("codex_cli", "auto", "nope");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors).toHaveLength(2);
	});

	test("an agent type with no mapping is refused", () => {
		for (const agentType of ["copilot_cli", "", "nope"]) {
			expect(resolveLaunchPrivileges(agentType, null, null).ok).toBe(false);
		}
	});

	test("requireLaunchPrivileges throws a LaunchPrivilegeError carrying the messages", () => {
		expect(() => requireLaunchPrivileges("claude_code", "auto", null)).toThrow(
			LaunchPrivilegeError,
		);
		try {
			requireLaunchPrivileges("claude_code", null, "read-only");
		} catch (error) {
			expect(error).toBeInstanceOf(LaunchPrivilegeError);
			expect((error as LaunchPrivilegeError).errors[0]).toContain("Sandbox mode 'read-only'");
		}
	});

	test("privilegeCliArgs returns no flags for a refused combination (validation reports the error)", () => {
		expect(privilegeCliArgs("claude_code", "auto", null)).toEqual([]);
		expect(privilegeCliArgs("codex_cli", "untrusted", "bogus")).toEqual([]);
	});
});

describe("broad access only appears when asked for", () => {
	const approvals = [null, ...APPROVAL_POLICIES];
	const sandboxes = [null, ...SANDBOX_MODES];
	const forbidden = [
		"bypassPermissions",
		"acceptEdits",
		"dontAsk",
		"never",
		"--dangerously-skip-permissions",
		"--allow-dangerously-skip-permissions",
		"--dangerously-bypass-approvals-and-sandbox",
		"--allowedTools",
		"--disallowedTools",
	];

	test("across every provider and every pair of values, no bypass flag or value is ever produced", () => {
		let checked = 0;
		for (const agentType of LAUNCHABLE_AGENT_TYPES) {
			for (const approval of approvals) {
				for (const sandbox of sandboxes) {
					const result = resolveLaunchPrivileges(agentType, approval, sandbox);
					if (!result.ok) continue;
					checked++;
					for (const token of result.cliArgs) expect(forbidden).not.toContain(token);
					for (const value of Object.values(result.codexThread ?? {})) {
						expect(forbidden).not.toContain(value);
					}
				}
			}
		}
		expect(checked).toBeGreaterThan(30);
	});

	test("danger-full-access appears exactly when codex_cli is launched with sandboxMode danger-full-access", () => {
		let withFullAccess = 0;
		for (const agentType of LAUNCHABLE_AGENT_TYPES) {
			for (const approval of approvals) {
				for (const sandbox of sandboxes) {
					const result = resolveLaunchPrivileges(agentType, approval, sandbox);
					if (!result.ok) continue;
					const appears =
						result.cliArgs.includes("danger-full-access") ||
						result.codexThread?.sandbox === "danger-full-access";
					const requested = agentType === "codex_cli" && sandbox === "danger-full-access";
					expect({ agentType, approval, sandbox, appears }).toEqual({
						agentType,
						approval,
						sandbox,
						appears: requested,
					});
					if (appears) withFullAccess++;
				}
			}
		}
		// null, default, manual, suggest, untrusted (auto and on-failure are refused outright)
		expect(withFullAccess).toBe(5);
	});

	test("danger-full-access is never inferred from another setting or from a default", () => {
		for (const sandbox of [null, "default", "read-only", "workspace-write"]) {
			const result = resolveLaunchPrivileges("codex_cli", "untrusted", sandbox);
			if (result.ok) expect(result.cliArgs).not.toContain("danger-full-access");
		}
		// On Claude it is accepted as the agent's own (unsandboxed) behaviour: no flag, nothing enforced.
		expect(resolveLaunchPrivileges("claude_code", null, "danger-full-access")).toMatchObject({
			ok: true,
			cliArgs: [],
			agentDefaults: ["approvalPolicy", "sandboxMode"],
		});
	});
});

describe("effective privileges", () => {
	test("Claude Code default: no sandbox, which is permissive, and the permission mode is the host's", () => {
		const e = describeEffectivePrivileges("claude_code", null, null);
		expect(e).toMatchObject({
			agentType: "claude_code",
			enforcedArgs: [],
			approvalPolicy: {
				requested: null,
				source: "agent_default",
				permissive: true,
				hostDependent: true,
			},
			sandboxMode: {
				requested: null,
				source: "agent_default",
				permissive: true,
				hostDependent: false,
			},
		});
		expect(e?.sandboxMode.effective).toContain("no sandbox");
		expect(e?.defaultMeaning).toContain("Claude Code's own default");
		expect(e?.defaultMeaning).toContain(".claude/settings.json");
		expect(e?.enforcementScope).toContain("can still widen");
	});

	test("Codex default is host-defined and says what it is with no config", () => {
		const e = describeEffectivePrivileges("codex_cli", "default", "default");
		expect(e).toMatchObject({
			approvalPolicy: { requested: "default", source: "agent_default", hostDependent: true },
			sandboxMode: { requested: "default", source: "agent_default", hostDependent: true },
		});
		expect(e?.sandboxMode.effective).toContain("read-only");
		expect(e?.defaultMeaning).toContain("on-request");
	});

	test("explicit settings report the enforced value, not host dependent, permissive only for full access", () => {
		const ro = describeEffectivePrivileges("codex_cli", "untrusted", "read-only");
		expect(ro).toMatchObject({
			enforcedArgs: ["--sandbox", "read-only", "--ask-for-approval", "untrusted"],
			approvalPolicy: {
				source: "explicit",
				effective: "untrusted",
				permissive: false,
				hostDependent: false,
			},
			sandboxMode: {
				source: "explicit",
				effective: "read-only",
				permissive: false,
				hostDependent: false,
			},
		});
		const full = describeEffectivePrivileges("codex_cli", null, "danger-full-access");
		expect(full?.sandboxMode).toMatchObject({ effective: "danger-full-access", permissive: true });
		const claude = describeEffectivePrivileges("claude_code", "manual", null);
		expect(claude?.approvalPolicy).toMatchObject({
			requested: "manual",
			source: "explicit",
			effective: "default",
		});
	});

	test("null when the mapping refuses the values", () => {
		expect(describeEffectivePrivileges("claude_code", "auto", null)).toBeNull();
		expect(describeEffectivePrivileges("codex_cli", null, "bogus")).toBeNull();
		expect(describeEffectivePrivileges("copilot_cli", null, null)).toBeNull();
	});
});

describe("Claude danger-full-access", () => {
	test("is reported as the agent default, permissive, and enforces nothing", () => {
		const e = describeEffectivePrivileges("claude_code", null, "danger-full-access");
		expect(e).toMatchObject({
			enforcedArgs: [],
			sandboxMode: { requested: "danger-full-access", source: "agent_default", permissive: true },
		});
	});
});

describe("privilegesUnsupported", () => {
	test("auto and on-failure carry a suggested replacement of manual", () => {
		for (const value of ["auto", "on-failure"]) {
			for (const agentType of ["claude_code", "codex_cli"]) {
				const u = describeUnsupportedPrivileges(agentType, value, null);
				expect(u?.issues).toHaveLength(1);
				expect(u?.issues[0]).toMatchObject({
					setting: "approvalPolicy",
					value,
					suggested: "manual",
				});
			}
		}
	});

	test("a Claude template's read-only or workspace-write sandbox is flagged with a clear-it suggestion", () => {
		const u = describeUnsupportedPrivileges("claude_code", null, "read-only");
		expect(u?.issues[0]).toMatchObject({
			setting: "sandboxMode",
			value: "read-only",
			suggested: null,
		});
		expect(describeUnsupportedPrivileges("codex_cli", null, "read-only")).toBeNull();
	});

	test("nothing is flagged for supported or unset values", () => {
		expect(describeUnsupportedPrivileges("claude_code", "manual", "danger-full-access")).toBeNull();
		expect(describeUnsupportedPrivileges("codex_cli", null, null)).toBeNull();
		expect(describeUnsupportedPrivileges("copilot_cli", "auto", null)).toBeNull();
	});
});

describe("reported by the agent", () => {
	test("a Codex default that came back as dangerFullAccess or never is marked permissive", () => {
		const e = describeEffectivePrivileges("codex_cli", null, null, {
			approvalPolicy: "never",
			sandbox: "dangerFullAccess",
			permissive: true,
		});
		expect(e?.approvalPolicy).toMatchObject({ permissive: true, hostDependent: false });
		expect(e?.sandboxMode).toMatchObject({ permissive: true, hostDependent: false });
		expect(e?.sandboxMode.effective).toContain("dangerFullAccess");
		expect(e?.reportedByAgent?.sandbox).toBe("dangerFullAccess");
	});

	test("a modest echo is not marked permissive", () => {
		const e = describeEffectivePrivileges("codex_cli", null, null, {
			approvalPolicy: "on-request",
			sandbox: "readOnly",
		});
		expect(e?.approvalPolicy.permissive).toBe(false);
		expect(e?.sandboxMode.permissive).toBe(false);
	});
});

describe("sanitizeReportedByAgent", () => {
	test("cuts every string and list to a bounded size and drops what isn't a report", () => {
		const out = sanitizeReportedByAgent({
			approvalPolicy: "a".repeat(1000),
			sandbox: { not: "a string" },
			networkAccess: "yes",
			writableRoots: Array.from({ length: 100 }, () => "/p".repeat(500)),
			permissive: "true",
		});
		expect(String(out?.approvalPolicy).length).toBeLessThanOrEqual(67);
		expect(typeof out?.sandbox).toBe("string");
		expect(out?.networkAccess).toBeNull();
		expect(out?.writableRoots).toHaveLength(20);
		expect(Math.max(...(out?.writableRoots ?? []).map((r) => r.length))).toBeLessThanOrEqual(259);
		expect(out?.permissive).toBe(false);
		expect(sanitizeReportedByAgent(null)).toBeNull();
		expect(sanitizeReportedByAgent("text")).toBeNull();
	});
});
