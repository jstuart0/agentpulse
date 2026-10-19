/**
 * Version skew: a supervisor that doesn't advertise `enforces_launch_privileges` would
 * ignore the approval policy and sandbox mode while the app shows them as enforced. It must
 * never receive such a launch: not at validation, routing, retry or claim, and a launch whose
 * supervisor reports flags other than the expected ones is failed.
 *
 * DB-touching: runs on both dialects.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "./ai/__test_db.js";
import type {
	LaunchMode,
	LaunchRequestInput,
	SessionTemplateInput,
	SupervisorRecord,
} from "../../shared/types.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { controlActions, launchRequests, managedSessions, sessions, supervisors } = await import(
	"../db/schema/index.js"
);
const { buildLaunchSpec, pickFirstCapableSupervisor, validateAgainstSupervisor } = await import(
	"./launch-compatibility.js"
);
const { createValidatedLaunchRequest } = await import("./launch-validator.js");
const { claimNextLaunchRequest, updateLaunchDispatchStatus, privilegeMismatch } = await import(
	"./launch-dispatch.js"
);
const { queuePromptAction, retryLaunchForSession } = await import("./control-actions.js");
const { listSupervisors } = await import("./supervisor-registry.js");
const { normalizeTemplateInput, validateTemplateInput } = await import("./template-preview.js");

beforeAll(() => initializeDatabase());

beforeEach(async () => {
	await getDb().delete(controlActions).execute();
	await getDb().delete(managedSessions).execute();
	await getDb().delete(launchRequests).execute();
	await getDb().delete(sessions).execute();
	await getDb().delete(supervisors).execute();
});

const ACTOR = { userId: "user-skew", label: "user" as const };

function template(over: Partial<SessionTemplateInput> = {}): SessionTemplateInput {
	return {
		name: "t",
		description: null,
		agentType: "claude_code",
		cwd: "/tmp/ap-skew",
		baseInstructions: "i",
		taskPrompt: "p",
		model: "m1",
		approvalPolicy: null,
		sandboxMode: null,
		env: {},
		tags: [],
		isFavorite: false,
		...over,
	};
}

async function seedHost(id: string, features: string[]): Promise<string> {
	const now = new Date().toISOString();
	await getDb()
		.insert(supervisors)
		.values({
			id,
			hostName: `host-${id}`,
			platform: "linux",
			arch: "x64",
			version: "1.0.0",
			capabilities: {
				version: 1,
				agentTypes: ["claude_code", "codex_cli"],
				launchModes: ["headless", "interactive_terminal", "managed_codex"],
				os: "linux",
				terminalSupport: ["xterm"],
				features,
				executables: {
					claude: { available: true, command: "claude", resolvedPath: "/bin/claude" },
					codex: { available: true, command: "codex", resolvedPath: "/bin/codex" },
				},
			},
			trustedRoots: ["/tmp"],
			status: "connected",
			lastHeartbeatAt: now,
			heartbeatLeaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			createdAt: now,
			updatedAt: now,
		} as never);
	return id;
}

const OLD = ["headless_claude"];
const NEW = ["headless_claude", "enforces_launch_privileges"];

function input(t: SessionTemplateInput, mode: LaunchMode, hostId?: string): LaunchRequestInput {
	return {
		template: t,
		requestedLaunchMode: mode,
		...(hostId
			? { requestedSupervisorId: hostId }
			: { routingPolicy: "first_capable_host" as const }),
		launchSpec: buildLaunchSpec(t, mode, {} as SupervisorRecord),
	};
}

async function hosts() {
	return listSupervisors();
}

describe("validation and routing", () => {
	test("a host without the feature is refused any launch with a policy or sandbox set, and not one without", async () => {
		await seedHost("old", OLD);
		const [host] = await hosts();
		const cases: Array<[Partial<SessionTemplateInput>, boolean]> = [
			[{}, false],
			[{ approvalPolicy: "manual" }, true],
			[{ approvalPolicy: "default" }, true],
			[{ agentType: "codex_cli", sandboxMode: "read-only" }, true],
		];
		for (const [over, refused] of cases) {
			const { errors } = validateAgainstSupervisor(
				template(over),
				host,
				over.agentType === "codex_cli" ? "managed_codex" : "headless",
			);
			expect(
				errors.some((e) => e.includes("older supervisor")),
				JSON.stringify(over),
			).toBe(refused);
		}
	});

	test("first_capable_host skips the old host and picks the new one", async () => {
		await seedHost("old", OLD);
		await seedHost("new", NEW);
		const all = await hosts();
		const picked = pickFirstCapableSupervisor(
			template({ approvalPolicy: "manual" }),
			"headless",
			all,
		);
		expect(picked?.id).toBe("new");
		expect(
			pickFirstCapableSupervisor(
				template({ approvalPolicy: "manual" }),
				"headless",
				all.filter((h) => h.id === "old"),
			),
		).toBeNull();
	});

	test("a launch targeted at an old host is rejected with the reason, and stored as rejected", async () => {
		await seedHost("old", OLD);
		const { launchRequest } = await createValidatedLaunchRequest(
			input(template({ approvalPolicy: "manual" }), "headless", "old"),
			ACTOR,
		);
		expect(launchRequest.status).toBe("rejected");
		expect(launchRequest.error).toContain("older supervisor");
	});

	test("the same launch with no policy set is fine on the old host", async () => {
		await seedHost("old", OLD);
		const { launchRequest } = await createValidatedLaunchRequest(
			input(template(), "headless", "old"),
			ACTOR,
		);
		expect(launchRequest.status).toBe("validated");
	});

	test("headless Claude with a permission mode warns that nobody can approve", async () => {
		await seedHost("new", NEW);
		const { launchRequest } = await createValidatedLaunchRequest(
			input(template({ approvalPolicy: "manual" }), "headless", "new"),
			ACTOR,
		);
		expect(launchRequest.validationWarnings.some((w) => w.includes("nobody to approve"))).toBe(
			true,
		);
		const none = await createValidatedLaunchRequest(input(template(), "headless", "new"), ACTOR);
		expect(none.launchRequest.validationWarnings.some((w) => w.includes("nobody to approve"))).toBe(
			false,
		);
	});
});

async function seedValidated(
	hostId: string,
	over: Partial<typeof launchRequests.$inferInsert> = {},
) {
	const id = crypto.randomUUID();
	await getDb()
		.insert(launchRequests)
		.values({
			id,
			launchCorrelationId: crypto.randomUUID(),
			agentType: "claude_code",
			cwd: "/tmp/ap-skew",
			requestedSupervisorId: hostId,
			status: "validated",
			...over,
		});
	return id;
}

describe("claim time", () => {
	test("a validated launch with a policy is failed, not handed to a host that lost the feature", async () => {
		await seedHost("h", OLD);
		const id = await seedValidated("h", { approvalPolicy: "manual" });
		expect(await claimNextLaunchRequest("h")).toBeNull();
		const [row] = await getDb().select().from(launchRequests).where(eq(launchRequests.id, id));
		expect(row.status).toBe("failed");
		expect(row.error).toContain("older than");
		expect(row.claimToken).toBeNull();
	});

	test("it goes on to the next launch, and hands over one with no privileges", async () => {
		await seedHost("h", OLD);
		await seedValidated("h", { approvalPolicy: "manual", createdAt: "2026-01-01T00:00:00.000Z" });
		const ok = await seedValidated("h", { createdAt: "2026-01-02T00:00:00.000Z" });
		expect((await claimNextLaunchRequest("h"))?.id).toBe(ok);
	});

	test("a host with the feature claims a launch with a policy", async () => {
		await seedHost("h", NEW);
		const id = await seedValidated("h", { sandboxMode: "read-only", agentType: "codex_cli" });
		expect((await claimNextLaunchRequest("h"))?.id).toBe(id);
	});
});

describe("the running-report backstop", () => {
	async function claimed(over: Partial<typeof launchRequests.$inferInsert>) {
		await getDb().delete(supervisors).execute();
		await seedHost("h", NEW);
		const id = await seedValidated("h", over);
		await claimNextLaunchRequest("h");
		return id;
	}
	const report = (id: string, providerLaunchMetadata: Record<string, unknown> | null) =>
		updateLaunchDispatchStatus({
			supervisorId: "h",
			launchId: id,
			status: "running",
			pid: 1,
			providerLaunchMetadata,
		});

	test("matching enforced args: running", async () => {
		const id = await claimed({ approvalPolicy: "manual" });
		const r = await report(id, { privileges: { enforcedArgs: ["--permission-mode", "default"] } });
		expect(r?.status).toBe("running");
	});

	test("missing privileges in the metadata: failed", async () => {
		const id = await claimed({ approvalPolicy: "manual" });
		for (const meta of [null, {}, { mode: "headless" }]) {
			const r = await report(id, meta);
			expect(r?.status).toBe("failed");
			expect(r?.error).toContain("didn't report");
		}
	});

	test("different enforced args (including a bypass) : failed", async () => {
		for (const enforcedArgs of [
			[],
			["--permission-mode", "bypassPermissions"],
			["--permission-mode", "default", "--dangerously-skip-permissions"],
		]) {
			await getDb().delete(launchRequests).execute();
			const id = await claimed({ approvalPolicy: "manual" });
			const r = await report(id, { privileges: { enforcedArgs } });
			expect(r?.status).toBe("failed");
			expect(r?.error).toContain("instead of");
		}
	});

	test("a launch with no privileges set runs without metadata, but not with unexpected flags", async () => {
		const id = await claimed({});
		expect((await report(id, null))?.status).toBe("running");
		await getDb().delete(launchRequests).execute();
		const id2 = await claimed({});
		expect(
			(await report(id2, { privileges: { enforcedArgs: ["--sandbox", "danger-full-access"] } }))
				?.status,
		).toBe("failed");
	});

	test("the check also applies when an interactive launch reports awaiting_session", async () => {
		const id = await claimed({ approvalPolicy: "manual" });
		const r = await updateLaunchDispatchStatus({
			supervisorId: "h",
			launchId: id,
			status: "awaiting_session",
			pid: 1,
			providerLaunchMetadata: { privileges: { enforcedArgs: [] } },
		});
		expect(r?.status).toBe("failed");
	});

	test("privilegeMismatch is pure over the row and the metadata", () => {
		const row = {
			agentType: "codex_cli",
			approvalPolicy: "untrusted",
			sandboxMode: "read-only",
		} as never;
		expect(
			privilegeMismatch(row, {
				privileges: { enforcedArgs: ["--sandbox", "read-only", "--ask-for-approval", "untrusted"] },
			}),
		).toBeNull();
		expect(privilegeMismatch(row, { privileges: { enforcedArgs: "x" } })).not.toBeNull();
	});
});

async function seedManaged(
	sessionId: string,
	hostId: string,
	over: Partial<typeof launchRequests.$inferInsert>,
) {
	const launchId = await seedValidated(hostId, {
		launchCorrelationId: sessionId,
		status: "running",
		claimedBySupervisorId: hostId,
		...over,
	});
	const now = new Date().toISOString();
	await getDb()
		.insert(sessions)
		.values({
			sessionId,
			displayName: sessionId,
			agentType: "claude_code",
			status: "active",
			lastActivityAt: now,
			cwd: "/agent/reported/other/dir",
			model: "agent-reported-model",
			metadata: {
				interactiveBridge: { socketPath: "/tmp/attacker.sock", configPath: "", controlDir: "" },
				terminalOwner: { app: "Terminal", windowId: "evil" },
			},
		} as never)
		.execute();
	await getDb()
		.insert(managedSessions)
		.values({
			sessionId,
			launchRequestId: launchId,
			supervisorId: hostId,
			managedState: "managed",
			createdAt: now,
			updatedAt: now,
		})
		.execute();
	return launchId;
}

describe("retry re-validates the launch as a new one", () => {
	test("a host downgraded since is refused, and nothing is cloned", async () => {
		await seedHost("h", OLD);
		await seedManaged("retry-1", "h", { approvalPolicy: "manual" });
		await expect(retryLaunchForSession("retry-1", ACTOR)).rejects.toThrow("older supervisor");
		expect(await getDb().select().from(launchRequests)).toHaveLength(1);
	});

	test("a host that no longer exists is refused when privileges are set, and allowed when none are", async () => {
		await seedManaged("retry-2", "gone", { approvalPolicy: "manual" });
		await expect(retryLaunchForSession("retry-2", ACTOR)).rejects.toThrow("host is gone");
		await seedManaged("retry-3", "gone", {});
		await expect(retryLaunchForSession("retry-3", ACTOR)).resolves.toBeDefined();
	});

	test("a launch whose recorded values the mapping now refuses is not retried", async () => {
		await seedHost("h", NEW);
		await seedManaged("retry-4", "h", { approvalPolicy: "auto" });
		await expect(retryLaunchForSession("retry-4", ACTOR)).rejects.toThrow("Approval policy 'auto'");
	});

	test("a retry on a capable host succeeds and its stored spec is rebuilt from the row", async () => {
		await seedHost("h", NEW);
		await seedManaged("retry-5", "h", {
			approvalPolicy: "manual",
			model: "m1",
			requestedLaunchMode: "headless",
			launchSpec: {
				approvalPolicy: "never",
				providerConfig: { command: "claude", cliArgs: ["--dangerously-skip-permissions"] },
			},
		});
		const { launchRequest } = await retryLaunchForSession("retry-5", ACTOR);
		expect(launchRequest.launchSpec.approvalPolicy).toBe("manual");
		expect(launchRequest.launchSpec.providerConfig.cliArgs).toEqual([
			"--model",
			"'m1'",
			"--permission-mode",
			"default",
			"--print",
			"--output-format",
			"stream-json",
		]);
	});
});

describe("resume directory", () => {
	test("a queued prompt uses the launch's cwd, not the cwd the agent reported", async () => {
		await seedHost("h", NEW);
		await seedManaged("resume-1", "h", { cwd: "/tmp/ap-skew/launch-dir" });
		const action = await queuePromptAction("resume-1", "hello", ACTOR);
		expect((action.metadata as { cwd: string }).cwd).toBe("/tmp/ap-skew/launch-dir");
	});
});

describe("a queued resume carries only what the launch recorded", () => {
	test("the model is the launch's, and nothing the agent reported about its terminal or bridge is passed on", async () => {
		await seedHost("h", NEW);
		await seedManaged("resume-2", "h", { model: "launch-model" });
		const action = await queuePromptAction("resume-2", "hello", ACTOR);
		const metadata = action.metadata as Record<string, unknown>;
		expect(metadata.model).toBe("launch-model");
		expect(JSON.stringify(metadata)).not.toContain("attacker");
		expect("interactiveBridge" in metadata).toBe(false);
		expect("terminalOwner" in metadata).toBe(false);
	});

	test("a launch with no model queues null, not the agent's model", async () => {
		await seedHost("h", NEW);
		await seedManaged("resume-3", "h", {});
		const action = await queuePromptAction("resume-3", "hello", ACTOR);
		expect((action.metadata as { model: unknown }).model).toBeNull();
	});
});

describe("template checks that guard the environment and the directory", () => {
	const withEnv = (env: Record<string, string>) =>
		validateTemplateInput(normalizeTemplateInput({ ...template(), env }));

	test("a name containing '=' is refused, so NODE_OPTIONS=--import … can't pass as another name", () => {
		const { errors } = withEnv({ "NODE_OPTIONS=--import /tmp/x.js //": "" });
		expect(errors.join(" ")).toContain("letters, digits and underscores");
		expect(withEnv({ "A=b": "" }).errors.length).toBeGreaterThan(0);
		expect(withEnv({ GOOD_NAME: "a=b" }).errors).toEqual([]);
	});

	test("a NUL or an over-long value is refused, not quietly cleaned", () => {
		expect(withEnv({ FOO: "a\0b" }).errors.join(" ")).toContain("NUL");
		expect(withEnv({ FOO: "x".repeat(40_000) }).errors.join(" ")).toContain("32 KB");
		expect(withEnv({ FOO: "x".repeat(1000) }).errors).toEqual([]);
	});

	test("AGENTPULSE_ names are refused", () => {
		expect(withEnv({ AGENTPULSE_SKIP: "1" }).errors.join(" ")).toContain("AGENTPULSE_SKIP");
	});

	test("a cwd with '..' segments is an error, even when it looks like it stays inside", () => {
		for (const cwd of ["/tmp/a/../b", "/tmp/link/..", "/tmp/.."]) {
			const { errors } = validateTemplateInput(normalizeTemplateInput({ ...template(), cwd }));
			expect(errors.join(" "), cwd).toContain("'..'");
		}
		expect(validateTemplateInput(template({ cwd: "/tmp/a..b/c" })).errors).toEqual([]);
	});

	test("a host never validates a cwd with '..' as inside its trusted roots", async () => {
		await seedHost("h", NEW);
		const [host] = await listSupervisors();
		const { errors } = validateAgainstSupervisor(
			template({ cwd: "/tmp/x/../y" }),
			host,
			"headless",
		);
		expect(errors.some((e) => e.includes("outside the supervisor's trusted roots"))).toBe(true);
	});
});

describe("template checks that guard the argv", () => {
	test("a dash-leading task prompt and denied env names are errors", () => {
		expect(
			validateTemplateInput(template({ taskPrompt: "--permission-mode=bypassPermissions" }))
				.errors[0],
		).toContain("can't start with '-'");
		expect(
			validateTemplateInput(template({ taskPrompt: "- fix it" })).errors.length,
		).toBeGreaterThan(0);
		expect(validateTemplateInput(template({ taskPrompt: "fix - it" })).errors).toEqual([]);
		const env = validateTemplateInput(template({ env: { CLAUDE_CONFIG_DIR: "/x", FOO: "1" } }));
		expect(env.errors[0]).toContain("CLAUDE_CONFIG_DIR");
		expect(env.errors[0]).not.toContain("FOO");
	});
});
