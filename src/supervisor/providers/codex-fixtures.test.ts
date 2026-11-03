/**
 * Phase 0 (AGEN-87): the recorded Codex 0.163.0 frames are real, scrubbed, and
 * agree with the committed schema subset. The check is deliberately small:
 * required fields, string enums, and the decision enums.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "__fixtures__", "codex-0.163");
const SCHEMA = join(DIR, "schema");

type Frame = { dir: "in" | "out"; frame: any };
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const fixtureNames = () => readdirSync(DIR).filter((f) => f.endsWith(".jsonl"));
const readFrames = (name: string): Frame[] =>
	readFileSync(join(DIR, name), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

const PARAMS_SCHEMA: Record<string, string> = {
	"item/commandExecution/requestApproval": "CommandExecutionRequestApprovalParams.json",
	"item/fileChange/requestApproval": "FileChangeRequestApprovalParams.json",
};
const RESPONSE_SCHEMA: Record<string, [string, string]> = {
	"item/commandExecution/requestApproval": [
		"CommandExecutionRequestApprovalResponse.json",
		"CommandExecutionApprovalDecision",
	],
	"item/fileChange/requestApproval": [
		"FileChangeRequestApprovalResponse.json",
		"FileChangeApprovalDecision",
	],
};

function resolveRef(schema: any, node: any): any {
	if (node?.$ref?.startsWith("#/definitions/"))
		return schema.definitions[node.$ref.slice("#/definitions/".length)];
	return node;
}

function checkParams(schema: any, params: any) {
	for (const key of schema.required ?? []) expect(params).toHaveProperty(key);
	for (const [key, value] of Object.entries(params)) {
		const prop = schema.properties?.[key];
		expect(prop, `unexpected param ${key}`).toBeDefined();
		const resolved = resolveRef(schema, prop);
		if (typeof value === "string" && resolved?.enum) expect(resolved.enum).toContain(value);
	}
}

function decisionAllowed(decisionSchema: any, decision: unknown): boolean {
	return decisionSchema.oneOf.some((variant: any) => {
		if (variant.enum) return typeof decision === "string" && variant.enum.includes(decision);
		const key = decision && typeof decision === "object" ? Object.keys(decision)[0] : null;
		return !!key && !!variant.properties?.[key];
	});
}

describe("codex 0.163 fixtures", () => {
	test("at least 8 fixture files, including the named command-accept", () => {
		const names = fixtureNames();
		expect(names.length).toBeGreaterThanOrEqual(8);
		expect(names).toContain("command-accept.jsonl");
		expect(names).toContain("file-change-accept.jsonl");
	});

	test("command-accept.jsonl contains a command approval request", () => {
		const text = readFileSync(join(DIR, "command-accept.jsonl"), "utf8");
		expect(text).toContain("item/commandExecution/requestApproval");
	});

	test("every frame is JSON with a direction", () => {
		for (const name of fixtureNames()) {
			const frames = readFrames(name);
			expect(frames.length, name).toBeGreaterThan(2);
			for (const f of frames) expect(["in", "out"]).toContain(f.dir);
		}
	});

	test("approval requests, our answers and serverRequest/resolved validate against the schema subset", () => {
		let validatedRequests = 0;
		let validatedAnswers = 0;
		const resolvedSchema = readJson(join(SCHEMA, "v2", "ServerRequestResolvedNotification.json"));
		for (const name of fixtureNames()) {
			const methodById = new Map<string, string>();
			for (const { dir, frame } of readFrames(name)) {
				if (dir === "in" && frame.method && "id" in frame && PARAMS_SCHEMA[frame.method]) {
					checkParams(readJson(join(SCHEMA, PARAMS_SCHEMA[frame.method]!)), frame.params);
					methodById.set(JSON.stringify(frame.id), frame.method);
					validatedRequests++;
				} else if (dir === "out" && !frame.method && frame.result?.decision !== undefined) {
					const method = methodById.get(JSON.stringify(frame.id));
					expect(method, `${name}: answer with no request`).toBeDefined();
					const [file, def] = RESPONSE_SCHEMA[method!]!;
					const schema = readJson(join(SCHEMA, file));
					expect(
						decisionAllowed(schema.definitions[def], frame.result.decision),
						`${name}: ${JSON.stringify(frame.result)}`,
					).toBe(true);
					validatedAnswers++;
				} else if (frame.method === "serverRequest/resolved") {
					checkParams(resolvedSchema, frame.params);
				}
			}
		}
		expect(validatedRequests).toBeGreaterThanOrEqual(8);
		expect(validatedAnswers).toBeGreaterThanOrEqual(6);
	});

	test("the validator can fail: a bad decision and a missing field are rejected", () => {
		const response = readJson(join(SCHEMA, "FileChangeRequestApprovalResponse.json"));
		expect(decisionAllowed(response.definitions.FileChangeApprovalDecision, "accept")).toBe(true);
		expect(decisionAllowed(response.definitions.FileChangeApprovalDecision, "nonsense")).toBe(
			false,
		);
		const params = readJson(join(SCHEMA, "CommandExecutionRequestApprovalParams.json"));
		expect(() => checkParams(params, { threadId: "t" })).toThrow();
	});

	test("methods.json equals the schema's server-request method set", () => {
		const methods: string[] = readJson(join(DIR, "methods.json"));
		const fromSchema = readJson(join(SCHEMA, "ServerRequest.json"))
			.oneOf.map((v: any) => v.properties.method.enum[0])
			.sort();
		expect(methods.length).toBeGreaterThanOrEqual(10);
		expect(methods).toContain("item/fileChange/requestApproval");
		expect([...methods].sort()).toEqual(fromSchema);
	});

	test("no fixture or schema file carries a home path", () => {
		const walk = (dir: string): string[] =>
			readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
				e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
			);
		const files = walk(DIR);
		expect(files.length).toBeGreaterThan(15);
		for (const file of files)
			expect(readFileSync(file, "utf8"), file).not.toMatch(
				/\/Users\/|\/home\/|\/private\/|\/var\/folders/,
			);
		expect(existsSync(join(SCHEMA, "shape-hashes.json"))).toBe(true);
	});
});
