import { describe, expect, test } from "bun:test";
import type { AdminUserRow } from "./api.js";
import type { DirectoryEntry } from "./owner-label.js";
import { assignablePeople, directoryEntryFromAdminRow } from "./people.js";

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
