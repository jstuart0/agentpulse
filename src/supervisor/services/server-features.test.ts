/**
 * What the server said it can do (AGEN-117 T12): set at registration, replaced by every heartbeat that gets
 * an answer, and off when absent. Plus a wiring check that index.ts really hands it to the handlers: the
 * supervisor's main() makes real network calls and can't run in a test.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServerFeatures } from "./server-features.js";

describe("createServerFeatures", () => {
	test("starts with what registration said", () => {
		const features = createServerFeatures(["codex_approvals", "claude_turn_control"]);
		expect(features.has("claude_turn_control")).toBe(true);
		expect(features.has("something_else")).toBe(false);
	});

	test("a heartbeat's list replaces the old one, it doesn't add to it", () => {
		const features = createServerFeatures(["claude_turn_control"]);
		features.set(["codex_approvals"]);
		expect(features.has("claude_turn_control")).toBe(false);
		expect(features.has("codex_approvals")).toBe(true);
	});

	test("absent means off: no initial list, or a heartbeat that carries none", () => {
		expect(createServerFeatures().has("claude_turn_control")).toBe(false);
		expect(createServerFeatures(null).has("claude_turn_control")).toBe(false);
		const features = createServerFeatures(["claude_turn_control"]);
		features.set(undefined);
		expect(features.has("claude_turn_control")).toBe(false);
		features.set(null);
		expect(features.has("claude_turn_control")).toBe(false);
	});

	test("`has` works detached from the object, as index.ts passes it", () => {
		const { has } = createServerFeatures(["claude_turn_control"]);
		expect(has("claude_turn_control")).toBe(true);
	});
});

describe("supervisor/index.ts wiring", () => {
	const text = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	const block = (start: string) => {
		const from = text.indexOf(start);
		expect(from).toBeGreaterThan(-1);
		return text.slice(from, text.indexOf("\n\t});", from));
	};

	test("the control handler gets serverHas and the shared final reporter", () => {
		const handler = block("createControlActionHandler({");
		expect(handler).toContain("serverHas: serverFeatures.has");
		expect(handler).toContain("finalReport");
	});

	test("the launch dispatcher gets the same final reporter", () => {
		expect(block("createLaunchDispatcher({")).toContain("finalReport");
	});

	test("the registration list seeds it and every answered heartbeat replaces it", () => {
		expect(text).toContain("createServerFeatures(registration.serverFeatures)");
		expect(text).toContain("serverFeatures.set(beat?.serverFeatures)");
	});
});
