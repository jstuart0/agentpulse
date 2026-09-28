#!/usr/bin/env bun
/**
 * Architecture guard: agent-type-list parity (2026-09-28-deliver-agent-cli-parity,
 * Phase 1, D5). AGENT_TYPES (observed) and LAUNCHABLE_AGENT_TYPES (launchable)
 * are duplicated across the server's shared constants and the vendored MCP
 * package (which can't import from src/server or src/shared — see
 * check-mcp-no-cross-boundary-import). This guard extracts each site's list
 * and fails on any drift, plus the floors D5 requires.
 *
 * Extraction is regex-based, not an AST parse — same shape and same
 * fallback posture as check-hook-event-parity.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	describe,
	extractConstTuple,
	extractUnion,
	extractZodEnum,
	isSubsetOf,
	sameSet,
} from "./lib/parity-utils.js";

const ROOT = new URL("..", import.meta.url).pathname;

function readFile(relPath: string): string {
	return readFileSync(join(ROOT, relPath), "utf8");
}

interface ListSite {
	site: string;
	list: "observed" | "launchable";
	values: string[];
}

function main() {
	const constantsContent = readFile("src/shared/constants.ts");
	const mcpEnumsContent = readFile("packages/agentpulse-mcp/src/enums.ts");
	const mcpTypesContent = readFile("packages/agentpulse-mcp/src/types.ts");

	const sites: ListSite[] = [
		{
			site: "src/shared/constants.ts AGENT_TYPES",
			list: "observed",
			values: extractConstTuple(constantsContent, "AGENT_TYPES"),
		},
		{
			site: "src/shared/constants.ts LAUNCHABLE_AGENT_TYPES",
			list: "launchable",
			values: extractConstTuple(constantsContent, "LAUNCHABLE_AGENT_TYPES"),
		},
		{
			site: "packages/agentpulse-mcp/src/enums.ts OBSERVED_AGENT_TYPE_ENUM",
			list: "observed",
			values: extractZodEnum(mcpEnumsContent, "OBSERVED_AGENT_TYPE_ENUM"),
		},
		{
			site: "packages/agentpulse-mcp/src/enums.ts LAUNCHABLE_AGENT_TYPE_ENUM",
			list: "launchable",
			values: extractZodEnum(mcpEnumsContent, "LAUNCHABLE_AGENT_TYPE_ENUM"),
		},
		{
			site: "packages/agentpulse-mcp/src/types.ts AgentType",
			list: "observed",
			values: extractUnion(mcpTypesContent, "AgentType"),
		},
		{
			site: "packages/agentpulse-mcp/src/types.ts LaunchableAgentType",
			list: "launchable",
			values: extractUnion(mcpTypesContent, "LaunchableAgentType"),
		},
	];

	const errors: string[] = [];

	for (const s of sites) {
		if (s.values.length === 0) {
			errors.push(`${s.site}: extracted zero values — extraction likely broken`);
		}
	}

	const observedSites = sites.filter((s) => s.list === "observed");
	const launchableSites = sites.filter((s) => s.list === "launchable");
	const canonicalObserved = observedSites[0]?.values ?? [];
	const canonicalLaunchable = launchableSites[0]?.values ?? [];

	for (const s of observedSites) {
		if (s.values.length > 0 && !sameSet(s.values, canonicalObserved)) {
			errors.push(
				`${s.site}: ${describe(s.values)} does not match the observed canonical set ${describe(canonicalObserved)} (${observedSites[0]?.site})`,
			);
		}
	}
	for (const s of launchableSites) {
		if (s.values.length > 0 && !sameSet(s.values, canonicalLaunchable)) {
			errors.push(
				`${s.site}: ${describe(s.values)} does not match the launchable canonical set ${describe(canonicalLaunchable)} (${launchableSites[0]?.site})`,
			);
		}
	}

	// Floors (D5): each list is non-empty and has >= 2 members; claude_code
	// is present in every list.
	for (const [name, values] of [
		["observed", canonicalObserved],
		["launchable", canonicalLaunchable],
	] as const) {
		if (values.length < 2) {
			errors.push(`${name} list has fewer than 2 members: ${describe(values)}`);
		}
		if (!values.includes("claude_code")) {
			errors.push(`${name} list is missing "claude_code": ${describe(values)}`);
		}
	}

	if (
		canonicalObserved.length > 0 &&
		canonicalLaunchable.length > 0 &&
		!isSubsetOf(canonicalLaunchable, canonicalObserved)
	) {
		errors.push(
			`launchable set ${describe(canonicalLaunchable)} is not a subset of the observed set ${describe(canonicalObserved)}`,
		);
	}

	if (errors.length > 0) {
		console.error("Agent-type-list parity check failed:\n");
		console.error(errors.join("\n\n"));
		console.error(
			"\nAGENT_TYPES / LAUNCHABLE_AGENT_TYPES must stay in lockstep across " +
				"src/shared/constants.ts and the vendored packages/agentpulse-mcp/src/{enums,types}.ts " +
				"copies (the MCP package can't import from src/shared — see " +
				"check-mcp-no-cross-boundary-import), LAUNCHABLE must be a subset of observed, and " +
				'both lists need >= 2 members including "claude_code".',
		);
		process.exit(1);
	}

	console.log(
		`OK: agent-type lists match across all ${sites.length} sites (observed: ${describe(canonicalObserved)}, launchable: ${describe(canonicalLaunchable)})`,
	);
}

main();
