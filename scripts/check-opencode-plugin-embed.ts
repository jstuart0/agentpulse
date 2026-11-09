#!/usr/bin/env bun
/**
 * Architecture guard: the OpenCode plugin copies (the generated TypeScript
 * module and the bodies in setup-hooks.sh and install-local.ps1) must equal
 * what scripts/embed-opencode-plugin.ts generates, each marker pair must occur
 * once, and the final text must pass the source rules.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkOpenCodePluginEmbed } from "./lib/opencode-plugin-embed.ts";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");
const errors = checkOpenCodePluginEmbed({
	sources: {
		core: read("scripts/opencode-plugin/core.js"),
		v1: read("scripts/opencode-plugin/agentpulse-opencode-1.js"),
		v2: read("scripts/opencode-plugin/agentpulse-opencode-2.js"),
	},
	generatedModule: read("src/shared/opencode-plugin-text.generated.ts"),
	setupHooksSh: read("scripts/setup-hooks.sh"),
	installLocalPs1: read("scripts/install-local.ps1"),
	setupRelaySh: read("scripts/setup-relay.sh"),
});
if (errors.length > 0) {
	for (const error of errors) console.error(`FAIL: ${error}`);
	process.exit(1);
}
console.log("OK: the OpenCode plugin copies match the sources");
