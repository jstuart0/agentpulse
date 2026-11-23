import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { flush, installDomStubs, removeDomStubs, renderHook } from "../test-utils/render-hook.js";
import { useAnnouncement } from "./useAnnouncement.js";

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());

type Props = { key: string | null; text: string | null };
const setup = () =>
	renderHook((p: Props) => useAnnouncement(p.key, p.text), { key: null, text: null } as Props);
const say = async (r: ReturnType<typeof setup>, p: Props) => {
	await r.render(p);
	await flush();
	return r.current.value;
};

describe("useAnnouncement", () => {
	test("the first red answer announces nothing", async () => {
		const r = setup();
		expect(await say(r, { key: null, text: null })).toBe("");
		expect(await say(r, { key: "security", text: "Update now." })).toBe("");
		await r.unmount();
	});

	test("available then security announces once, and a re-render of the same state does not repeat it", async () => {
		const r = setup();
		await say(r, { key: "available", text: null });
		expect(await say(r, { key: "security", text: "Update now." })).toBe("Update now.");
		expect(await say(r, { key: "security", text: "Update now." })).toBe("Update now.");
		await r.unmount();
	});

	test("security, available, security announces again: the text was cleared in between", async () => {
		const r = setup();
		await say(r, { key: "available", text: null });
		expect(await say(r, { key: "security", text: "Update now." })).toBe("Update now.");
		expect(await say(r, { key: "available", text: null })).toBe("");
		expect(await say(r, { key: "security", text: "Update now." })).toBe("Update now.");
		await r.unmount();
	});

	test("one red state turning into another is announced", async () => {
		const r = setup();
		await say(r, { key: "security", text: "A" });
		expect(await say(r, { key: "current_pulled", text: "B" })).toBe("B");
		await r.unmount();
	});

	test("a dismissed banner (no text) says nothing and clears what was said", async () => {
		const r = setup();
		await say(r, { key: "available", text: null });
		await say(r, { key: "security", text: "Update now." });
		expect(await say(r, { key: "security", text: null })).toBe("");
		await r.unmount();
	});
});
