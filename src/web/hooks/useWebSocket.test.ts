import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { useDashboardScopeStore } from "../stores/dashboard-scope-store.js";
import { useEventStore } from "../stores/event-store.js";
import { useSessionStore } from "../stores/session-store.js";
import { useUserStore } from "../stores/user-store.js";
import {
	installDomStubs,
	removeDomStubs,
	renderHook,
	setDocumentHidden,
} from "../test-utils/render-hook.js";
import { useWebSocket } from "./useWebSocket.js";

const ME = "me-id";
const ALICE = "alice-id";

class FakeSocket {
	static all: FakeSocket[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	sent: string[] = [];
	constructor(public url: string) {
		FakeSocket.all.push(this);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {}
}

const notifications: Array<{ title: string; body: string | undefined }> = [];
class FakeNotification {
	static permission = "granted";
	constructor(title: string, options?: { body?: string }) {
		notifications.push({ title, body: options?.body });
	}
}

// biome-ignore lint/suspicious/noExplicitAny: hand-built rows stand in for the server's DTO
function row(id: string, owner: string | null, isWorking: boolean): any {
	return {
		sessionId: id,
		displayName: id,
		ownerUserId: owner,
		ownerKind: owner ? "user" : "unassigned",
		status: "active",
		isWorking,
		isArchived: false,
		endedAt: null,
		isPinned: false,
		cwd: "/w/proj",
		agentType: "claude_code",
	};
}

async function deliver(socket: FakeSocket, message: unknown) {
	await act(async () => {
		socket.onmessage?.({ data: JSON.stringify(message) });
	});
}

async function finishedAfterWorking(socket: FakeSocket, session: (working: boolean) => unknown) {
	await deliver(socket, { type: "session_updated", data: { session: session(true) } });
	await deliver(socket, { type: "session_updated", data: { session: session(false) } });
}

const realGlobals: Record<string, unknown> = {};
let hook: ReturnType<typeof renderHook<boolean, unknown>>;
let socket: FakeSocket;

beforeAll(() => installDomStubs());
afterAll(() => removeDomStubs());

beforeEach(async () => {
	const g = globalThis as unknown as Record<string, unknown>;
	for (const key of ["WebSocket", "Notification", "location"]) realGlobals[key] = g[key];
	g.WebSocket = FakeSocket;
	g.Notification = FakeNotification;
	g.location = { protocol: "http:", host: "app.test" };
	FakeSocket.all = [];
	notifications.length = 0;
	setDocumentHidden(true);
	useSessionStore.setState({ sessions: [] });
	useEventStore.setState({ liveEvents: new Map() });
	useUserStore.setState({ userId: ME, mode: "team", effectiveRole: "member" } as never);
	useDashboardScopeStore.setState({ owner: "all", resolved: true });
	hook = renderHook((enabled: boolean) => useWebSocket(enabled), true);
	await hook.render(true);
	socket = FakeSocket.all[0];
});

afterEach(async () => {
	await hook.unmount();
	const g = globalThis as unknown as Record<string, unknown>;
	for (const [key, value] of Object.entries(realGlobals)) {
		if (value === undefined) delete g[key];
		else g[key] = value;
	}
	useDashboardScopeStore.setState({ owner: "all", resolved: true });
	useUserStore.setState({ mode: "solo" } as never);
});

describe("desktop notification when a turn finishes in a hidden tab", () => {
	test("the viewer's own session notifies under Everyone", async () => {
		await finishedAfterWorking(socket, (w) => row("s-mine", ME, w));
		expect(notifications.map((n) => n.title)).toEqual(["s-mine finished"]);
	});

	test("and while the view is another person's sessions: the notification doesn't depend on the view", async () => {
		useDashboardScopeStore.setState({ owner: ALICE, resolved: true });
		await finishedAfterWorking(socket, (w) => row("s-mine", ME, w));
		expect(notifications.map((n) => n.title)).toEqual(["s-mine finished"]);
		expect(useSessionStore.getState().sessions).toEqual([]);
	});

	test("another person's session never notifies, in any view", async () => {
		await finishedAfterWorking(socket, (w) => row("s-hers", ALICE, w));
		useDashboardScopeStore.setState({ owner: ALICE, resolved: true });
		await finishedAfterWorking(socket, (w) => row("s-hers-2", ALICE, w));
		expect(notifications).toEqual([]);
	});

	test("an unowned session doesn't notify in team mode", async () => {
		await finishedAfterWorking(socket, (w) => row("s-none", null, w));
		expect(notifications).toEqual([]);
	});

	test("nothing fires while the tab is visible", async () => {
		setDocumentHidden(false);
		await finishedAfterWorking(socket, (w) => row("s-mine", ME, w));
		expect(notifications).toEqual([]);
	});

	test("solo notifies for every session, as before", async () => {
		useUserStore.setState({ mode: "solo", userId: null } as never);
		await finishedAfterWorking(socket, (w) => row("s-any", ALICE, w));
		expect(notifications.map((n) => n.title)).toEqual(["s-any finished"]);
	});
});

describe("notifications that must not fire", () => {
	const updated = (session: unknown) => ({ type: "session_updated", data: { session } });

	test("an update that was not a working-to-finished transition doesn't notify", async () => {
		await deliver(socket, updated(row("s-mine", ME, false)));
		await deliver(socket, updated(row("s-mine", ME, false)));
		await deliver(socket, updated(row("s-mine", ME, true)));
		await deliver(socket, updated(row("s-mine", ME, true)));
		expect(notifications).toEqual([]);
	});

	test("someone else's new session doesn't notify; the viewer's own does", async () => {
		await deliver(socket, {
			type: "session_created",
			data: { session: row("s-hers", ALICE, true) },
		});
		expect(notifications).toEqual([]);
		await deliver(socket, { type: "session_created", data: { session: row("s-mine", ME, true) } });
		expect(notifications.map((n) => n.title)).toEqual(["New session"]);
	});

	test("with no viewer id nothing counts as the viewer's own", async () => {
		useUserStore.setState({ userId: null, mode: "team" } as never);
		await finishedAfterWorking(socket, (w) => row("s-none", null, w));
		await finishedAfterWorking(socket, (w) => row("s-any", ALICE, w));
		await deliver(socket, { type: "session_created", data: { session: row("s-new", null, true) } });
		expect(notifications).toEqual([]);
	});
});

describe("live events (only a session id)", () => {
	const event = (sessionId: string) => ({ type: "new_event", data: { sessionId, id: 1 } });

	test("under a narrowed view another person's events don't pile up in the event store", async () => {
		useDashboardScopeStore.setState({ owner: "me", resolved: true });
		useSessionStore.setState({ sessions: [row("s-mine", ME, false)] });
		await deliver(socket, event("s-hers-1"));
		await deliver(socket, event("s-hers-2"));
		await deliver(socket, event("s-mine"));
		expect([...useEventStore.getState().liveEvents.keys()]).toEqual(["s-mine"]);
	});

	test("a session the store doesn't hold is still followed while its detail page is open", async () => {
		useDashboardScopeStore.setState({ owner: "me", resolved: true });
		// biome-ignore lint/suspicious/noExplicitAny: the detail page's seam on the event store
		(useEventStore as any).setState({ watchedSessionId: "s-hers-open" });
		await deliver(socket, event("s-hers-open"));
		await deliver(socket, event("s-hers-closed"));
		expect([...useEventStore.getState().liveEvents.keys()]).toEqual(["s-hers-open"]);
	});

	test("solo keeps every event", async () => {
		useUserStore.setState({ mode: "solo", userId: null } as never);
		await deliver(socket, event("s-any"));
		expect([...useEventStore.getState().liveEvents.keys()]).toEqual(["s-any"]);
	});
});

describe("a row from a server that sends no owner at all", () => {
	test("is kept if it was already shown and is not added if it wasn't", async () => {
		useDashboardScopeStore.setState({ owner: "me", resolved: true });
		const legacy = (id: string, working: boolean) => {
			const { ownerUserId: _o, ownerKind: _k, ...rest } = row(id, null, working);
			return rest;
		};
		useSessionStore.setState({ sessions: [legacy("s-shown", false) as never] });
		await deliver(socket, { type: "session_updated", data: { session: legacy("s-shown", true) } });
		await deliver(socket, { type: "session_updated", data: { session: legacy("s-new", true) } });
		const rows = useSessionStore.getState().sessions;
		expect(rows.map((s) => s.sessionId)).toEqual(["s-shown"]);
		expect(rows[0].isWorking).toBe(true);
	});
});
