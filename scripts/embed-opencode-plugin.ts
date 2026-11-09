#!/usr/bin/env bun
/**
 * Writes the OpenCode plugin texts into src/shared/opencode-plugin-text.generated.ts
 * and between the marker pairs of scripts/setup-hooks.sh and scripts/install-local.ps1
 * (see scripts/lib/opencode-plugin-embed.ts). Run after any edit to
 * scripts/opencode-plugin/ or to the shared constants the plugin block carries.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildAll,
	generatedModuleText,
	installerModuleText,
	renderPsInstaller,
	renderShInstaller,
	replaceInstallBody,
	replaceSiteBody,
	siteBody,
} from "./lib/opencode-plugin-embed.ts";

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf-8");
const built = buildAll({
	core: read("scripts/opencode-plugin/core.js"),
	v1: read("scripts/opencode-plugin/agentpulse-opencode-1.js"),
	v2: read("scripts/opencode-plugin/agentpulse-opencode-2.js"),
});
writeFileSync(
	join(ROOT, "src/shared/opencode-plugin-text.generated.ts"),
	generatedModuleText(built),
);
const shTemplate = read("scripts/opencode-installer/install.sh");
const psTemplate = read("scripts/opencode-installer/install.ps1");
writeFileSync(
	join(ROOT, "src/shared/opencode-install-text.generated.ts"),
	installerModuleText(renderShInstaller(shTemplate, "setup-sh")),
);
for (const [file, site] of [
	["scripts/setup-hooks.sh", "sh"],
	["scripts/setup-relay.sh", "sh-relay"],
	["scripts/install-local.ps1", "ps1"],
] as const) {
	let text = read(file);
	if (site !== "sh-relay") {
		for (const line of ["v1", "v2"] as const)
			text = replaceSiteBody(text, line, siteBody(site, line, built[line]));
	}
	const body =
		site === "ps1"
			? renderPsInstaller(psTemplate)
			: renderShInstaller(shTemplate, site === "sh" ? "setup-hooks" : "setup-relay");
	text = replaceInstallBody(text, site === "ps1" ? "ps1" : "sh", body);
	writeFileSync(join(ROOT, file), text);
}
console.log("embedded the OpenCode plugins");
