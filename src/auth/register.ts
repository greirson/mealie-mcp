import type { RequestHandler } from 'express';
import * as z from 'zod';
import type { AuthDeps } from './index.js';
import { oauthError } from './respond.js';

const bodySchema = z.looseObject({
  redirect_uris: z.array(z.string()).min(1),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Schemes that must always be rejected even when native app / custom-scheme redirects are
// allowed: each can hand a sign-in code to a script, a local file read, or another web origin
// entirely, defeating the point of allowing "software on the user's own machine" schemes.
const DANGEROUS_SCHEMES = new Set([
  'javascript:', 'data:', 'file:', 'vbscript:', 'blob:', 'about:', 'ftp:', 'ws:', 'wss:', 'filesystem:', 'view-source:',
]);

/**
 * The allowlist exists so a malicious DCR registration cannot send a sign-in code to an
 * attacker's web server. A loopback address or a private-use / custom URI scheme instead
 * delivers the code to software running on the user's own machine (RFC 8252), and the consent
 * page shows the destination, so both are allowed by default; https destinations stay
 * allowlisted, and ALLOW_NATIVE_APP_REDIRECTS can switch the native-app allowance off entirely.
 */
export function checkRedirectUri(uri: string, allowedHosts: string[], allowNativeAppRedirects: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `Invalid redirect URI: ${uri}`;
  }
  if (url.hash) return 'Redirect URI must not contain a fragment';

  const isHttp = url.protocol === 'http:';
  const isHttps = url.protocol === 'https:';

  if (!isHttp && !isHttps) {
    if (!allowNativeAppRedirects) return `Redirect URI must use http or https: ${uri}`;
    if (DANGEROUS_SCHEMES.has(url.protocol)) return `Redirect URI scheme ${url.protocol} is not allowed: ${uri}`;
    return undefined;
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (isLoopback && allowNativeAppRedirects) return undefined;

  if (isHttp && !isLoopback) {
    return `Redirect URI must use https (http is allowed only for loopback addresses): ${uri}`;
  }

  // Reached for: https on any host, or http on a loopback host with the kill switch off (the
  // pre-existing behavior, which required the loopback host to be allowlisted too).
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
      const problem = checkRedirectUri(uri, config.allowedRedirectHosts, config.allowNativeAppRedirects);
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
