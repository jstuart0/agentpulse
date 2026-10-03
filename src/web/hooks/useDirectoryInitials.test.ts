import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DirectoryUser } from "../lib/api.js";
import { disambiguateInitials } from "../lib/owner-label.js";
import { directoryEntryFromAdminRow } from "../lib/people.js";
import { installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useDirectoryInitials } from "./useDirectoryInitials.js";

/**
 * A person's initials are the same on the owner chip (the card and the session
 * header) as in Settings > People: both are made against the whole directory,
 * so two people who share two letters read as three or more everywhere.
 */
beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());

const alice: DirectoryUser = { id: "u1", displayName: "Alice Smith", disabled: false };
const andy: DirectoryUser = { id: "u2", displayName: "Andy Sanders", disabled: false };

describe("useDirectoryInitials", () => {
	test("people who share two letters are told apart, the same way the People list tells them apart", async () => {
		const directory = { u1: alice, u2: andy };
		const h = renderHook((d: typeof directory) => useDirectoryInitials(d), directory);
		await h.render(directory);

		const people = disambiguateInitials(
			[alice, andy].map((user) => ({
				id: user.id,
				entry: directoryEntryFromAdminRow({
					id: user.id,
					username: user.displayName ?? "",
					displayName: user.displayName,
					authSource: "forwardauth",
					disabled: false,
				} as never),
			})),
		);
		expect(h.current.value?.get("u1")).toBe("ALi");
		expect(h.current.value?.get("u2")).toBe("ANd");
		expect(Object.fromEntries(h.current.value ?? [])).toEqual(Object.fromEntries(people));
		await h.unmount();
	});

	test("one person alone keeps the two-letter form", async () => {
		const h = renderHook((d: Record<string, DirectoryUser>) => useDirectoryInitials(d), {
			u1: alice,
		});
		await h.render({ u1: alice });
		expect(h.current.value?.get("u1")).toBe("AS");
		await h.unmount();
	});
});

describe("the session header does not use a private, empty initials map", () => {
	test("SessionDetailPage and SessionGrid both take their initials from useDirectoryInitials", () => {
		for (const file of [
			["pages", "SessionDetailPage.tsx"],
			["components", "SessionGrid.tsx"],
		]) {
			const source = readFileSync(join(import.meta.dir, "..", ...file), "utf8");
			expect(source, file.join("/")).toContain("useDirectoryInitials(");
			expect(source, file.join("/")).not.toContain("initialsById: new Map()");
		}
	});
});
