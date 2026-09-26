import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Config } from '../config.js';

export function clientIp(req: Request, trustCloudflare: boolean): string {
  const cf = req.header('cf-connecting-ip');
  if (trustCloudflare && cf) return cf;
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** One limiter per route: call once per mount so counters are independent. */
export function authRateLimit(config: Config): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: config.authRateLimitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req, config.trustCloudflare)),
    handler: (_req, res) => {
      res.status(429).set('Retry-After', '60').json({ error: 'too_many_requests', error_description: 'Too many attempts. Wait a minute and try again.' });
    },
  });
}
