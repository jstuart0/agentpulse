/**
 * Node.js CJS require hook: resolves .js extensions to .ts files when the
 * .js file does not exist on disk. This is needed because drizzle-kit runs
 * under Node.js/CJS but the project schema files use ESM-style .js imports
 * (standard TypeScript "bundler" moduleResolution).
 *
 * Usage: node --require ./scripts/drizzle-hook.cjs ...
 */
const Module = require("node:module");

const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
	// Only remap bare .js requests that resolve to missing files.
	if (request.endsWith(".js") && !request.startsWith("node:")) {
		// Try the original resolution first.
		try {
			return originalResolveFilename.call(this, request, parent, isMain, options);
		} catch (e) {
			if (e.code === "MODULE_NOT_FOUND") {
				// Replace .js with .ts and try again.
				const tsRequest = `${request.slice(0, -3)}.ts`;
				try {
					return originalResolveFilename.call(this, tsRequest, parent, isMain, options);
				} catch {
					// Fall through — throw the original error.
				}
			}
			throw e;
		}
	}
	return originalResolveFilename.call(this, request, parent, isMain, options);
};
