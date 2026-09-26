import type { OAuthMetadata } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import { OAUTH_PATHS } from './paths.js';

export function buildAuthServerMetadata(config: Config): OAuthMetadata {
  const at = (path: string) => new URL(path, config.publicUrl).href;
  return {
    issuer: config.publicUrl.href,
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
  };
}

export function mcpResourceUrl(config: Config): URL {
  return new URL('/mcp', config.publicUrl);
}
