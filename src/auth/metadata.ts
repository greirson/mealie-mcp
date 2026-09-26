import type { OAuthMetadata } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import { OAUTH_PATHS } from './paths.js';

/**
 * The OAuth issuer identifier for this server. RFC 9207 requires every authorization response
 * (success or error) to carry an `iss` parameter that is byte-identical to the AS metadata
 * `issuer`; both are derived from this single function so they cannot drift apart.
 */
export function authServerIssuer(config: Config): string {
  return config.publicUrl.href;
}

export function buildAuthServerMetadata(config: Config): OAuthMetadata {
  const at = (path: string) => new URL(path, config.publicUrl).href;
  return {
    issuer: authServerIssuer(config),
    authorization_endpoint: at(OAUTH_PATHS.authorize),
    token_endpoint: at(OAUTH_PATHS.token),
    registration_endpoint: at(OAUTH_PATHS.register),
    revocation_endpoint: at(OAUTH_PATHS.revoke),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mealie'],
    // RFC 9207: lets ChatGPT/Codex (and other conformant clients) verify the authorization
    // response came from this issuer and use a stable redirect URI instead of a per-request one.
    authorization_response_iss_parameter_supported: true,
  };
}

export function mcpResourceUrl(config: Config): URL {
  return new URL('/mcp', config.publicUrl);
}
