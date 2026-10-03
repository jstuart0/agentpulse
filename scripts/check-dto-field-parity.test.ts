import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractInterfaceFields, sameSet } from "./lib/parity-utils.js";

describe("extractInterfaceFields — synthetic content", () => {
	test("pulls an interface's declared field names", () => {
		const content = `
export interface SupervisorRecord {
	id: string;
	hostName: string;
	ownerUserId?: string | null;
}
`;
		expect(extractInterfaceFields(content, "SupervisorRecord")).toEqual([
			"id",
			"hostName",
			"ownerUserId",
		]);
	});

	test("normalizes away the optional '?' marker", () => {
		const content = `
export interface Thing {
	required: string;
	optional?: number;
}
`;
		expect(extractInterfaceFields(content, "Thing")).toEqual(["required", "optional"]);
	});

	test("ignores field names mentioned only in a comment", () => {
		const content = `
export interface Thing {
	// notAField: this is just a comment
	/** Also not a field: notAFieldEither */
	real: string;
}
`;
		expect(extractInterfaceFields(content, "Thing")).toEqual(["real"]);
	});

	test("a deliberately introduced divergence is detected by sameSet", () => {
		const canonical = extractInterfaceFields(
			"export interface X { id: string; ownerUserId?: string | null; }",
			"X",
		);
		const drifted = extractInterfaceFields("export interface X { id: string; }", "X");
		expect(sameSet(canonical, drifted)).toBe(false);
	});
});

describe("SupervisorRecord field parity — real files", () => {
	test("src/shared/types.ts and packages/agentpulse-mcp/src/types.ts declare the same SupervisorRecord fields, including ownerUserId", () => {
		const root = new URL("..", import.meta.url).pathname;
		const sharedContent = readFileSync(join(root, "src/shared/types.ts"), "utf8");
		const mcpContent = readFileSync(join(root, "packages/agentpulse-mcp/src/types.ts"), "utf8");

		const sharedFields = extractInterfaceFields(sharedContent, "SupervisorRecord");
		const mcpFields = extractInterfaceFields(mcpContent, "SupervisorRecord");

		// Asserted directly (not just "the two sides match each other") so a
		// trivial both-sides-missing state still fails this test.
		expect(sharedFields).toContain("ownerUserId");
		expect(mcpFields).toContain("ownerUserId");
		expect(sameSet(sharedFields, mcpFields)).toBe(true);
	});
});

describe("Session field parity — real files", () => {
	test("src/shared/types.ts and packages/agentpulse-mcp/src/types.ts declare the same Session fields, including ownerKind", () => {
		const root = new URL("..", import.meta.url).pathname;
		const sharedContent = readFileSync(join(root, "src/shared/types.ts"), "utf8");
		const mcpContent = readFileSync(join(root, "packages/agentpulse-mcp/src/types.ts"), "utf8");

		const sharedFields = extractInterfaceFields(sharedContent, "Session");
		const mcpFields = extractInterfaceFields(mcpContent, "Session");

		// Asserted directly so a trivial both-sides-missing state still fails.
		expect(sharedFields).toContain("ownerKind");
		expect(mcpFields).toContain("ownerKind");
		// ingestKeyId must never be declared on either copy — it's stripped
		// by mapSessionDto before the row ever becomes a Session DTO.
		expect(sharedFields).not.toContain("ingestKeyId");
		expect(mcpFields).not.toContain("ingestKeyId");
		expect(sameSet(sharedFields, mcpFields)).toBe(true);
	});
});

describe("AuthMeResponse field parity — real files", () => {
	test("src/shared/types.ts and packages/agentpulse-mcp/src/types.ts declare the same AuthMeResponse fields (including the nested user.userId/displayName)", () => {
		const root = new URL("..", import.meta.url).pathname;
		const sharedContent = readFileSync(join(root, "src/shared/types.ts"), "utf8");
		const mcpContent = readFileSync(join(root, "packages/agentpulse-mcp/src/types.ts"), "utf8");

		const sharedFields = extractInterfaceFields(sharedContent, "AuthMeResponse");
		const mcpFields = extractInterfaceFields(mcpContent, "AuthMeResponse");

		expect(sharedFields).toContain("userId");
		expect(mcpFields).toContain("userId");
		expect(sharedFields).toContain("displayName");
		expect(mcpFields).toContain("displayName");
		expect(sameSet(sharedFields, mcpFields)).toBe(true);
	});
});

describe("owner scope echo parity — real files", () => {
	const root = new URL("..", import.meta.url).pathname;
	const read = (path: string) => readFileSync(join(root, path), "utf8");

	test("the shared echo and the vendored copy declare the same fields", () => {
		const shared = extractInterfaceFields(read("src/shared/owner-scope.ts"), "OwnerScopeEcho");
		const vendored = extractInterfaceFields(
			read("packages/agentpulse-mcp/src/types.ts"),
			"OwnerScopeEcho",
		);
		expect(shared).toEqual(["kind", "userId"]);
		expect(sameSet(shared, vendored)).toBe(true);
	});

	test("the stats response carries the echo and the total on both sides", () => {
		for (const path of ["src/shared/types.ts", "packages/agentpulse-mcp/src/types.ts"]) {
			const fields = extractInterfaceFields(read(path), "DashboardStats");
			expect({ path, ownerScope: fields.includes("ownerScope") }).toEqual({
				path,
				ownerScope: true,
			});
			expect({ path, total: fields.includes("total") }).toEqual({ path, total: true });
		}
	});
});

describe("Session.reportedHost parity — real files", () => {
	const root = new URL("..", import.meta.url).pathname;
	const read = (path: string) => readFileSync(join(root, path), "utf8");

	test("the machine a hook reported is declared on both the shared and the vendored Session", () => {
		for (const path of ["src/shared/types.ts", "packages/agentpulse-mcp/src/types.ts"]) {
			const fields = extractInterfaceFields(read(path), "Session");
			expect({ path, reportedHost: fields.includes("reportedHost") }).toEqual({
				path,
				reportedHost: true,
			});
		}
	});

	test("the guard itself requires the field, so deleting it from both sides cannot pass", () => {
		expect(read("scripts/check-dto-field-parity.ts")).toContain('"reportedHost"');
	});
});
