#!/usr/bin/env bun
/**
 * Writes the release verifier and its helpers into scripts/relay.ts between their marker comments (see
 * scripts/lib/relay-update-embed.ts). Run after any edit to the shared sources it names.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replaceUpdateBlocks } from "./lib/relay-update-embed.ts";

const ROOT = join(import.meta.dir, "..");
const relayPath = join(ROOT, "scripts/relay.ts");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8");
writeFileSync(relayPath, replaceUpdateBlocks(readFileSync(relayPath, "utf-8"), read));
console.log("embedded the release verifier blocks into scripts/relay.ts");
