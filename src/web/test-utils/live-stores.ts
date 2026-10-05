/**
 * Zustand's React hook answers a server render (react-dom/server, which these tests use) from the
 * store's INITIAL state, not its current one. A test that sets a store and then renders a component
 * reading it would see the defaults. This makes the server snapshot follow the live state for the
 * given stores, and returns the undo.
 */
interface FollowableStore {
	getState: () => unknown;
	getInitialState: () => unknown;
}

export function followLiveState(...stores: FollowableStore[]): () => void {
	const originals = stores.map((store) => store.getInitialState);
	for (const store of stores) store.getInitialState = () => store.getState();
	return () => {
		stores.forEach((store, i) => {
			store.getInitialState = originals[i];
		});
	};
}
