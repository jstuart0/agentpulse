import { describe, expect, test } from "bun:test";
import { INSTALLER_SOURCES, buildRelayInstaller } from "../server/installers.js";
import { buildBashExcludeScript, materializeExcludeScript } from "./hook-command.js";
import { extractRelayInstallerParts, heredocHazard } from "./relay-installer-parts.js";

const served = () => {
	const built = buildRelayInstaller(INSTALLER_SOURCES, "https://agentpulse.example.test");
	if (!built.ok) throw new Error(built.reason);
	return built.script;
};

const oneNewline = (text: string) => `${text.replace(/\n+$/, "")}\n`;

describe("extractRelayInstallerParts", () => {
	test("the served /setup-relay.sh gives back the relay and statusline sources", () => {
		const r = extractRelayInstallerParts(served());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.parts.relay).toBe(oneNewline(INSTALLER_SOURCES.relay));
		expect(r.parts.statusline).toBe(oneNewline(INSTALLER_SOURCES.statusline));
	});

	test("synthetic sources round-trip through buildRelayInstaller", () => {
		const sources = {
			...INSTALLER_SOURCES,
			relay: "export const RELAY_VERSION = \"9.9.9\";\nconsole.log('r');\n",
			statusline: "#!/bin/sh\necho s\n",
		};
		const built = buildRelayInstaller(sources, "https://agentpulse.example.test");
		if (!built.ok) throw new Error(built.reason);
		const r = extractRelayInstallerParts(built.script);
		expect(r.ok && r.parts.relay).toBe(sources.relay);
		expect(r.ok && r.parts.statusline).toBe(sources.statusline);
	});

	test("the exclude heredoc materializes to exactly what buildBashExcludeScript writes (named member: the served script)", () => {
		const r = extractRelayInstallerParts(served());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(materializeExcludeScript(r.parts.excludeHeredoc)).toBe(buildBashExcludeScript());
	});

	test("refuses a script with a missing terminator, a repeated opener, or no opener", () => {
		const good = served();
		const noTerminator = good.replace(/^AGENTPULSE_RELAY_TS_EOF$/m, "");
		expect(extractRelayInstallerParts(noTerminator)).toEqual({
			ok: false,
			reason: expect.stringContaining("relay.ts"),
		});
		const opener = `cat > "$SRC_DIR/statusline.sh" << 'AGENTPULSE_STATUSLINE_SH_EOF'`;
		expect(
			extractRelayInstallerParts(`${good}\n${opener}\nx\nAGENTPULSE_STATUSLINE_SH_EOF\n`).ok,
		).toBe(false);
		expect(extractRelayInstallerParts("echo nothing here\n").ok).toBe(false);
		const noExclude = good.replace("<<'AP_EXCLUDE_SCRIPT_EOF'", "<<'AP_SOMETHING_ELSE'");
		expect(extractRelayInstallerParts(noExclude).ok).toBe(false);
	});

	test("a CRLF installer is refused, never half-extracted", () => {
		const crlf = served().replace(/\n/g, "\r\n");
		const r = extractRelayInstallerParts(crlf);
		expect(r.ok).toBe(false);
	});
});

describe("heredocHazard", () => {
	test("a line equal to any terminator, or an installer marker, can't be carried", () => {
		for (const t of [
			"AGENTPULSE_RELAY_TS_EOF",
			"AGENTPULSE_STATUSLINE_SH_EOF",
			"AP_EXCLUDE_SCRIPT_EOF",
		]) {
			expect(heredocHazard(`a\n${t}\nb\n`), t).toContain(t);
		}
		expect(heredocHazard("x\n# @@AGENTPULSE_RELAY_TS@@\n")).toContain("marker");
	});

	test("a terminator only inside a longer line is fine, and so is ordinary text", () => {
		expect(heredocHazard("echo AGENTPULSE_RELAY_TS_EOF_not\n")).toBeNull();
		expect(heredocHazard("const x = 1;\n")).toBeNull();
	});
});
