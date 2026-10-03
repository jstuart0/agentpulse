# AUTHENTIK-FORWARDAUTH.md (deprecated — see FORWARDAUTH.md)

This document has moved to `FORWARDAUTH.md`, which covers Authentik
alongside Authelia, oauth2-proxy, Pomerium, and Cloudflare Access.

This stub is retained until v0.7.0 to avoid breaking external links
and bookmarks. It will be removed in v0.7.0.

Team mode adds requirements for SSO installs (admin subjects need the uid
header, the proxy must strip client-supplied identity headers, and the provider
label must not change once people have signed in). They are in the "Teams"
subsection of `FORWARDAUTH.md`, which is where Authentik's settings live now.
