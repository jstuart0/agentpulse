import { describe, expect, test } from "bun:test";
import { drawerItems, machinesMenuItems, userMenuItems } from "./nav-items.js";
import { ownershipUi } from "./ownership-ui.js";

const solo = ownershipUi("solo", { effectiveRole: "admin" });
const member = ownershipUi("team", { effectiveRole: "member" });
const admin = ownershipUi("team", { effectiveRole: "admin" });

describe("machinesMenuItems", () => {
	test("solo: Setup and Hosts, as they have always been", () => {
		expect(machinesMenuItems(solo)).toEqual([
			{ to: "/setup", label: "Setup" },
			{ to: "/hosts", label: "Hosts" },
		]);
	});

	test("team: the same destinations under the words people use for their own machines", () => {
		expect(machinesMenuItems(member)).toEqual([
			{ to: "/setup", label: "Set up hooks" },
			{ to: "/hosts", label: "Hosts" },
		]);
	});
});

describe("userMenuItems", () => {
	test("solo: Settings, and Change password for a local account, exactly as before", () => {
		expect(userMenuItems(solo, { isLocal: true })).toEqual([
			{ to: "/settings", label: "Settings" },
			{ to: "/settings?panel=account", label: "Change password" },
		]);
		expect(userMenuItems(solo, { isLocal: false })).toEqual([
			{ to: "/settings", label: "Settings" },
		]);
	});

	test("team admin: a Users item that opens the team section", () => {
		expect(userMenuItems(admin, { isLocal: true })).toEqual([
			{ to: "/settings", label: "Settings" },
			{ to: "/settings?panel=team", label: "Users" },
			{ to: "/settings?panel=account", label: "Change password" },
		]);
	});

	test("team member: no Users item", () => {
		expect(userMenuItems(member, { isLocal: false })).toEqual([
			{ to: "/settings", label: "Settings" },
		]);
	});
});

describe("drawerItems", () => {
	test("solo: the 'Admin' heading with Setup, Hosts, Settings", () => {
		expect(drawerItems(solo, { isLocal: true })).toEqual({
			heading: "Admin",
			links: [
				{ to: "/setup", label: "Setup" },
				{ to: "/hosts", label: "Hosts" },
				{ to: "/settings", label: "Settings" },
			],
		});
	});

	test("team member with a local account: 'Machines', no Users, and Change password", () => {
		expect(drawerItems(member, { isLocal: true })).toEqual({
			heading: "Machines",
			links: [
				{ to: "/setup", label: "Set up hooks" },
				{ to: "/hosts", label: "Hosts" },
				{ to: "/settings", label: "Settings" },
				{ to: "/settings?panel=account", label: "Change password" },
			],
		});
	});

	test("team member signed in through SSO: no password to change", () => {
		expect(drawerItems(member, { isLocal: false }).links.map((link) => link.label)).toEqual([
			"Set up hooks",
			"Hosts",
			"Settings",
		]);
	});

	test("team admin: Users after Settings, then Change password for a local account", () => {
		const labels = drawerItems(admin, { isLocal: false }).links.map((link) => link.label);
		expect(labels).toEqual(["Set up hooks", "Hosts", "Settings", "Users"]);
		const local = drawerItems(admin, { isLocal: true }).links.map((link) => link.label);
		expect(local).toEqual(["Set up hooks", "Hosts", "Settings", "Users", "Change password"]);
	});

	test("solo drawer stays exactly today's three links even for a local account", () => {
		expect(drawerItems(solo, { isLocal: true }).links.map((link) => link.label)).toEqual([
			"Setup",
			"Hosts",
			"Settings",
		]);
	});
});
