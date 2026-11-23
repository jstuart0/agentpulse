/**
 * Ties the installer to the reader: the relay and statusline that GET /setup-relay.sh hands a client
 * machine are read by `agentpulse version` (buildVersionReport) as the current release, so a version
 * constant that moved, or a reader pattern that stopped matching, fails here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import pkg from "../../../package.json" with { type: "json" };
import "../db/__test_db.js";

const { buildVersionReport } = await import("../../shared/version-report.js");
const { setup } = await import("./setup.js");
const { config } = await import("../config.js");

const home = realpathSync(mkdtempSync(join(tmpdir(), "ap-served-version-")));
const savedPublicUrl = { url: config.publicUrl, explicit: config.publicUrlExplicit };
afterAll(() => {
	config.publicUrl = savedPublicUrl.url;
	config.publicUrlExplicit = savedPublicUrl.explicit;
	rmSync(home, { recursive: true, force: true });
});

function heredoc(script: string, file: string, terminator: string): string {
	const match = new RegExp(
		`cat > "\\$SRC_DIR/${file.replace(".", "\\.")}" << '${terminator}'\\n([\\s\\S]*?)\\n${terminator}\\n`,
	).exec(script);
	if (!match) throw new Error(`no ${file} heredoc in the served installer`);
	return `${match[1]}\n`;
}

describe("the served relay installer and `agentpulse version`", () => {
	test("the relay and statusline it installs read as the current release", async () => {
		config.publicUrl = "https://agentpulse.example.com";
		config.publicUrlExplicit = true;
		const res = await new Hono().route("/", setup).request("/setup-relay.sh");
		expect(res.status).toBe(200);
		const script = await res.text();
		mkdirSync(join(home, ".agentpulse"), { mode: 0o700 });
		chmodSync(join(home, ".agentpulse"), 0o700);
		mkdirSync(join(home, ".claude"));
		writeFileSync(
			join(home, ".agentpulse", "relay.ts"),
			heredoc(script, "relay.ts", "AGENTPULSE_RELAY_TS_EOF"),
		);
		writeFileSync(
			join(home, ".claude", "statusline-agentpulse.sh"),
			heredoc(script, "statusline.sh", "AGENTPULSE_STATUSLINE_SH_EOF"),
		);
		const lines = buildVersionReport({
			appVersion: pkg.version,
			home,
			checkoutDir: join(home, "no-checkout"),
			env: {},
		});
		expect(lines).toContain(`  Relay: ${pkg.version}`);
		expect(lines).toContain(`  Statusline: ${pkg.version}`);
	});
});
