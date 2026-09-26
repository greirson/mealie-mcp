import { createMcpExpressApp } from '@modelcontextprotocol/express';
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { mountAuth, type AuthDeps } from '../auth/index.js';
import { oauthError } from '../auth/respond.js';
import type { Logger } from '../log.js';
import { mountMcp } from '../mcp/index.js';
import { healthHandler } from './health.js';

export type AppDeps = AuthDeps;

export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  // Host validation guards against DNS rebinding; json parsing is applied by createMcpExpressApp.
  const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: [config.publicUrl.hostname, 'localhost', '127.0.0.1'] });
  app.disable('x-powered-by');
  app.use(requestLogger(logger));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  // Malformed JSON/urlencoded bodies must surface as the same JSON oauth error
  // shape as every other auth failure, never Express's default HTML/stack-trace
  // error page (which can leak internal file paths outside NODE_ENV=production).
  app.use(bodyParseErrorHandler);
  mountAuth(app, deps);
  app.get('/healthz', healthHandler(config));
  mountMcp(app, deps);
  return app;
}

function bodyParseErrorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const type = err && typeof err === 'object' ? (err as { type?: unknown }).type : undefined;
  const isBodyParseError = type === 'entity.parse.failed' || err instanceof SyntaxError;
  if (!isBodyParseError) {
    next(err);
    return;
  }
  oauthError(res, 400, 'invalid_request', 'Request body must be valid JSON or form-encoded data');
}

function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const start = performance.now();
    res.on('finish', () => {
      // Path only: query strings on the authorize endpoint carry OAuth state and must not be logged.
      logger.info({ method: req.method, path: req.path, status: res.statusCode, ms: Math.round(performance.now() - start) }, 'request');
    });
    next();
  };
}
