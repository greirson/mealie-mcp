import type { RequestHandler } from 'express';
import type { Config } from '../config.js';

export function healthHandler(config: Config): RequestHandler {
  return async (_req, res) => {
    try {
      const r = await fetch(`${config.mealieUrl}/api/app/about`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const about = (await r.json()) as { version?: string };
      res.json({ status: 'ok', mealieVersion: about.version });
    } catch {
      res.status(503).json({ status: 'degraded', error: 'Mealie is unreachable from the MCP container' });
    }
  };
}
