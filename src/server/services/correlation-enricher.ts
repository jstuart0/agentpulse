import { linkObservedSessionToLaunch } from "./launch-dispatch.js";

export async function enrichObservedSession(sessionId: string) {
	return linkObservedSessionToLaunch(sessionId);
}
