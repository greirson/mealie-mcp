import type { RequestHandler } from 'express';
import * as z from 'zod';
import type { AuthDeps } from './index.js';
import { oauthError } from './respond.js';

const bodySchema = z.looseObject({
  redirect_uris: z.array(z.string()).min(1),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function checkRedirectUri(uri: string, allowedHosts: string[]): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `Invalid redirect URI: ${uri}`;
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return `Redirect URI must use https (http is allowed only for localhost): ${uri}`;
  }
  if (url.hash) return 'Redirect URI must not contain a fragment';
  if (!allowedHosts.includes(url.hostname)) {
    return `Redirect host ${url.hostname} is not allowed. Add it to ALLOWED_REDIRECT_HOSTS to permit this client.`;
  }
  return undefined;
}

export function registerHandler({ config, store }: AuthDeps): RequestHandler {
  return (req, res) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return void oauthError(res, 400, 'invalid_client_metadata', 'redirect_uris must be a non-empty array of URLs');
    }
    const meta = parsed.data;
    if (meta.token_endpoint_auth_method && meta.token_endpoint_auth_method !== 'none') {
      return void oauthError(res, 400, 'invalid_client_metadata', 'Only public clients (token_endpoint_auth_method "none") are supported');
    }
    for (const uri of meta.redirect_uris) {
      const problem = checkRedirectUri(uri, config.allowedRedirectHosts);
      if (problem) return void oauthError(res, 400, 'invalid_redirect_uri', problem);
    }
    const client = store.createClient({ clientName: meta.client_name ?? null, redirectUris: meta.redirect_uris });
    res.status(201).set('Cache-Control', 'no-store').json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      client_name: client.clientName ?? undefined,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  };
}
