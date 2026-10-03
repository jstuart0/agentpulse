/**
 * The MCP package can't import src/shared (check:mcp-no-cross-boundary-import),
 * so it carries its own copy of the machine query grammar and of the echo check.
 * This test lives outside the package, where both can be imported, and holds the
 * two to the same answers on a matrix of awkward values. If the shared grammar
 * changes and the copy doesn't, the row that disagrees is named here.
 */
import { describe, expect, test } from "bun:test";
import {
	HOST_PARAM_MAX_LENGTH as MCP_MAX,
	UNKNOWN_HOST_PARAM as MCP_UNKNOWN,
} from "../../packages/agentpulse-mcp/src/enums.js";
import {
	assertHostFilterEchoed,
	resolveHostFilter,
} from "../../packages/agentpulse-mcp/src/scopes.js";
import {
	HOST_PARAM_MAX_LENGTH,
	UNKNOWN_HOST_PARAM,
	hostEchoMatchesRequest,
	parseHostParam,
} from "./machine-scope.js";

const VALUES: Array<string | undefined> = [
	undefined,
	"",
	"   ",
	"build-01",
	"  build-01 ",
	"Build-01",
	"Alice's MBP.local",
	"unknown",
	"All machines",
	UNKNOWN_HOST_PARAM,
	"a\nb",
	"tab\there",
	"nul\u0000",
	"bidi\u202ename",
	"line\u2028sep",
	"x".repeat(HOST_PARAM_MAX_LENGTH),
	"x".repeat(HOST_PARAM_MAX_LENGTH + 1),
	"x' OR '1'='1",
];

const label = (value: string | undefined) =>
	value === undefined
		? "(absent)"
		: JSON.stringify(value.length > 40 ? `${value.slice(0, 20)}...(${value.length})` : value);

describe("the MCP copy of the machine grammar", () => {
	test("the constants are the shared ones", () => {
		expect(MCP_UNKNOWN).toBe(UNKNOWN_HOST_PARAM);
		expect(MCP_MAX).toBe(HOST_PARAM_MAX_LENGTH);
	});

	test("every value is accepted or refused as the shared parser does, and means the same thing", () => {
		for (const value of VALUES) {
			const shared = parseHostParam(value);
			const mine = (() => {
				try {
					return { ok: resolveHostFilter({ host: value }) };
				} catch {
					return { refused: true };
				}
			})();
			const expected =
				shared === null
					? { refused: true }
					: {
							ok:
								shared.kind === "all"
									? undefined
									: shared.kind === "unknown"
										? UNKNOWN_HOST_PARAM
										: shared.host,
						};
			expect({ value: label(value), got: mine }).toEqual({ value: label(value), got: expected });
		}
	});

	test("no_host is the reserved token, and cannot be combined with a name", () => {
		expect(resolveHostFilter({ no_host: true })).toBe(UNKNOWN_HOST_PARAM);
		expect(parseHostParam(resolveHostFilter({ no_host: true }))).toEqual({ kind: "unknown" });
		expect(() => resolveHostFilter({ host: "build-01", no_host: true })).toThrow();
	});
});

describe("the MCP copy of the echo check", () => {
	const ECHOES: unknown[] = [
		undefined,
		null,
		"build-01",
		{},
		{ kind: "all" },
		{ kind: "unknown" },
		{ kind: "host", host: "build-01" },
		{ kind: "host", host: "Build-01" },
		{ kind: "host", host: "edge-02" },
		{ kind: "host" },
		{ host: "build-01", kind: "host" },
		{ kind: "unknown", host: "build-01" },
	];

	test("every requested value against every echo agrees with the shared check", () => {
		for (const value of VALUES) {
			const parsed = parseHostParam(value);
			if (parsed === null) continue;
			const requested = resolveHostFilter({ host: value });
			for (const echo of ECHOES) {
				const accepts = (() => {
					try {
						assertHostFilterEchoed(requested, echo as never);
						return true;
					} catch {
						return false;
					}
				})();
				expect({ value: label(value), echo, accepts }).toEqual({
					value: label(value),
					echo,
					accepts: hostEchoMatchesRequest(parsed, echo),
				});
			}
		}
	});
});
