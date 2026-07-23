/**
 * The package's own version, read at runtime from its package.json (D4 of
 * thoughts/shared/plans/2026-07-23-deliver-agentpulse-mcp-package.md).
 *
 * `createRequire` resolves relative to this module's own location, so it
 * works identically from `src/` under bun (dev/in-repo shim) and from
 * `dist/` under node (the published build) — a source-level
 * `import pkg from "../package.json"` would instead have tsc widen its
 * `rootDir` to include package.json, which we don't want in the build
 * output.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export const VERSION: string = packageJson.version;
