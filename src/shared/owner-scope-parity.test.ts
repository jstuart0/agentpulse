/**
 * The MCP package spells the owner grammar out as a regular expression because
 * it can't import src/shared. The two must accept and refuse exactly the same
 * values, so a change to the shared grammar that isn't mirrored fails here.
 */
import { describe, expect, test } from "bun:test";
import { OWNER_SCOPE_PATTERN } from "../../packages/agentpulse-mcp/src/enums.js";
import { OWNER_KEYWORDS, parseOwnerParam } from "./owner-scope.js";

const UUID = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";

const CORPUS = [
	...OWNER_KEYWORDS,
	UUID,
	UUID.toUpperCase(),
	"ME",
	"All",
	"Unassigned",
	"everybody",
	"not-a-uuid",
	`${UUID}x`,
	` ${UUID}`,
	UUID.replaceAll("-", ""),
	UUID.slice(0, -1),
	"3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6g",
	"null",
	"undefined",
	"%",
	"me,all",
	"service ",
];

describe("the MCP owner pattern and the shared owner grammar agree", () => {
	for (const value of CORPUS) {
		test(JSON.stringify(value), () => {
			expect({ value, mcpAccepts: OWNER_SCOPE_PATTERN.test(value) }).toEqual({
				value,
				mcpAccepts: parseOwnerParam(value) !== null,
			});
		});
	}

	test("every shared keyword is spelled in the MCP pattern", () => {
		for (const keyword of OWNER_KEYWORDS) expect(OWNER_SCOPE_PATTERN.source).toContain(keyword);
	});

	test("the corpus covers both outcomes, or the comparison proves nothing", () => {
		const outcomes = new Set(CORPUS.map((value) => parseOwnerParam(value) !== null));
		expect(outcomes).toEqual(new Set([true, false]));
	});
});
