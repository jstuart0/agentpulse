#!/usr/bin/env bun
/**
 * Architecture guard: DTO field-name parity between src/shared/types.ts and
 * the vendored packages/agentpulse-mcp/src/types.ts. The MCP package
 * can't import from src/shared (see check-mcp-no-cross-boundary-import), so
 * its copy of each interface drifts silently unless something diffs the
 * two declarations' field sets.
 *
 * Extraction is regex-based (extractInterfaceFields), same shape and same
 * fallback posture as the other scripts/check-*-parity.ts guards.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, extractInterfaceFields, sameSet } from "./lib/parity-utils.js";

const ROOT = new URL("..", import.meta.url).pathname;

function readFile(relPath: string): string {
	return readFileSync(join(ROOT, relPath), "utf8");
}

// Interfaces whose two copies must stay in field-name lockstep. Add a new
// entry here whenever a DTO is both server-shared and MCP-vendored.
const INTERFACES = [
	"SupervisorRecord",
	"Session",
	"AuthMeResponse",
	"DashboardStats",
	"OwnerScopeEcho",
] as const;

/** Where an interface's shared declaration lives when it isn't src/shared/types.ts. */
const SHARED_SOURCE_OVERRIDES: Partial<Record<(typeof INTERFACES)[number], string>> = {
	OwnerScopeEcho: "src/shared/owner-scope.ts",
};

/**
 * Fields the vendored copy intentionally omits because they're server-only
 * (never serialized to a client, or meaningless outside the server
 * process) — not drift, a deliberate narrower surface. Each entry must be
 * justified on its own line; an interface absent here is expected to match
 * exactly. extractInterfaceFields doesn't respect nested-object field
 * boundaries, so AuthMeResponse's exclusion list covers its `user: {...}`
 * sub-fields too, not just its top-level ones.
 */
const INTENTIONAL_VENDOR_OMISSIONS: Partial<Record<(typeof INTERFACES)[number], string[]>> = {
	// AuthMeResponse.user.scopes is api_key-caller-only and forwardauth/local
	// callers omit the field entirely — not a vendor omission, a conditional
	// server field. Nothing to list: both copies declare `scopes?` the same
	// way, so it isn't actually excluded here; this interface currently has
	// zero intentional vendor-side omissions. Left present (empty array) so
	// a future one is added to this comment, not silently to a bare array
	// literal elsewhere.
	AuthMeResponse: [],
};

function main() {
	const mcpContent = readFile("packages/agentpulse-mcp/src/types.ts");

	const errors: string[] = [];

	for (const name of INTERFACES) {
		const sharedPath = SHARED_SOURCE_OVERRIDES[name] ?? "src/shared/types.ts";
		const sharedFields = extractInterfaceFields(readFile(sharedPath), name);
		const mcpFields = extractInterfaceFields(mcpContent, name);

		if (sharedFields.length === 0) {
			errors.push(`${sharedPath} ${name}: extracted zero fields — extraction likely broken`);
			continue;
		}
		if (mcpFields.length === 0) {
			errors.push(
				`packages/agentpulse-mcp/src/types.ts ${name}: extracted zero fields — extraction likely broken`,
			);
			continue;
		}

		const omissions = INTENTIONAL_VENDOR_OMISSIONS[name] ?? [];
		// A listed omission must actually be present on the shared side and
		// actually absent on the vendored side — otherwise the exclusion
		// list itself has drifted from reality (a stale entry masking real
		// parity, or hiding a field that was never there to begin with).
		for (const omitted of omissions) {
			if (!sharedFields.includes(omitted)) {
				errors.push(
					`${name}: "${omitted}" is listed in INTENTIONAL_VENDOR_OMISSIONS but src/shared/types.ts doesn't declare it — stale exclusion entry`,
				);
			}
			if (mcpFields.includes(omitted)) {
				errors.push(
					`${name}: "${omitted}" is listed in INTENTIONAL_VENDOR_OMISSIONS but packages/agentpulse-mcp/src/types.ts declares it anyway — stale exclusion entry`,
				);
			}
		}
		const sharedFieldsForComparison = sharedFields.filter((f) => !omissions.includes(f));

		if (!sameSet(sharedFieldsForComparison, mcpFields)) {
			errors.push(
				`${name}: src/shared/types.ts has ${describe(sharedFieldsForComparison)} (after INTENTIONAL_VENDOR_OMISSIONS), packages/agentpulse-mcp/src/types.ts has ${describe(mcpFields)} — these must match`,
			);
		}
		// ownerUserId/ownerKind must actually be present on both sides, not
		// just equal to each other — a trivial both-sides-missing state must
		// still fail.
		if (name === "SupervisorRecord" && !sharedFields.includes("ownerUserId")) {
			errors.push(`${name}: src/shared/types.ts is missing "ownerUserId"`);
		}
		if (name === "Session" && !sharedFields.includes("ownerKind")) {
			errors.push(`${name}: src/shared/types.ts is missing "ownerKind"`);
		}
		// The reported machine must be present on both sides too, not just equal.
		if (name === "Session") {
			for (const field of ["reportedHost"]) {
				if (!sharedFields.includes(field) || !mcpFields.includes(field)) {
					errors.push(`${name}: "${field}" must be declared on both sides`);
				}
			}
		}
		// The owner-scope echo is what the MCP tools verify a response against.
		if (name === "DashboardStats") {
			for (const field of ["ownerScope", "total", "scratchHidden"]) {
				if (!sharedFields.includes(field) || !mcpFields.includes(field)) {
					errors.push(`${name}: "${field}" must be declared on both sides`);
				}
			}
		}
	}

	if (errors.length > 0) {
		console.error("DTO field-name parity check failed:\n");
		console.error(errors.join("\n\n"));
		console.error(
			"\nEvery interface listed in INTERFACES must declare the same field names in " +
				"src/shared/types.ts and the hand-vendored packages/agentpulse-mcp/src/types.ts copy.",
		);
		process.exit(1);
	}

	console.log(`OK: DTO field names match across both type files for: ${INTERFACES.join(", ")}`);
}

main();
