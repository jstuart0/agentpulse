import { describe, expect, test } from "bun:test";
import { pushCapability } from "./push-capability.js";

describe("pushCapability", () => {
	test("is null when no relay is configured", () => {
		expect(pushCapability(null)).toBeNull();
		expect(pushCapability("")).toBeNull();
	});

	test("advertises features.mobilePush as a boolean and push.relayOrigin as the origin, nothing more", () => {
		expect(pushCapability("https://relay.example.com/v1/base")).toEqual({
			features: { mobilePush: true },
			push: { relayOrigin: "https://relay.example.com" },
		});
		expect(pushCapability("http://127.0.0.1:8797")?.push.relayOrigin).toBe("http://127.0.0.1:8797");
	});
});
