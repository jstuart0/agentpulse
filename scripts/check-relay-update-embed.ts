#!/usr/bin/env bun
/**
 * Architecture guard: every release-verifier block in scripts/relay.ts must equal what
 * scripts/embed-relay-update.ts generates from the shared sources. The relay is one copied file, so its trust
 * root and verifier are copies; this is what stops a copy from being edited by hand or going stale.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRelayUpdateEmbed } from "./lib/relay-update-embed.ts";

const ROOT = join(import.meta.dir, "..");
const errors = checkRelayUpdateEmbed(readFileSync(join(ROOT, "scripts/relay.ts"), "utf-8"), (rel) =>
	readFileSync(join(ROOT, rel), "utf-8"),
);
if (errors.length > 0) {
	for (const error of errors) console.error(`FAIL: ${error}`);
	process.exit(1);
}
console.log("OK: the release-verifier blocks in scripts/relay.ts match the shared sources");
