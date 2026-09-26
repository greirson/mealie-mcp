/**
 * OAuth endpoint paths. They live under /mcp/ so a reverse proxy can share one hostname with
 * Mealie by forwarding only ^/(mcp|\.well-known/oauth-) to this server. Mealie itself owns
 * top-level routes such as /register (household invite sign-up), so nothing may live there.
 */
export const OAUTH_PATHS = {
  authorize: '/mcp/oauth/authorize',
  token: '/mcp/oauth/token',
  register: '/mcp/oauth/register',
  revoke: '/mcp/oauth/revoke',
} as const;
