import { useCallback, useEffect, useRef, useState } from "react";

export interface StopConfirm {
	open: boolean;
	busy: boolean;
	/** The refusal or failure from the last attempt, in plain words. */
	error: string | null;
	/** The Stop button: opens the confirmation. Sends nothing. */
	request(): void;
	cancel(): void;
	/** The confirm button: runs `perform` once. It resolves to a message when the stop failed, null when it was queued. */
	confirm(perform: (isCurrent: () => boolean) => Promise<string | null>): Promise<void>;
}

/**
 * The step between the Stop button and the request (AGEN-110): one tap opens a confirmation and sends
 * nothing; only its confirm button runs the stop, and only once while it is in flight. A failure keeps the
 * dialog open with the reason, so the person isn't left guessing whether anything happened.
 *
 * `scopeKey` names what the dialog is about (the session id). When it changes the dialog closes and forgets
 * its error, and the answer of a request still running for the old key is dropped: the Back button with the
 * dialog open must not leave it open over, or about to stop, another session.
 */
export function useStopConfirm(
	scopeKey: string | undefined = undefined,
	/** Called when the dialog was open and is closed for the person (the session changed): put focus somewhere. */
	onAbandoned?: () => void,
): StopConfirm {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const running = useRef(false);
	const epoch = useRef(0);
	const lastKey = useRef(scopeKey);
	const wasOpen = useRef(false);
	wasOpen.current = open;
	const abandoned = useRef(onAbandoned);
	abandoned.current = onAbandoned;

	useEffect(() => {
		if (lastKey.current === scopeKey) return;
		lastKey.current = scopeKey;
		epoch.current += 1;
		running.current = false;
		const hadDialog = wasOpen.current;
		setOpen(false);
		setBusy(false);
		setError(null);
		if (hadDialog) abandoned.current?.();
	}, [scopeKey]);

	const request = useCallback(() => {
		setError(null);
		setOpen(true);
	}, []);

	const cancel = useCallback(() => {
		if (running.current) return;
		setOpen(false);
		setError(null);
	}, []);

	const confirm = useCallback(
		async (perform: (isCurrent: () => boolean) => Promise<string | null>) => {
			if (running.current) return;
			running.current = true;
			const mine = epoch.current;
			setBusy(true);
			setError(null);
			try {
				// `isCurrent` lets the request skip what it would do afterwards (reload, announce) for a session
				// the person has since left.
				const failure = await perform(() => epoch.current === mine);
				if (epoch.current !== mine) return;
				if (failure === null) setOpen(false);
				else setError(failure);
			} catch (cause) {
				if (epoch.current !== mine) return;
				setError(cause instanceof Error ? cause.message : "Couldn't stop the session.");
			} finally {
				if (epoch.current === mine) {
					running.current = false;
					setBusy(false);
				}
			}
		},
		[],
	);

	return { open, busy, error, request, cancel, confirm };
}
