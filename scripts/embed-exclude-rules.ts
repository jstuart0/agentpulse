#!/usr/bin/env bun
/**
 * Writes the shared exclude-rules evaluator into scripts/relay.ts between its
 * marker comments (see scripts/lib/relay-exclude-embed.ts). Run after any edit
 * to src/shared/exclude-rules.ts or the constants it uses from hook-headers.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildEmbeddedBlock, replaceEmbeddedBlock } from "./lib/relay-exclude-embed.ts";

const ROOT = join(import.meta.dir, "..");
const relayPath = join(ROOT, "scripts/relay.ts");
const next = replaceEmbeddedBlock(
	readFileSync(relayPath, "utf-8"),
	buildEmbeddedBlock({
		exclusionSource: readFileSync(join(ROOT, "src/shared/exclude-rules.ts"), "utf-8"),
		headersSource: readFileSync(join(ROOT, "src/shared/hook-headers.ts"), "utf-8"),
	}),
);
writeFileSync(relayPath, next);
console.log("embedded the exclude-rules evaluator into scripts/relay.ts");
