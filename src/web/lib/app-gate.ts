/**
 * Which shell the app renders. A user who must replace a password someone
 * else chose gets only the password form: the server refuses every other
 * route for them, so showing the app would be a screen of failed requests.
 */
export type AppGate = "loading" | "host_refused" | "login" | "change_password" | "app";

export function deriveAppGate(input: {
	loaded: boolean;
	authenticated: boolean;
	disableAuth: boolean;
	mustChangePassword: boolean;
	/** The server refused this address (auth off, AGEN-92): nothing else would load. */
	hostRefused?: boolean;
}): AppGate {
	if (!input.loaded) return "loading";
	if (input.hostRefused) return "host_refused";
	if (input.disableAuth) return "app";
	if (!input.authenticated) return "login";
	return input.mustChangePassword ? "change_password" : "app";
}
