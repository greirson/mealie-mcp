import { pino, type Logger } from 'pino';

export type { Logger };

const REDACT = [
  'authorization', 'cookie', 'mealie_token', 'mealieToken', 'access_token', 'refresh_token', 'code', 'code_verifier', 'token',
  '*.authorization', '*.cookie', '*.mealie_token', '*.mealieToken', '*.access_token', '*.refresh_token', '*.code', '*.code_verifier', '*.token',
];

export function createLogger(level: string): Logger {
  return pino({ level, redact: { paths: REDACT, censor: '[redacted]' } });
}
