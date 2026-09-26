import { mcpAuthMetadataRouter } from '@modelcontextprotocol/express';
import type { Express } from 'express';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { Store } from '../store/repo.js';
import { authorizeGetHandler, authorizePostHandler } from './authorize.js';
import { buildAuthServerMetadata, mcpResourceUrl } from './metadata.js';
import { OAUTH_PATHS } from './paths.js';
import { authRateLimit } from './rate-limit.js';
import { registerHandler } from './register.js';
import { revokeHandler, tokenHandler } from './token.js';

export interface AuthDeps {
  config: Config;
  store: Store;
  logger: Logger;
}

export function mountAuth(app: Express, deps: AuthDeps): void {
  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: buildAuthServerMetadata(deps.config),
      resourceServerUrl: mcpResourceUrl(deps.config),
      scopesSupported: ['mealie'],
      resourceName: 'Mealie',
      // http is only possible for localhost (enforced by loadConfig).
      dangerouslyAllowInsecureIssuerUrl: deps.config.publicUrl.protocol === 'http:',
    })
  );
  app.post(OAUTH_PATHS.register, registerHandler(deps));
  app.get(OAUTH_PATHS.authorize, authRateLimit(deps.config), authorizeGetHandler(deps));
  app.post(OAUTH_PATHS.authorize, authRateLimit(deps.config), authorizePostHandler(deps));
  app.post(OAUTH_PATHS.token, authRateLimit(deps.config), tokenHandler(deps));
  app.post(OAUTH_PATHS.revoke, revokeHandler(deps));
}
