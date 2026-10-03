import { describe, expect, test } from "bun:test";
import {
	type DirectoryEntry,
	disambiguateInitials,
	hitOwnerText,
	hostLabel,
	initialsFor,
	keyLabel,
	ownerLabel,
	sessionOwnerText,
} from "./owner-label.js";

function entry(id: string, displayName: string | null, disabled = false): DirectoryEntry {
	return { id, displayName, disabled };
}

describe("ownerLabel fallback chain", () => {
	test("the display name when there is one", () => {
		expect(ownerLabel(entry("u1", "Alice Smith"), "u1")).toBe("Alice Smith");
	});

	test("the local part of an email when the name is an address", () => {
		expect(ownerLabel(entry("u1", "jane.doe@corp.example"), "u1")).toBe("jane.doe");
	});

	test("'User' and the first four characters of the id when there is no name", () => {
		expect(ownerLabel(entry("3f2a9c10", null), "3f2a9c10")).toBe("User 3f2a");
		expect(ownerLabel(entry("3f2a9c10", "   "), "3f2a9c10")).toBe("User 3f2a");
	});

	test("an id the directory doesn't know yet reads the same way", () => {
		expect(ownerLabel(undefined, "9b7c1e22")).toBe("User 9b7c");
		expect(ownerLabel(null, "9b7c1e22")).toBe("User 9b7c");
	});

	test("never the stored sso: username", () => {
		expect(ownerLabel(entry("3f2a9c10", "sso:authentik:abc123"), "3f2a9c10")).toBe("User 3f2a");
	});

	test("a disabled person says so", () => {
		expect(ownerLabel(entry("u1", "Alice Smith", true), "u1")).toBe("Alice Smith (disabled)");
	});

	test("'you' style for the Owner select, 'suffix' style for a group header, plain otherwise", () => {
		const alice = entry("u1", "Alice Smith");
		expect(ownerLabel(alice, "u1", { selfId: "u1", style: "you" })).toBe("You");
		expect(ownerLabel(alice, "u1", { selfId: "u1", style: "suffix" })).toBe("Alice Smith (you)");
		expect(ownerLabel(alice, "u1", { selfId: "u1" })).toBe("Alice Smith");
		expect(ownerLabel(alice, "u1", { selfId: "u2", style: "you" })).toBe("Alice Smith");
	});
});

describe("owner labels are safe to show", () => {
	test("control and bidirectional-override characters are removed", () => {
		expect(ownerLabel(entry("u1", "Al\u202Eice\u0007 Smith\u2066"), "u1")).toBe("Alice Smith");
		expect(ownerLabel(entry("u1", "\u200Fbob\u0000"), "u1")).toBe("bob");
	});

	test("a name that is only stripped characters falls back like a missing name", () => {
		expect(ownerLabel(entry("3f2a9c10", "\u202E\u0007"), "3f2a9c10")).toBe("User 3f2a");
	});

	test("someone else called 'You' or 'Admin' gets their username appended", () => {
		const named = (name: string, username: string): DirectoryEntry => ({
			id: "u2",
			displayName: name,
			username,
			disabled: false,
		});
		expect(ownerLabel(named("You", "mallory"), "u2", { selfId: "u1", style: "you" })).toBe(
			"You (mallory)",
		);
		expect(ownerLabel(named("  admin ", "mallory"), "u2", { selfId: "u1" })).toBe(
			"admin (mallory)",
		);
		expect(ownerLabel(named("ADMIN", "mallory"), "u2")).toBe("ADMIN (mallory)");
	});

	test("a person whose login is 'admin' reads as admin, on any row", () => {
		const login = (displayName: string, authSource?: string): DirectoryEntry => ({
			id: "60b5aa01",
			displayName,
			username: "admin",
			authSource,
			disabled: false,
		});
		expect(ownerLabel(login("admin", "local"), "60b5aa01")).toBe("admin");
		expect(ownerLabel(login("admin", "local"), "60b5aa01", { selfId: "u1", style: "you" })).toBe(
			"admin",
		);
		expect(ownerLabel(login("admin", "local"), "60b5aa01", { selfId: "60b5aa01" })).toBe("admin");
	});

	test("a person whose sign-in name equals the shown name needs no suffix, whichever way they sign in", () => {
		const entry: DirectoryEntry = {
			id: "60b5aa01",
			displayName: "admin",
			username: "Admin",
			authSource: "sso",
			disabled: false,
		};
		expect(ownerLabel(entry, "60b5aa01")).toBe("admin");
	});

	test("an SSO person called admin whose login differs is told apart", () => {
		const entry: DirectoryEntry = {
			id: "60b5aa01",
			displayName: "Admin",
			username: "jsmith",
			authSource: "sso",
			disabled: false,
		};
		expect(ownerLabel(entry, "60b5aa01")).toBe("Admin (jsmith)");
	});

	test("a local account's directory entry (no login field) is its own name", () => {
		const local: DirectoryEntry = {
			id: "60b5aa01",
			displayName: "admin",
			authSource: "local",
			disabled: false,
		};
		expect(ownerLabel(local, "60b5aa01", { selfId: "u1", style: "you" })).toBe("admin");
	});

	test("an SSO display name of 'Admin' is told apart by the short id, never the stored handle", () => {
		const sso: DirectoryEntry = {
			id: "9b7c1e22",
			displayName: "Admin",
			username: "sso:authentik:abc123",
			authSource: "forwardauth",
			disabled: false,
		};
		expect(ownerLabel(sso, "9b7c1e22", { selfId: "u1" })).toBe("Admin (9b7c)");
		expect(ownerLabel({ ...sso, username: undefined }, "9b7c1e22", { selfId: "u1" })).toBe(
			"Admin (9b7c)",
		);
	});

	test("a directory entry that says nothing about its source and is called 'admin' reads as admin", () => {
		expect(ownerLabel(entry("60b5aa01", "admin"), "60b5aa01", { selfId: "u1" })).toBe("admin");
	});

	test("without a username the short id tells the two apart", () => {
		expect(ownerLabel(entry("3f2a9c10", "You"), "3f2a9c10", { selfId: "u1" })).toBe("You (3f2a)");
	});

	test("your own entry is not suffixed, and an ordinary name is left alone", () => {
		expect(ownerLabel(entry("u1", "Admin"), "u1", { selfId: "u1" })).toBe("Admin");
		expect(ownerLabel(entry("u1", "Administrator Smith"), "u2")).toBe("Administrator Smith");
	});
});

describe("initialsFor", () => {
	test("first letters of the first two parts when the name has separators", () => {
		expect(initialsFor(entry("u", "Alice Smith"), "u")).toBe("AS");
		expect(initialsFor(entry("u", "alice.smith"), "u")).toBe("AS");
		expect(initialsFor(entry("u", "alice_smith"), "u")).toBe("AS");
		expect(initialsFor(entry("u", "a-b-c"), "u")).toBe("AB");
	});

	test("never from a stored sso: handle: the id's first characters instead", () => {
		expect(initialsFor(entry("ab12cd", "sso:authentik:xyz"), "ab12cd")).toBe("AB");
	});

	test("the first two characters of a single-word handle", () => {
		expect(initialsFor(entry("u", "akadmin"), "u")).toBe("AK");
		expect(initialsFor(entry("u", "bob"), "u")).toBe("BO");
		expect(initialsFor(entry("u", "x"), "u")).toBe("X");
	});

	test("two handles that collide still collide here; the disambiguator handles it", () => {
		expect(initialsFor(entry("a", "jsmith"), "a")).toBe("JS");
		expect(initialsFor(entry("b", "jsmythe"), "b")).toBe("JS");
	});

	test("with no usable name, the first two characters of the id", () => {
		expect(initialsFor(entry("3f2a9c10", null), "3f2a9c10")).toBe("3F");
		expect(initialsFor(undefined, "9b7c1e22")).toBe("9B");
	});
});

describe("disambiguateInitials", () => {
	test("jsmith and jsmythe get four characters each; a different pair is left alone", () => {
		const result = disambiguateInitials([
			{ id: "1", entry: entry("1", "jsmith") },
			{ id: "2", entry: entry("2", "jsmythe") },
			{ id: "3", entry: entry("3", "Alice Smith") },
		]);
		expect(result.get("1")).toBe("JSmi");
		expect(result.get("2")).toBe("JSmy");
		expect(result.get("3")).toBe("AS");
	});

	test("keeps lengthening until the names part ways", () => {
		const result = disambiguateInitials([
			{ id: "1", entry: entry("1", "jsmith") },
			{ id: "2", entry: entry("2", "jsmitty") },
		]);
		expect(result.get("1")).toBe("JSmith");
		expect(result.get("2")).toBe("JSmitt");
	});

	test("nobody is dropped, and a lone person keeps the two-character form", () => {
		const result = disambiguateInitials([{ id: "1", entry: entry("1", "bob") }]);
		expect([...result.entries()]).toEqual([["1", "BO"]]);
	});
});

describe("hostLabel", () => {
	const directory = new Map([
		["u1", entry("u1", "Alice")],
		["u2", entry("u2", "Bob", true)],
	]);
	const lookup = (id: string) => directory.get(id);

	test("names whose host it is", () => {
		expect(hostLabel("alice-mbp", "u1", lookup, "u9")).toBe("alice-mbp (Alice's host)");
	});

	test("your own host says so", () => {
		expect(hostLabel("alice-mbp", "u1", lookup, "u1")).toBe("alice-mbp (your host)");
	});

	test("a host nobody owns", () => {
		expect(hostLabel("lab-box", null, lookup, "u1")).toBe("lab-box (unassigned host)");
		expect(hostLabel("lab-box", undefined, lookup, "u1")).toBe("lab-box (unassigned host)");
	});

	test("a disabled owner, and an owner the directory hasn't loaded", () => {
		expect(hostLabel("bob-pc", "u2", lookup, "u1")).toBe("bob-pc (Bob's host, disabled)");
		expect(hostLabel("new-pc", "7d3e55aa", lookup, "u1")).toBe("new-pc (User 7d3e's host)");
	});
});

describe("sessionOwnerText", () => {
	const directory = new Map([["u1", entry("u1", "Alice Smith")]]);
	const lookup = (id: string) => directory.get(id);

	test("a person's name, or 'You' for your own session", () => {
		expect(sessionOwnerText({ ownerUserId: "u1", ownerKind: "user" }, lookup, "u9")).toBe(
			"Alice Smith",
		);
		expect(sessionOwnerText({ ownerUserId: "u1", ownerKind: "user" }, lookup, "u1")).toBe("You");
	});

	test("an owner the directory hasn't loaded yet still reads as a person", () => {
		expect(sessionOwnerText({ ownerUserId: "7d3e55aa" }, lookup, "u1")).toBe("User 7d3e");
	});

	test("no owner: a service key's sessions say so; nothing known says nobody owns it", () => {
		expect(sessionOwnerText({ ownerUserId: null, ownerKind: "service" }, lookup)).toBe(
			"Service key",
		);
		expect(sessionOwnerText({ ownerUserId: null, ownerKind: "unassigned" }, lookup)).toBe(
			"Unassigned",
		);
		expect(sessionOwnerText({}, lookup)).toBe("Unassigned");
	});
});

describe("names that would show as nothing, or as someone else", () => {
	test("a name made only of invisible letters falls back to the login, else to the id", () => {
		const blank = "\u3164\u3164\u2800\u17B4";
		expect(
			ownerLabel(
				{ id: "3f2a9c10", displayName: blank, username: "carol", disabled: false },
				"3f2a9c10",
			),
		).toBe("carol");
		expect(ownerLabel(entry("3f2a9c10", blank), "3f2a9c10")).toBe("User 3f2a");
		expect(initialsFor(entry("3f2a9c10", blank), "3f2a9c10")).toBe("3F");
	});

	test("another person's name that ends in (you) is told apart from the viewer", () => {
		const label = ownerLabel(entry("9b7c1e22", "Bob (you)"), "9b7c1e22", { selfId: "u1" });
		expect(label.endsWith("(you)")).toBe(false);
		expect(label).toBe("Bob (you) (9b7c)");
		expect(ownerLabel(entry("9b7c1e22", "Bob (YOU)"), "9b7c1e22", { selfId: "u1" })).toBe(
			"Bob (YOU) (9b7c)",
		);
	});

	test("initials are cut to eight characters however long the shared prefix is", () => {
		const map = disambiguateInitials([
			{ id: "a", entry: entry("a", "internal-alpha-service-one") },
			{ id: "b", entry: entry("b", "internal-alpha-service-two") },
		]);
		for (const value of map.values()) expect([...value].length).toBeLessThanOrEqual(8);
	});
});

describe("keyLabel", () => {
	test("a key's name goes through the same cleaning as a person's", () => {
		expect(keyLabel("  ci\u202E-runner\u0007 ")).toBe("ci-runner");
		expect(keyLabel("build agent")).toBe("build agent");
	});

	test("an empty or invisible key name reads as Unnamed key", () => {
		expect(keyLabel("")).toBe("Unnamed key");
		expect(keyLabel("\u200B\u3164")).toBe("Unnamed key");
		expect(keyLabel(null)).toBe("Unnamed key");
	});

	test("a long name is cut", () => {
		expect([...keyLabel("x".repeat(200))].length).toBeLessThanOrEqual(64);
	});
});

describe("hitOwnerText: the owner a search hit carries", () => {
	const lookup = (id: string) => (id === "u2" ? entry("u2", "Alice Smith") : undefined);

	test("a hit with an owner names them, and says You for the viewer", () => {
		expect(hitOwnerText({ ownerUserId: "u2", ownerKind: "user" }, lookup, "u1")).toBe(
			"Alice Smith",
		);
		expect(hitOwnerText({ ownerUserId: "u1", ownerKind: "user" }, lookup, "u1")).toBe("You");
	});

	test("service keys and unassigned sessions are named as such", () => {
		expect(hitOwnerText({ ownerUserId: null, ownerKind: "service" }, lookup, "u1")).toBe(
			"Service key",
		);
		expect(hitOwnerText({ ownerUserId: null, ownerKind: "unassigned" }, lookup, "u1")).toBe(
			"Unassigned",
		);
	});

	test("a hit that says nothing about an owner shows nothing", () => {
		expect(hitOwnerText({}, lookup, "u1")).toBeNull();
	});
});
