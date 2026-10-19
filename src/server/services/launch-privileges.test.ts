/**
 * Server side of SX: validation, preview, the stored launch spec and the launch
 * record all report the privileges the supervisor will actually enforce, and a
 * repeated create with one clientRequestId returns the first launch.
 *
 * DB-touching, so it runs on both dialects (AGENTPULSE_TEST_BACKEND).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import "../db/__test_db.js";
import type {
	LaunchMode,
	LaunchRequestInput,
	LaunchSpec,
	SessionTemplateInput,
	SupervisorRecord,
} from "../../shared/types.js";

const { initializeDatabase, getDb } = await import("../db/client.js");
const { launchRequests, supervisors } = await import("../db/schema/index.js");
const { buildLaunchSpec } = await import("./launch-compatibility.js");
const { CLIENT_REQUEST_ID_WINDOW_MS, createValidatedLaunchRequest } = await import(
	"./launch-validator.js"
);
const { buildTemplatePreview, validateTemplateInput } = await import("./template-preview.js");

const CWD = "/tmp/ap-launch-privileges";

beforeAll(async () => {
	await initializeDatabase();
});

beforeEach(async () => {
	await getDb().delete(launchRequests);
	await getDb().delete(supervisors);
});

function template(over: Partial<SessionTemplateInput> = {}): SessionTemplateInput {
	return {
		name: "t",
		description: null,
		agentType: "claude_code",
		cwd: CWD,
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

async function seedSupervisor(): Promise<string> {
	const id = `sup-${crypto.randomUUID()}`;
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
				features: ["enforces_launch_privileges"],
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

const SUPERVISOR_STUB = {} as SupervisorRecord;

function input(
	t: SessionTemplateInput,
	mode: LaunchMode,
	over: Partial<LaunchRequestInput> = {},
	spec: Partial<LaunchSpec> = {},
): LaunchRequestInput {
	return {
		template: t,
		requestedLaunchMode: mode,
		routingPolicy: "first_capable_host",
		launchSpec: { ...buildLaunchSpec(t, mode, SUPERVISOR_STUB), ...spec },
		...over,
	};
}

const ACTOR_A = { userId: "user-a", label: "user" as const };
const ACTOR_B = { userId: "user-b", label: "user" as const };

describe("validateTemplateInput", () => {
	test("a refused combination is an error naming the setting; accepted ones are not", () => {
		const refused: Array<Partial<SessionTemplateInput>> = [
			{ approvalPolicy: "auto" },
			{ approvalPolicy: "on-failure" },
			{ sandboxMode: "read-only" },
			{ sandboxMode: "workspace-write" },
			{ approvalPolicy: "bogus" as never },
		];
		for (const agentType of ["claude_code", "codex_cli"] as const) {
			for (const over of refused) {
				const { errors } = validateTemplateInput(template({ agentType, ...over }));
				const claudeSandbox = agentType === "codex_cli" && "sandboxMode" in over;
				if (claudeSandbox) {
					expect(errors, JSON.stringify(over)).toEqual([]);
				} else {
					expect(errors.length, `${agentType} ${JSON.stringify(over)}`).toBeGreaterThan(0);
				}
			}
		}
		expect(validateTemplateInput(template({ approvalPolicy: "manual" })).errors).toEqual([]);
		expect(
			validateTemplateInput(
				template({ agentType: "codex_cli", approvalPolicy: "untrusted", sandboxMode: "read-only" }),
			).errors,
		).toEqual([]);
	});

	test("an unset policy or sandbox is a visible warning that the agent's default applies", () => {
		const { warnings } = validateTemplateInput(template());
		expect(warnings).toContain(
			"No explicit approval policy and sandbox mode: Claude Code will use its own default (no flag is added).",
		);
		const partly = validateTemplateInput(
			template({ agentType: "codex_cli", sandboxMode: "read-only" }),
		);
		expect(partly.warnings).toContain(
			"No explicit approval policy: Codex will use its own default (no flag is added).",
		);
		const none = validateTemplateInput(
			template({ agentType: "codex_cli", approvalPolicy: "untrusted", sandboxMode: "read-only" }),
		);
		expect(none.warnings.some((w) => w.startsWith("No explicit"))).toBe(false);
	});

	test("a non-launchable agent type only gets the agent type error", () => {
		const { errors } = validateTemplateInput(template({ agentType: "copilot_cli" as never }));
		expect(errors).toEqual(["Agent type must be claude_code or codex_cli."]);
	});
});

describe("preview and launch spec show exactly the enforced flags", () => {
	test("buildLaunchSpec: model, privilege flags, then headless flags", () => {
		const claude = buildLaunchSpec(
			template({ approvalPolicy: "manual" }),
			"headless",
			SUPERVISOR_STUB,
		);
		expect(claude.providerConfig.cliArgs).toEqual([
			"--model",
			"'m1'",
			"--permission-mode",
			"default",
			"--print",
			"--output-format",
			"stream-json",
		]);
		const codex = buildLaunchSpec(
			template({
				agentType: "codex_cli",
				approvalPolicy: "untrusted",
				sandboxMode: "workspace-write",
			}),
			"managed_codex",
			SUPERVISOR_STUB,
		);
		expect(codex.providerConfig.cliArgs).toEqual([
			"--model",
			"'m1'",
			"--sandbox",
			"workspace-write",
			"--ask-for-approval",
			"untrusted",
		]);
		expect(codex.sandboxMode).toBe("workspace-write");
	});

	test("a default or refused setting adds no flag to the spec", () => {
		for (const t of [
			template(),
			template({ approvalPolicy: "default" }),
			template({ approvalPolicy: "auto" }),
		]) {
			expect(buildLaunchSpec(t, "headless", SUPERVISOR_STUB).providerConfig.cliArgs).toEqual([
				"--model",
				"'m1'",
				"--print",
				"--output-format",
				"stream-json",
			]);
		}
	});

	test("buildTemplatePreview: cliArgs, guidance command and effectivePrivileges", async () => {
		const preview = await buildTemplatePreview(
			template({ agentType: "codex_cli", approvalPolicy: "untrusted", sandboxMode: "read-only" }),
			{ requestedLaunchMode: "managed_codex" },
		);
		expect(preview.launchSpec.providerConfig.cliArgs).toEqual([
			"--model",
			"m1",
			"--sandbox",
			"read-only",
			"--ask-for-approval",
			"untrusted",
		]);
		expect(preview.guidance.codexCli.command).toContain(
			"codex --model 'm1' --sandbox read-only --ask-for-approval untrusted",
		);
		expect(preview.effectivePrivileges).toMatchObject({
			enforcedArgs: ["--sandbox", "read-only", "--ask-for-approval", "untrusted"],
			sandboxMode: { source: "explicit", effective: "read-only", permissive: false },
		});
	});

	test("preview of a default says what the default is, and that Claude Code's has no sandbox", async () => {
		const preview = await buildTemplatePreview(template(), { requestedLaunchMode: "headless" });
		expect(preview.launchSpec.providerConfig.cliArgs).toEqual(["--model", "m1"]);
		expect(preview.effectivePrivileges?.sandboxMode).toMatchObject({
			source: "agent_default",
			permissive: true,
		});
		expect(preview.effectivePrivileges?.defaultMeaning).toContain("no sandbox");
	});

	test("preview of a refused combination has no effectivePrivileges and no flags", async () => {
		const preview = await buildTemplatePreview(template({ approvalPolicy: "auto" }));
		expect(preview.effectivePrivileges).toBeNull();
		expect(preview.launchSpec.providerConfig.cliArgs).toEqual(["--model", "m1"]);
	});
});

describe("createValidatedLaunchRequest", () => {
	test("the stored spec is made to match the row, and the record reports the effective privileges", async () => {
		await seedSupervisor();
		const t = template({ approvalPolicy: "manual" });
		const { launchRequest } = await createValidatedLaunchRequest(
			input(
				t,
				"headless",
				{},
				{
					approvalPolicy: "untrusted",
					sandboxMode: "danger-full-access",
					providerConfig: {
						command: "claude",
						cliArgs: [
							"--model",
							"m1",
							"--dangerously-skip-permissions",
							"--permission-mode",
							"bypassPermissions",
						],
						instructionsFile: "CLAUDE.md",
					},
				},
			),
			ACTOR_A,
		);
		expect(launchRequest.status).toBe("validated");
		expect(launchRequest.approvalPolicy).toBe("manual");
		expect(launchRequest.launchSpec.approvalPolicy).toBe("manual");
		expect(launchRequest.launchSpec.sandboxMode).toBeNull();
		// Built from the template alone: nothing the client put in its own cliArgs survives.
		expect(launchRequest.launchSpec.providerConfig.cliArgs).toEqual([
			"--model",
			"'m1'",
			"--permission-mode",
			"default",
			"--print",
			"--output-format",
			"stream-json",
		]);
		expect(launchRequest.effectivePrivileges).toMatchObject({
			enforcedArgs: ["--permission-mode", "default"],
			approvalPolicy: { requested: "manual", effective: "default", source: "explicit" },
			sandboxMode: { source: "agent_default", permissive: true },
		});
		expect(launchRequest.validationWarnings).toContain(
			"No explicit sandbox mode: Claude Code will use its own default (no flag is added).",
		);
	});

	test("an unenforceable launch is rejected with a 400 and nothing is stored", async () => {
		await seedSupervisor();
		for (const over of [
			{ approvalPolicy: "auto" as const },
			{ sandboxMode: "read-only" as const },
		]) {
			await expect(
				createValidatedLaunchRequest(input(template(over), "headless"), ACTOR_A),
			).rejects.toMatchObject({ status: 400 });
		}
		expect(await getDb().select().from(launchRequests)).toHaveLength(0);
	});

	describe("clientRequestId", () => {
		const withId = (id: unknown, t = template()) =>
			input(t, "headless", { metadata: { clientRequestId: id } });

		test("a repeat returns the first launch and flags the replay; one row exists", async () => {
			await seedSupervisor();
			const first = await createValidatedLaunchRequest(withId("nonce-1"), ACTOR_A);
			const second = await createValidatedLaunchRequest(withId("nonce-1"), ACTOR_A);
			expect("idempotentReplay" in first).toBe(false);
			expect(second).toMatchObject({ idempotentReplay: true });
			expect(second.launchRequest.id).toBe(first.launchRequest.id);
			expect(second.launchRequest.launchCorrelationId).toBe(
				first.launchRequest.launchCorrelationId,
			);
			expect(second.supervisor?.id).toBe(first.supervisor?.id);
			expect(await getDb().select().from(launchRequests)).toHaveLength(1);
		});

		test("two simultaneous creates with one id make one launch", async () => {
			await seedSupervisor();
			const [a, b] = await Promise.all([
				createValidatedLaunchRequest(withId("nonce-race"), ACTOR_A),
				createValidatedLaunchRequest(withId("nonce-race"), ACTOR_A),
			]);
			expect(a.launchRequest.id).toBe(b.launchRequest.id);
			expect(await getDb().select().from(launchRequests)).toHaveLength(1);
		});

		test("the id is scoped to the requester: another user with the same id gets their own launch", async () => {
			await seedSupervisor();
			const a = await createValidatedLaunchRequest(withId("shared"), ACTOR_A);
			const b = await createValidatedLaunchRequest(withId("shared"), ACTOR_B);
			expect(b.launchRequest.id).not.toBe(a.launchRequest.id);
			expect("idempotentReplay" in b).toBe(false);
		});

		test("the same id for a different launch is a 409, not a silent replay", async () => {
			await seedSupervisor();
			await createValidatedLaunchRequest(
				withId("nonce-2", template({ approvalPolicy: "manual" })),
				ACTOR_A,
			);
			for (const t of [
				template({ approvalPolicy: "untrusted" }),
				template({ taskPrompt: "other" }),
				template({ cwd: "/tmp/elsewhere" }),
			]) {
				await expect(
					createValidatedLaunchRequest(withId("nonce-2", t), ACTOR_A),
				).rejects.toMatchObject({
					status: 409,
				});
			}
			expect(await getDb().select().from(launchRequests)).toHaveLength(1);
		});

		test("after the window the id names a new launch and the old row releases the key", async () => {
			await seedSupervisor();
			const first = await createValidatedLaunchRequest(withId("nonce-3"), ACTOR_A);
			await getDb()
				.update(launchRequests)
				.set({
					createdAt: new Date(Date.now() - CLIENT_REQUEST_ID_WINDOW_MS - 60_000).toISOString(),
				})
				.where(eq(launchRequests.id, first.launchRequest.id));
			const second = await createValidatedLaunchRequest(withId("nonce-3"), ACTOR_A);
			expect(second.launchRequest.id).not.toBe(first.launchRequest.id);
			expect("idempotentReplay" in second).toBe(false);
			const [old] = await getDb()
				.select()
				.from(launchRequests)
				.where(eq(launchRequests.id, first.launchRequest.id));
			expect(old.idempotencyKey).toBeNull();
		});

		test("the window is at least 24 hours", () => {
			expect(CLIENT_REQUEST_ID_WINDOW_MS).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
		});

		test("a launch inside the window one hour short of the end is still a replay", async () => {
			await seedSupervisor();
			const first = await createValidatedLaunchRequest(withId("nonce-4"), ACTOR_A);
			await getDb()
				.update(launchRequests)
				.set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() })
				.where(eq(launchRequests.id, first.launchRequest.id));
			const again = await createValidatedLaunchRequest(withId("nonce-4"), ACTOR_A);
			expect(again.launchRequest.id).toBe(first.launchRequest.id);
		});

		test("a malformed id is a 400; a launch without one is never deduplicated", async () => {
			await seedSupervisor();
			for (const bad of [42, "", "has space", "x".repeat(129), { a: 1 }]) {
				await expect(createValidatedLaunchRequest(withId(bad), ACTOR_A)).rejects.toMatchObject({
					status: 400,
				});
			}
			await createValidatedLaunchRequest(input(template(), "headless"), ACTOR_A);
			await createValidatedLaunchRequest(input(template(), "headless"), ACTOR_A);
			expect(await getDb().select().from(launchRequests)).toHaveLength(2);
		});
	});
});

describe("clientRequestId: the whole request is compared, and the stored key is opaque", () => {
	const withId = (
		id: string,
		t = template(),
		over: Partial<LaunchRequestInput> = {},
		spec: Partial<LaunchSpec> = {},
	) => input(t, "headless", { metadata: { clientRequestId: id }, ...over }, spec);

	test("a different env, prelaunch action, target host, routing or template id is a 409, not a replay", async () => {
		await seedSupervisor();
		await createValidatedLaunchRequest(withId("full-1"), ACTOR_A);
		const variants: Array<LaunchRequestInput> = [
			withId("full-1", template({ env: { A: "1" } })),
			// The template's env on its own, with the submitted spec left identical.
			withId("full-1", template({ env: { A: "1" } }), {}, { env: {} }),
			withId(
				"full-1",
				template(),
				{},
				{
					prelaunchActions: [{ kind: "scaffold_workarea", path: "/tmp/x" } as never],
				},
			),
			withId("full-1", template(), { requestedSupervisorId: "someone-else" }),
			withId("full-1", template(), { routingPolicy: "manual_target" }),
			withId("full-1", template(), { templateId: "tmpl-1" }),
		];
		for (const variant of variants) {
			await expect(createValidatedLaunchRequest(variant, ACTOR_A)).rejects.toMatchObject({
				status: 409,
			});
		}
		expect(await getDb().select().from(launchRequests)).toHaveLength(1);
	});

	test("the stored key is a hash: it contains neither the nonce nor the requester", async () => {
		await seedSupervisor();
		const { launchRequest } = await createValidatedLaunchRequest(withId("visible-nonce"), ACTOR_A);
		const [row] = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.id, launchRequest.id));
		expect(row.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
		expect(row.idempotencyKey).not.toContain("visible-nonce");
	});

	test("ids that would collide if joined with a separator don't", async () => {
		await seedSupervisor();
		const a = await createValidatedLaunchRequest(withId("x:y"), { userId: "u", label: "user" });
		const b = await createValidatedLaunchRequest(withId("y"), { userId: "u:x", label: "user" });
		expect(b.launchRequest.id).not.toBe(a.launchRequest.id);
	});
});

describe("what a launch DTO shows of server bookkeeping and of the agent", () => {
	test("the idempotency fingerprint is stored but never part of the DTO's metadata; the client's own metadata is kept", async () => {
		await seedSupervisor();
		const { launchRequest } = await createValidatedLaunchRequest(
			input(template(), "headless", { metadata: { clientRequestId: "dto-1", note: "mine" } }),
			ACTOR_A,
		);
		expect(launchRequest.metadata).toEqual({ clientRequestId: "dto-1", note: "mine" });
		const [row] = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.id, launchRequest.id));
		expect(String((row.metadata as Record<string, unknown>).requestFingerprint)).toMatch(
			/^[0-9a-f]{64}$/,
		);
		const replay = await createValidatedLaunchRequest(
			input(template(), "headless", { metadata: { clientRequestId: "dto-1", note: "mine" } }),
			ACTOR_A,
		);
		expect(JSON.stringify(replay.launchRequest)).not.toContain("requestFingerprint");
	});

	test("strings the agent reported are cut before they are shown", async () => {
		await seedSupervisor();
		const { launchRequest } = await createValidatedLaunchRequest(
			input(template({ agentType: "codex_cli" }), "managed_codex"),
			ACTOR_A,
		);
		await getDb()
			.update(launchRequests)
			.set({
				providerLaunchMetadata: {
					privileges: {
						reportedByAgent: {
							approvalPolicy: "x".repeat(5000),
							sandbox: { deep: "y".repeat(5000) },
							writableRoots: Array.from({ length: 500 }, () => "/r".repeat(1000)),
						},
					},
				},
			})
			.where(eq(launchRequests.id, launchRequest.id));
		const [row] = await getDb()
			.select()
			.from(launchRequests)
			.where(eq(launchRequests.id, launchRequest.id));
		const { mapLaunchRequest } = await import("./launch-validator.js");
		const shown = mapLaunchRequest(row).effectivePrivileges?.reportedByAgent;
		expect(String(shown?.approvalPolicy).length).toBeLessThanOrEqual(70);
		expect(String(shown?.sandbox).length).toBeLessThanOrEqual(70);
		expect(shown?.writableRoots?.length).toBeLessThanOrEqual(20);
		for (const root of shown?.writableRoots ?? []) expect(root.length).toBeLessThanOrEqual(260);
	});
});
