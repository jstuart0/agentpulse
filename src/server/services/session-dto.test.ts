import { describe, expect, test } from "bun:test";
import { mapSessionDto } from "./session-dto.js";

function row(
	overrides: Partial<{ displayName: string | null; metadata: Record<string, unknown> }>,
) {
	return {
		id: "1",
		sessionId: "s1",
		displayName: "brave-falcon",
		metadata: {},
		...overrides,
	};
}

describe("mapSessionDto — nameSource derivation (D14)", () => {
	test("nameSource is 'user' when metadata.renameSource === 'user'", () => {
		const dto = mapSessionDto(row({ metadata: { renameSource: "user" } }));
		expect(dto.nameSource).toBe("user");
	});

	test("nameSource is 'native' when displayName === metadata.lastAppliedNativeName", () => {
		const dto = mapSessionDto(
			row({
				displayName: "claude-native-name",
				metadata: { lastAppliedNativeName: "claude-native-name" },
			}),
		);
		expect(dto.nameSource).toBe("native");
	});

	test("nameSource is 'generated' when neither condition holds", () => {
		const dto = mapSessionDto(row({ displayName: "brave-falcon", metadata: {} }));
		expect(dto.nameSource).toBe("generated");
	});

	test("renameSource:'user' wins over a matching lastAppliedNativeName (precedence)", () => {
		const dto = mapSessionDto(
			row({
				displayName: "claude-native-name",
				metadata: { renameSource: "user", lastAppliedNativeName: "claude-native-name" },
			}),
		);
		expect(dto.nameSource).toBe("user");
	});

	test("nativeName mirrors metadata.nativeName, or null when absent", () => {
		expect(mapSessionDto(row({ metadata: { nativeName: "codex-thread-name" } })).nativeName).toBe(
			"codex-thread-name",
		);
		expect(mapSessionDto(row({ metadata: {} })).nativeName).toBeNull();
	});

	test("extras are merged onto the mapped result", () => {
		const dto = mapSessionDto(row({}), { managed: true });
		expect(dto.managed).toBe(true);
		expect(dto.nameSource).toBe("generated");
	});

	test("a null metadata object does not throw", () => {
		// biome-ignore lint/suspicious/noExplicitAny: simulating a raw DB row with metadata: null
		const dto = mapSessionDto(row({ metadata: null as any }));
		expect(dto.nameSource).toBe("generated");
		expect(dto.nativeName).toBeNull();
	});
});
