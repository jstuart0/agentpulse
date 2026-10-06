/**
 * Zustand's React hook answers a server render (react-dom/server, which these tests use) from the
 * store's INITIAL state object, not its current one. A test that sets a store and then renders a
 * component reading it would see the defaults. This keeps that initial object equal to the live
 * state for the given stores while it is active: it copies the live state into it now, and again
 * after every `setState` the test makes on the store. The returned function puts it all back.
 */
interface FollowableStore {
	getState: () => object;
	getInitialState: () => object;
	setState: (...args: never[]) => unknown;
}

export function followLiveState(...stores: FollowableStore[]): () => void {
	const undo = stores.map((store) => {
		const initial = store.getInitialState();
		const saved = { ...initial };
		const original = store.setState;
		const mirror = () => Object.assign(initial, store.getState());
		store.setState = ((...args: never[]) => {
			const result = (original as (...a: never[]) => unknown)(...args);
			mirror();
			return result;
		}) as typeof store.setState;
		mirror();
		return () => {
			store.setState = original;
			for (const key of Object.keys(initial)) delete (initial as Record<string, unknown>)[key];
			Object.assign(initial, saved);
		};
	});
	return () => {
		for (const restore of undo) restore();
	};
}
