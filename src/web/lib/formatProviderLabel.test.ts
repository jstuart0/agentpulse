import { describe, expect, test } from "bun:test";
import { formatProviderLabel } from "./formatProviderLabel.js";

describe("formatProviderLabel", () => {
	test("authentik → Authentik", () => {
		expect(formatProviderLabel("authentik")).toBe("Authentik");
	});

	test("authelia → Authelia", () => {
		expect(formatProviderLabel("authelia")).toBe("Authelia");
	});

	test("oauth2-proxy → OAuth2-Proxy (known special case)", () => {
		expect(formatProviderLabel("oauth2-proxy")).toBe("OAuth2-Proxy");
	});

	test("pomerium → Pomerium", () => {
		expect(formatProviderLabel("pomerium")).toBe("Pomerium");
	});

	test("CUSTOM → Custom (uppercased input lowercased to first-char-up)", () => {
		expect(formatProviderLabel("CUSTOM")).toBe("Custom");
	});

	test("empty string → empty string", () => {
		expect(formatProviderLabel("")).toBe("");
	});

	test("cloudflare-access → Cloudflare Access (known special case)", () => {
		expect(formatProviderLabel("cloudflare-access")).toBe("Cloudflare Access");
	});

	test("cloudflare → Cloudflare Access (known alias)", () => {
		expect(formatProviderLabel("cloudflare")).toBe("Cloudflare Access");
	});

	test("Pomerium (already capitalized) → Pomerium", () => {
		// Uppercased first char, rest lowercased — same result
		expect(formatProviderLabel("Pomerium")).toBe("Pomerium");
	});
});
