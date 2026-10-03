#!/usr/bin/env bun
/**
 * Architecture guard: the exclude-rules block in scripts/relay.ts must equal
 * what scripts/embed-exclude-rules.ts generates from the shared evaluator.
 * relay.ts is one self-contained file, so the evaluator is copied into it; this
 * is what stops the copy from being edited by hand or going stale.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRelayEmbed } from "./lib/relay-exclude-embed.ts";

const ROOT = join(import.meta.dir, "..");
const errors = checkRelayEmbed({
	relaySource: readFileSync(join(ROOT, "scripts/relay.ts"), "utf-8"),
	exclusionSource: readFileSync(join(ROOT, "src/shared/exclude-rules.ts"), "utf-8"),
	headersSource: readFileSync(join(ROOT, "src/shared/hook-headers.ts"), "utf-8"),
});
if (errors.length > 0) {
	for (const error of errors) console.error(`FAIL: ${error}`);
	process.exit(1);
}
console.log("OK: the exclude-rules block in scripts/relay.ts matches the shared evaluator");
