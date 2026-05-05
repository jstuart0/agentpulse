/**
 * Formats a forwardauth provider identifier into a display label.
 *
 * Known special cases handle compound identifiers (e.g. "oauth2-proxy")
 * that naive capitalization would mangle. Everything else gets its first
 * character uppercased (e.g. "authelia" → "Authelia", "pomerium" → "Pomerium").
 *
 * Returns an empty string when provider is falsy — callers can substitute
 * a fallback ("SSO") at the call site.
 */
const KNOWN_LABELS: Record<string, string> = {
	"oauth2-proxy": "OAuth2-Proxy",
	"cloudflare-access": "Cloudflare Access",
	cloudflare: "Cloudflare Access",
};

export function formatProviderLabel(provider: string): string {
	if (!provider) return "";
	const lower = provider.toLowerCase();
	if (lower in KNOWN_LABELS) return KNOWN_LABELS[lower];
	// Generic: capitalize first character, lowercase the rest.
	return provider.charAt(0).toUpperCase() + provider.slice(1).toLowerCase();
}
