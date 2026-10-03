/**
 * Which shell the app renders. A user who must replace a password someone
 * else chose gets only the password form: the server refuses every other
 * route for them, so showing the app would be a screen of failed requests.
 */
export type AppGate = "loading" | "login" | "change_password" | "app";

export function deriveAppGate(input: {
	loaded: boolean;
	authenticated: boolean;
	disableAuth: boolean;
	mustChangePassword: boolean;
}): AppGate {
	if (!input.loaded) return "loading";
	if (input.disableAuth) return "app";
	if (!input.authenticated) return "login";
	return input.mustChangePassword ? "change_password" : "app";
}
