import { describe, expect, test } from "bun:test";
import { mapSessionDto } from "./session-dto.js";

function row(
	overrides: Partial<{
		displayName: string | null;
		metadata: Record<string, unknown>;
		ownerUserId: string | null;
		ingestKeyId: string | null;
		status: string;
		isWorking: boolean;
		isArchived: boolean;
		endedAt: string | null;
		semanticStatus: string | null;
		lastAgentTurnCompletedAt: string | null;
		lastUserAcknowledgedAt: string | null;
	}>,
) {
	return {
		id: "1",
		sessionId: "s1",
		displayName: "brave-falcon",
		metadata: {},
		ownerUserId: null,
		ingestKeyId: null,
		status: "active",
		isWorking: false,
		isArchived: false,
		endedAt: null,
		semanticStatus: null,
		lastAgentTurnCompletedAt: null,
		lastUserAcknowledgedAt: null,
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

describe("mapSessionDto — ownerKind derivation and ingestKeyId stripping", () => {
	test("ownerKind is 'user' when ownerUserId is set", () => {
		const dto = mapSessionDto(row({ ownerUserId: "user-A", ingestKeyId: "key-1" }));
		expect(dto.ownerKind).toBe("user");
	});

	test("ownerKind is 'service' when ownerUserId is null but ingestKeyId is set", () => {
		const dto = mapSessionDto(row({ ownerUserId: null, ingestKeyId: "key-service" }));
		expect(dto.ownerKind).toBe("service");
	});

	test("ownerKind is 'unassigned' when both are null (DISABLE_AUTH, pre-upgrade)", () => {
		const dto = mapSessionDto(row({ ownerUserId: null, ingestKeyId: null }));
		expect(dto.ownerKind).toBe("unassigned");
	});

	test("an admin-overridden row (owner set, no key) is still ownerKind 'user'", () => {
		const dto = mapSessionDto(row({ ownerUserId: "user-admin-assigned", ingestKeyId: null }));
		expect(dto.ownerKind).toBe("user");
	});

	test("mapping a session that was already mapped keeps its kind (the key id is gone by then)", () => {
		for (const overrides of [
			{ ownerUserId: "user-A", ingestKeyId: "key-1" },
			{ ownerUserId: null, ingestKeyId: "key-service" },
			{ ownerUserId: null, ingestKeyId: null },
		] as const) {
			const once = mapSessionDto(row(overrides));
			const twice = mapSessionDto(once);
			expect(twice.ownerKind).toBe(once.ownerKind);
		}
	});

	test("ingestKeyId is absent from the output, not just undefined, in every owner state", () => {
		for (const overrides of [
			{ ownerUserId: "user-A", ingestKeyId: "key-1" },
			{ ownerUserId: null, ingestKeyId: "key-service" },
			{ ownerUserId: null, ingestKeyId: null },
		] as const) {
			const dto = mapSessionDto(row(overrides));
			expect(Object.hasOwn(dto, "ingestKeyId")).toBe(false);
		}
	});
});

describe("mapSessionDto — operationalStatus is computed by the shared classifier", () => {
	test("isWorking -> working", () => {
		expect(mapSessionDto(row({ isWorking: true })).operationalStatus).toBe("working");
	});

	test("no timing data at all, not working -> idle", () => {
		expect(mapSessionDto(row({})).operationalStatus).toBe("idle");
	});

	test("an unacknowledged finished turn -> waiting", () => {
		expect(
			mapSessionDto(row({ lastAgentTurnCompletedAt: "2026-10-01T10:00:00Z" })).operationalStatus,
		).toBe("waiting");
	});

	test("an unacknowledged failure -> error", () => {
		expect(
			mapSessionDto(row({ status: "failed", endedAt: "2026-10-01T10:00:00Z" })).operationalStatus,
		).toBe("error");
	});

	test("archived -> completed", () => {
		expect(mapSessionDto(row({ isArchived: true })).operationalStatus).toBe("completed");
	});
});
