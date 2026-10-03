import { describe, expect, test } from "bun:test";
import type { AdminUserRow } from "./api.js";
import type { DirectoryEntry } from "./owner-label.js";
import { assignablePeople, directoryEntryFromAdminRow, withCurrentOwner } from "./people.js";

function row(over: Partial<AdminUserRow> & { id: string; username: string }): AdminUserRow {
	return {
		displayName: null,
		role: "user",
		disabled: false,
		authSource: "local",
		provider: null,
		subjectSource: null,
		lastLoginAt: null,
		roleLockedByEnv: false,
		mustChangePassword: false,
		keyCount: 0,
		hostCount: 0,
		...over,
	};
}

const person = (id: string, displayName: string | null, disabled = false): DirectoryEntry => ({
	id,
	displayName,
	disabled,
});

describe("directoryEntryFromAdminRow", () => {
	test("a local account is its login name; an SSO account is its display name", () => {
		expect(directoryEntryFromAdminRow(row({ id: "u1", username: "alice" }))).toEqual({
			id: "u1",
			displayName: "alice",
			username: "alice",
			authSource: "local",
			disabled: false,
		});
		expect(
			directoryEntryFromAdminRow(
				row({
					id: "u2",
					username: "sso:authentik:abc",
					authSource: "forwardauth",
					displayName: "Dave Jones",
					disabled: true,
				}),
			),
		).toEqual({
			id: "u2",
			displayName: "Dave Jones",
			username: "sso:authentik:abc",
			authSource: "forwardauth",
			disabled: true,
		});
	});
});

describe("assignablePeople", () => {
	const everyone = [
		person("u3", "carol"),
		person("u1", "alice"),
		person("u4", "Dave"),
		person("u5", "gone", true),
		person("u2", "bob"),
	];

	test("not disabled, by name, case-insensitively", () => {
		expect(assignablePeople(everyone, null).map((p) => p.label)).toEqual([
			"alice",
			"bob",
			"carol",
			"Dave",
		]);
	});

	test("you first and labelled 'You', wherever you sort", () => {
		const result = assignablePeople(everyone, "u4");
		expect(result[0]).toEqual({ id: "u4", label: "You" });
		expect(result.slice(1).map((p) => p.label)).toEqual(["alice", "bob", "carol"]);
	});

	test("someone named 'Admin' who isn't you is told apart by their username", () => {
		const result = assignablePeople(
			[
				{ id: "u9", displayName: "Admin", username: "mallory", disabled: false },
				person("u1", "alice"),
			],
			"u1",
		);
		expect(result.map((p) => p.label)).toEqual(["You", "Admin (mallory)"]);
	});

	test("nobody is lost and an empty directory gives an empty list", () => {
		expect(assignablePeople([], "u1")).toEqual([]);
		expect(assignablePeople(everyone, "u1")).toHaveLength(4);
	});
});

describe("withCurrentOwner", () => {
	const options = [
		{ id: "u1", label: "You" },
		{ id: "u3", label: "carol" },
	];

	test("a disabled current owner is listed as '<name> (disabled)', so the select can show and keep it", () => {
		const gone = person("u9", "Dave Jones", true);
		const result = withCurrentOwner(options, "u9", gone, "u1");
		expect(result.find((option) => option.id === "u9")).toEqual({
			id: "u9",
			label: "Dave Jones (disabled)",
		});
		expect(result.map((option) => option.id)).toEqual(["u9", "u1", "u3"]);
	});

	test("an active owner, no owner, or an owner already listed changes nothing", () => {
		expect(withCurrentOwner(options, "u3", person("u3", "carol"), "u1")).toEqual(options);
		expect(withCurrentOwner(options, null, undefined, "u1")).toEqual(options);
		expect(withCurrentOwner(options, undefined, undefined, "u1")).toEqual(options);
	});

	test("an owner the directory doesn't know still shows, by a readable fallback", () => {
		const result = withCurrentOwner(options, "abcd1234", undefined, "u1");
		expect(result[0].id).toBe("abcd1234");
		expect(result[0].label).toBe("User abcd (disabled)");
	});

	test("the viewer is never offered twice", () => {
		const me = person("u1", "me", true);
		expect(withCurrentOwner(options, "u1", me, "u1")).toEqual(options);
	});
});
