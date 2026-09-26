import type { Response } from 'express';

export function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json({ error, error_description: description });
}
