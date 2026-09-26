import { getOAuthProtectedResourceMetadataUrl, requireBearerAuth } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Express } from 'express';
import { mcpResourceUrl } from '../auth/metadata.js';
import { createVerifier } from '../auth/verifier.js';
import type { AppDeps } from '../http/app.js';
import { createServerFactory } from './server-factory.js';

export function mountMcp(app: Express, deps: AppDeps): void {
  const handler = createMcpHandler(createServerFactory(deps), {
    onerror: (err) => deps.logger.error({ reason: err.message }, 'mcp handler error'),
  });
  const node = toNodeHandler(handler);
  const auth = requireBearerAuth({
    verifier: createVerifier(deps.store, deps.config.encryptionKey),
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpResourceUrl(deps.config)),
  });
  app.all('/mcp', auth, (req, res) => void node(req, res, req.body));
}
