import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * Renders a hook through react-dom against a stub container, so hooks and their
 * effects can be driven in a plain `bun test` run with no DOM library. The
 * stub only needs to be good enough for react-dom to mount and unmount a root
 * that renders nothing.
 */
type GlobalStub = Record<string, unknown>;
const STUBBED = ["IS_REACT_ACT_ENVIRONMENT", "window", "HTMLIFrameElement", "document"] as const;
const saved = new Map<string, { had: boolean; value: unknown }>();

export function installDomStubs(overrides: { hidden?: boolean } = {}): void {
	const g = globalThis as unknown as GlobalStub;
	for (const key of STUBBED) {
		if (!saved.has(key)) saved.set(key, { had: key in g, value: g[key] });
	}
	g.IS_REACT_ACT_ENVIRONMENT = true;
	g.window = globalThis;
	g.HTMLIFrameElement = class {};
	g.document = {
		activeElement: null,
		body: {},
		documentElement: {},
		hidden: overrides.hidden ?? false,
		addEventListener() {},
		removeEventListener() {},
	};
}

export function removeDomStubs(): void {
	const g = globalThis as unknown as GlobalStub;
	for (const [key, previous] of saved) {
		if (previous.had) g[key] = previous.value;
		else delete g[key];
	}
	saved.clear();
}

/** Flip `document.hidden` for a test (a hidden tab is when desktop notifications fire). */
export function setDocumentHidden(hidden: boolean): void {
	(globalThis as unknown as { document: { hidden: boolean } }).document.hidden = hidden;
}

export function renderHook<P, R>(hook: (props: P) => R, initial: P) {
	const container = {
		nodeType: 1,
		nodeName: "DIV",
		tagName: "DIV",
		namespaceURI: "http://www.w3.org/1999/xhtml",
		ownerDocument: {
			createElement: () => ({}),
			nodeType: 9,
			addEventListener() {},
			removeEventListener() {},
		},
		addEventListener() {},
		removeEventListener() {},
		appendChild() {},
		removeChild() {},
		childNodes: [],
		style: {},
	};
	const current: { value: R | undefined } = { value: undefined };
	function Probe({ props }: { props: P }) {
		current.value = hook(props);
		return null;
	}
	const root = createRoot(container as unknown as Element);
	return {
		current,
		initial,
		async render(props: P) {
			await act(async () => {
				root.render(createElement(Probe, { props }));
			});
		},
		async unmount() {
			await act(async () => {
				root.unmount();
			});
		},
	};
}

/**
 * How much longer than a hook's own debounce a test waits for it: tests name the
 * hook's exported constant plus this, never a bare number that happens to be larger.
 */
export const TIMER_MARGIN_MS = 250;

/** Lets pending promises and zero-delay timers settle inside act(). */
export async function flush(ms = 8): Promise<void> {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
