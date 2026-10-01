import { describe, expect, test } from "bun:test";
import { buildSqliteScaleWarning, detectOrchestratorHint } from "./scale-warning.js";

describe("detectOrchestratorHint", () => {
	test("detects ECS via ECS_CONTAINER_METADATA_URI", () => {
		expect(detectOrchestratorHint({ ECS_CONTAINER_METADATA_URI: "http://169.254.170.2/v3" })).toBe(
			"ecs",
		);
	});

	test("detects ECS via ECS_CONTAINER_METADATA_URI_V4", () => {
		expect(
			detectOrchestratorHint({ ECS_CONTAINER_METADATA_URI_V4: "http://169.254.170.2/v4" }),
		).toBe("ecs");
	});

	test("detects Kubernetes via KUBERNETES_SERVICE_HOST", () => {
		expect(detectOrchestratorHint({ KUBERNETES_SERVICE_HOST: "10.0.0.1" })).toBe("kubernetes");
	});

	test("returns null when no orchestrator hint is present", () => {
		expect(detectOrchestratorHint({})).toBeNull();
	});

	test("ECS takes precedence when both hints are somehow present", () => {
		expect(
			detectOrchestratorHint({
				ECS_CONTAINER_METADATA_URI: "http://169.254.170.2/v3",
				KUBERNETES_SERVICE_HOST: "10.0.0.1",
			}),
		).toBe("ecs");
	});
});

describe("buildSqliteScaleWarning", () => {
	test("returns the ECS warning for sqlite + ecs hint", () => {
		expect(buildSqliteScaleWarning("sqlite", "ecs")).toBe(
			"[agentpulse] SQLite backend detected on ECS: run exactly one replica/task, or set DATABASE_URL for Postgres. Multiple instances each get their own database.",
		);
	});

	test("returns the Kubernetes warning for sqlite + kubernetes hint", () => {
		expect(buildSqliteScaleWarning("sqlite", "kubernetes")).toBe(
			"[agentpulse] SQLite backend detected on Kubernetes: run exactly one replica/task, or set DATABASE_URL for Postgres. Multiple instances each get their own database.",
		);
	});

	test("returns null when dialect is postgres, regardless of hint", () => {
		expect(buildSqliteScaleWarning("postgres", "ecs")).toBeNull();
		expect(buildSqliteScaleWarning("postgres", "kubernetes")).toBeNull();
	});

	test("returns null when there is no orchestrator hint", () => {
		expect(buildSqliteScaleWarning("sqlite", null)).toBeNull();
	});
});
