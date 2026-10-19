import { describe, expect, test } from "bun:test";
import { withExecutableCapabilities } from "./config.js";

describe("the supervisor advertises that it applies launch privileges", () => {
	test("enforces_launch_privileges is in the features the server reads", async () => {
		const config = await withExecutableCapabilities({
			serverUrl: "http://localhost:3000",
			hostName: "h",
			platform: "linux",
			arch: "x64",
			version: "1",
			trustedRoots: [],
			capabilities: {
				version: 1,
				agentTypes: ["claude_code"],
				launchModes: ["headless"],
				os: "linux",
				terminalSupport: [],
				features: [],
			},
		} as never);
		expect(config.capabilities.features).toContain("enforces_launch_privileges");
	});
});
