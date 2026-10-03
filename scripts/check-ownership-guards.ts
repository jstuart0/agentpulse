#!/usr/bin/env bun
/**
 * Architecture guard: three populations the ownership work depends on stay
 * under review (see scripts/lib/ownership-guards.ts). Fails when a new file
 * writes a session's owner column, deletes session rows without going through
 * services/authorization.js, or uses an ordinary database handle inside a
 * withAdminLock body.
 */
import { checkOwnershipGuards } from "./lib/ownership-guards.js";
import { loadTsFiles } from "./lib/test-seam-utils.js";

const root = new URL("..", import.meta.url).pathname;
const files = (await loadTsFiles(root, [`${root}src/server`])).filter(
	(file) => !/\.(test|fixture)\.ts$/.test(file.rel) && !/(^|\/)test-utils\//.test(file.rel),
);
const report = checkOwnershipGuards(files);
if (report.violations.length > 0) {
	console.error(report.violations.join("\n"));
	process.exit(1);
}
console.log(
	"OK: owner-column writers, session deletes and admin-lock bodies are all accounted for",
);
