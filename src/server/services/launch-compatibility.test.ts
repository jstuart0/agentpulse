import { describe, expect, test } from "bun:test";
import type {
	PrelaunchAction,
	SessionTemplateInput,
	SupervisorRecord,
} from "../../shared/types.js";
import { pickFirstCapableSupervisor, supervisorSupportsPrelaunch } from "./launch-compatibility.js";

function makeSupervisor(overrides: Partial<SupervisorRecord> = {}): SupervisorRecord {
	const features = overrides.capabilities?.features ?? [
		"can_write_claude_md",
		"can_run_prelaunch_actions",
		"can_scaffold_workarea",
		"can_clone_repo",
		"headless_claude",
	];
	return {
		id: overrides.id ?? "sup-1",
		hostName: overrides.hostName ?? "test-host",
		platform: "darwin",
		arch: "arm64",
		version: "0.2.0",
		capabilities: {
			version: 1,
			agentTypes: ["claude_code"],
			launchModes: ["headless"],
			os: "macos",
			terminalSupport: [],
			features,
			executables: {
				claude: {
					available: true,
					command: "claude",
					resolvedPath: "/usr/bin/claude",
					source: "auto",
				},
			},
			...(overrides.capabilities ?? {}),
		},
		trustedRoots: overrides.trustedRoots ?? ["/tmp/work"],
		status: overrides.status ?? "connected",
		capabilitySchemaVersion: 1,
		configSchemaVersion: 1,
		lastHeartbeatAt: new Date().toISOString(),
		heartbeatLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
		enrollmentState: "active",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

function makeTemplate(overrides: Partial<SessionTemplateInput> = {}): SessionTemplateInput {
	return {
		name: "Test",
		agentType: "claude_code",
		cwd: "/tmp/work/proj",
		baseInstructions: "",
		taskPrompt: "do the thing",
		...overrides,
	};
}

const scaffoldAction: PrelaunchAction = {
	kind: "scaffold_workarea",
	path: "/tmp/work/proj",
	gitInit: false,
	seedClaudeMd: { content: "x", path: "CLAUDE.md", sha256: "deadbeef" },
};

const cloneAction: PrelaunchAction = {
	kind: "clone_repo",
	url: "https://github.com/foo/bar.git",
	intoPath: "/tmp/work/bar",
	timeoutSeconds: 300,
};

describe("supervisorSupportsPrelaunch", () => {
	test("returns ok when actions list is empty/undefined", () => {
		const sup = makeSupervisor();
		expect(supervisorSupportsPrelaunch(sup, undefined).ok).toBe(true);
		expect(supervisorSupportsPrelaunch(sup, []).ok).toBe(true);
	});

	test("returns ok when supervisor advertises both flags", () => {
		const sup = makeSupervisor();
		const r = supervisorSupportsPrelaunch(sup, [scaffoldAction]);
		expect(r.ok).toBe(true);
		expect(r.missing).toEqual([]);
	});

	test("flags missing can_run_prelaunch_actions", () => {
		const sup = makeSupervisor({
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "macos",
				terminalSupport: [],
				features: ["can_scaffold_workarea"],
			},
		});
		const r = supervisorSupportsPrelaunch(sup, [scaffoldAction]);
		expect(r.ok).toBe(false);
		expect(r.missing).toContain("can_run_prelaunch_actions");
	});

	test("flags missing can_scaffold_workarea even when can_run_prelaunch_actions is present", () => {
		const sup = makeSupervisor({
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "macos",
				terminalSupport: [],
				features: ["can_run_prelaunch_actions"],
			},
		});
		const r = supervisorSupportsPrelaunch(sup, [scaffoldAction]);
		expect(r.ok).toBe(false);
		expect(r.missing).toEqual(["can_scaffold_workarea"]);
	});

	test("does not duplicate the same missing flag for repeated actions", () => {
		const sup = makeSupervisor({
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "macos",
				terminalSupport: [],
				features: ["can_run_prelaunch_actions"],
			},
		});
		const r = supervisorSupportsPrelaunch(sup, [scaffoldAction, scaffoldAction]);
		expect(r.missing.filter((m) => m === "can_scaffold_workarea")).toHaveLength(1);
	});

	test("clone_repo passes when supervisor advertises both flags", () => {
		const sup = makeSupervisor();
		const r = supervisorSupportsPrelaunch(sup, [cloneAction]);
		expect(r.ok).toBe(true);
		expect(r.missing).toEqual([]);
	});

	test("clone_repo flags missing can_clone_repo even when can_run_prelaunch_actions is present", () => {
		const sup = makeSupervisor({
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "macos",
				terminalSupport: [],
				features: ["can_run_prelaunch_actions"],
			},
		});
		const r = supervisorSupportsPrelaunch(sup, [cloneAction]);
		expect(r.ok).toBe(false);
		expect(r.missing).toEqual(["can_clone_repo"]);
	});

	test("clone_repo flags missing can_run_prelaunch_actions when only action-specific flag is present", () => {
		const sup = makeSupervisor({
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "macos",
				terminalSupport: [],
				features: ["can_clone_repo"],
			},
		});
		const r = supervisorSupportsPrelaunch(sup, [cloneAction]);
		expect(r.ok).toBe(false);
		expect(r.missing).toContain("can_run_prelaunch_actions");
	});

	test("mixed array (scaffold + clone) requires BOTH can_scaffold_workarea AND can_clone_repo", () => {
		const sup = makeSupervisor({
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "macos",
				terminalSupport: [],
				features: ["can_run_prelaunch_actions"],
			},
		});
		const r = supervisorSupportsPrelaunch(sup, [scaffoldAction, cloneAction]);
		expect(r.ok).toBe(false);
		expect(r.missing).toContain("can_scaffold_workarea");
		expect(r.missing).toContain("can_clone_repo");
	});

	test("mixed array passes when both action flags are present", () => {
		const sup = makeSupervisor();
		const r = supervisorSupportsPrelaunch(sup, [scaffoldAction, cloneAction]);
		expect(r.ok).toBe(true);
	});
});

describe("pickFirstCapableSupervisor with prelaunchActions", () => {
	test("returns a supervisor that has both required flags", () => {
		const sup = makeSupervisor();
		const picked = pickFirstCapableSupervisor(makeTemplate(), "headless", [sup], [scaffoldAction]);
		expect(picked?.id).toBe("sup-1");
	});

	test("rejects a supervisor missing can_scaffold_workarea even when it has can_run_prelaunch_actions", () => {
		const sup = makeSupervisor({
			id: "no-scaffold",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "macos",
				terminalSupport: [],
				features: ["can_run_prelaunch_actions"],
				executables: {
					claude: {
						available: true,
						command: "claude",
						resolvedPath: "/usr/bin/claude",
						source: "auto",
					},
				},
			},
		});
		const picked = pickFirstCapableSupervisor(makeTemplate(), "headless", [sup], [scaffoldAction]);
		expect(picked).toBeNull();
	});

	test("filters out non-capable supervisors but keeps capable ones in the same pool", () => {
		const noScaffold = makeSupervisor({
			id: "no-scaffold",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "macos",
				terminalSupport: [],
				features: ["can_run_prelaunch_actions"],
				executables: {
					claude: {
						available: true,
						command: "claude",
						resolvedPath: "/usr/bin/claude",
						source: "auto",
					},
				},
			},
		});
		const capable = makeSupervisor({ id: "capable" });
		const picked = pickFirstCapableSupervisor(
			makeTemplate(),
			"headless",
			[noScaffold, capable],
			[scaffoldAction],
		);
		expect(picked?.id).toBe("capable");
	});

	test("does not change supervisor selection when LaunchSpec has no prelaunchActions", () => {
		const sup = makeSupervisor({
			id: "no-flags",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "macos",
				terminalSupport: [],
				features: ["headless_claude"],
				executables: {
					claude: {
						available: true,
						command: "claude",
						resolvedPath: "/usr/bin/claude",
						source: "auto",
					},
				},
			},
		});
		const picked = pickFirstCapableSupervisor(makeTemplate(), "headless", [sup]);
		expect(picked?.id).toBe("no-flags");
	});
});
