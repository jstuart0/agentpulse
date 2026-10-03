/**
 * The machine filter reaches the wire: the exact URL each scoped call asks for,
 * with the name encoded as one value, so removing the parameter from any of the
 * query builders fails here and not on a user's screen.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api } from "./api.js";
import { HOST_UNKNOWN } from "./host-scope.js";
import { scopedQuery } from "./scoped-query.js";

const realFetch = globalThis.fetch;
let urls: string[] = [];

beforeEach(() => {
	urls = [];
	globalThis.fetch = (async (url: string) => {
		urls.push(String(url));
		return new Response(JSON.stringify({ sessions: [], total: 0, groups: [] }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const search = (url: string) => new URL(url, "http://x").searchParams;
const NAMES: Array<[string, string, string]> = [
	["a plain name", "build-01", "build-01"],
	["the unknown token", HOST_UNKNOWN, "host=%1Funknown"],
	["a name with & = % and spaces", "A&B=100% ok", "host=A%26B%3D100%25+ok"],
];

describe("host= on the wire", () => {
	for (const [label, host, raw] of NAMES) {
		test(`list, stats, grouped stats and the team line carry ${label}`, async () => {
			const scope = { owner: "me", excludeScratch: true, host };
			await api.getSessions(scopedQuery(scope, { tab: "active", limit: 5 }));
			await api.getStats(scopedQuery(scope));
			await api.getStatsByOwner(scopedQuery(scope));
			await api.getStatsByHost(scopedQuery(scope));
			await api.getEveryoneStats(true, host);
			expect(urls).toHaveLength(5);
			for (const url of urls) {
				expect({ url, host: search(url).get("host") }).toEqual({ url, host });
				if (raw.startsWith("host=")) expect(url).toContain(raw);
			}
			expect(urls[0]).toContain("/sessions?");
			expect(urls[1]).toContain("/sessions/stats?");
			expect(urls[2]).toContain("group_by=owner");
			expect(urls[3]).toContain("group_by=host");
			expect(search(urls[0]).get("owner")).toBe("me");
			expect(search(urls[4]).get("owner")).toBeNull();
		});
	}

	test("every machine sends no host on any of them", async () => {
		for (const host of [undefined, ""]) {
			urls = [];
			const scope = { owner: "all", excludeScratch: false, host };
			await api.getSessions(scopedQuery(scope));
			await api.getStats(scopedQuery(scope));
			await api.getStatsByOwner(scopedQuery(scope));
			await api.getStatsByHost(scopedQuery(scope));
			await api.getEveryoneStats(false, host);
			for (const url of urls) expect({ url, has: search(url).has("host") }).toEqual({ url, has: false });
		}
	});
});
