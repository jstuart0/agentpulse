import { useEffect, useState } from "react";
import { api } from "../lib/api.js";

/** The server's advertised features, read once per page load and shared by whoever asks. */
let pending: Promise<ReadonlySet<string> | null> | null = null;

function loadServerFeatures(): Promise<ReadonlySet<string> | null> {
	pending ??= api
		.getCapabilities()
		.then(
			(answer) =>
				new Set(
					Object.entries(answer.features ?? {})
						.filter(([, on]) => on === true)
						.map(([name]) => name),
				),
		)
		.catch(() => {
			// A failed read is not remembered: the next dialog asks again.
			pending = null;
			return null;
		});
	return pending;
}

/**
 * The features this server advertises on `/capabilities`, or null until they are known (or if they can't be
 * read). A control that depends on one is hidden until it is on: an older server never shows an option it
 * would refuse.
 */
export function useServerFeatures(): ReadonlySet<string> | null {
	const [features, setFeatures] = useState<ReadonlySet<string> | null>(null);
	useEffect(() => {
		let live = true;
		void loadServerFeatures().then((next) => {
			if (live) setFeatures(next);
		});
		return () => {
			live = false;
		};
	}, []);
	return features;
}
