/**
 * The MCP package vendors the person-facing Codex approval types and carries its own copy of the
 * wire fixtures (it can't import src/shared). Field names are held by scripts/check-dto-field-parity.ts;
 * this test holds what that guard can't see: the closed unions, the fixture bytes, and every key of
 * every fixture (nested included) against both type files.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractInterfaceFields, extractUnion } from "../../scripts/lib/parity-utils.js";
import {
	APPROVAL_DECISIONS,
	APPROVAL_REQUEST_KINDS,
	APPROVAL_STATUSES,
	CODEX_APPROVAL_OUTCOMES,
	NOT_APPROVABLE_REASONS,
} from "./codex-approvals.js";

const root = new URL("../..", import.meta.url).pathname;
const read = (path: string) => readFileSync(join(root, path), "utf8");
const SHARED = read("src/shared/codex-approvals.ts");
const MCP = read("packages/agentpulse-mcp/src/types.ts");
const SERVER_FIXTURES = "src/server/routes/__fixtures__/codex-approvals";
const MCP_FIXTURES = "packages/agentpulse-mcp/src/__fixtures__/codex-approvals";
const PERSON_FIXTURES = [
	"decision-accept.json",
	"decision-decline.json",
	"detail-closed.json",
	"detail-command.json",
	"detail-file-change.json",
	"list-closed.json",
	"list-open.json",
];

const sorted = (values: readonly string[]) => [...values].sort();

describe("the vendored closed sets equal the shared ones", () => {
	const cases: Array<[string, readonly string[]]> = [
		["CodexApprovalStatus", APPROVAL_STATUSES],
		["CodexApprovalDecision", APPROVAL_DECISIONS],
		["CodexApprovalRequestKind", APPROVAL_REQUEST_KINDS],
		["CodexApprovalOutcome", CODEX_APPROVAL_OUTCOMES],
		["CodexApprovalNotApprovableReason", NOT_APPROVABLE_REASONS],
	];
	for (const [name, shared] of cases) {
		test(name, () => {
			const vendored = extractUnion(MCP, name, { allowUnderscore: true });
			expect(shared.length).toBeGreaterThan(1);
			expect(sorted(vendored)).toEqual(sorted(shared));
		});
	}

	test("the host state union is the same three words", () => {
		const grab = (content: string) =>
			/interface CodexApprovalHost \{\s*state: ([^;]+);/.exec(content)?.[1].match(/"(\w+)"/g);
		expect(grab(MCP)).toEqual(['"live"', '"offline"', '"gone"']);
		expect(grab(MCP)).toEqual(grab(SHARED));
	});

	test("the presentation request kinds are the same literals", () => {
		for (const content of [SHARED, MCP]) {
			expect(content).toContain('requestKind: "command";');
			expect(content).toContain('requestKind: "file_change";');
		}
	});
});

describe("the MCP fixture copy", () => {
	test("is the same set of person fixtures, byte for byte", () => {
		const copies = readdirSync(join(root, MCP_FIXTURES)).sort();
		expect(copies).toEqual([...PERSON_FIXTURES].sort());
		for (const name of PERSON_FIXTURES) {
			expect(read(`${MCP_FIXTURES}/${name}`), name).toBe(read(`${SERVER_FIXTURES}/${name}`));
		}
	});
});

type Json = Record<string, unknown>;
const asObject = (value: unknown): Json => value as Json;

/** Every key of `value` must be declared on the named interface, in both files. */
function checkKeys(path: string, value: Json, iface: string, problems: string[]) {
	for (const [label, content] of [
		["shared", SHARED],
		["vendored", MCP],
	] as const) {
		const declared = extractInterfaceFields(content, iface);
		for (const key of Object.keys(value)) {
			if (!declared.includes(key)) problems.push(`${path}.${key} is not on ${label} ${iface}`);
		}
	}
}

function walkSummary(path: string, summary: Json, problems: string[]) {
	checkKeys(path, summary, "CodexApprovalSummary", problems);
	const preview = summary.preview;
	if (preview === null || preview === undefined) return;
	checkKeys(`${path}.preview`, asObject(preview), "CodexApprovalPreview", problems);
	for (const [i, entry] of ((asObject(preview).paths as unknown[]) ?? []).entries()) {
		checkKeys(`${path}.preview.paths[${i}]`, asObject(entry), "CodexApprovalPathPreview", problems);
	}
}

function walkFixture(name: string, body: Json, problems: string[]) {
	if (name.startsWith("list-")) {
		checkKeys(name, body, "CodexApprovalList", problems);
		for (const [i, a] of (body.approvals as unknown[]).entries()) {
			walkSummary(`${name}.approvals[${i}]`, asObject(a), problems);
		}
		checkKeys(`${name}.host`, asObject(body.host), "CodexApprovalHost", problems);
		checkKeys(`${name}.viewer`, asObject(body.viewer), "CodexApprovalViewer", problems);
	} else if (name.startsWith("decision-")) {
		checkKeys(name, body, "CodexApprovalDecisionResponse", problems);
		walkSummary(`${name}.approval`, asObject(body.approval), problems);
	} else {
		checkKeys(name, body, "CodexApprovalDetail", problems);
		walkSummary(`${name}.approval`, asObject(body.approval), problems);
		const presentation = body.presentation === null ? null : asObject(body.presentation);
		if (presentation) {
			const kind =
				presentation.requestKind === "command"
					? "CodexApprovalCommandPresentation"
					: "CodexApprovalFileChangePresentation";
			checkKeys(`${name}.presentation`, presentation, kind, problems);
			for (const [i, c] of ((presentation.changes as unknown[]) ?? []).entries()) {
				checkKeys(
					`${name}.presentation.changes[${i}]`,
					asObject(c),
					"CodexApprovalPresentationChange",
					problems,
				);
			}
		}
	}
}

describe("every fixture key is declared by both type files", () => {
	test("lists, details and decisions, nested shapes included", () => {
		const problems: string[] = [];
		const seenKinds = new Set<string>();
		for (const name of PERSON_FIXTURES) {
			const body = JSON.parse(read(`${MCP_FIXTURES}/${name}`)) as Json;
			walkFixture(name, body, problems);
			const presentation = body.presentation as Json | null | undefined;
			if (presentation) seenKinds.add(String(presentation.requestKind));
		}
		expect(problems).toEqual([]);
		// Positive control: both presentation shapes were actually walked.
		expect([...seenKinds].sort()).toEqual(["command", "file_change"]);
	});

	test("the walker notices a key the vendored types lack", () => {
		const problems: string[] = [];
		checkKeys("probe", { id: "x", notAField: 1 }, "CodexApprovalSummary", problems);
		expect(problems.map((p) => p.split(" ")[0])).toEqual(["probe.notAField", "probe.notAField"]);
	});
});
