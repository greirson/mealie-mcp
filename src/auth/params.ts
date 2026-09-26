import type { Store } from '../store/repo.js';

export interface AuthorizeParams {
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope?: string;
  resource?: string;
}

export type AuthorizeValidation =
  | { ok: true; params: AuthorizeParams }
  | { ok: false; kind: 'page'; message: string }
  | { ok: false; kind: 'redirect'; redirectUri: string; error: string; description: string; state?: string };

export function validateAuthorizeParams(store: Store, source: Record<string, unknown>): AuthorizeValidation {
  const str = (key: string): string | undefined => {
    const v = source[key];
    return typeof v === 'string' && v !== '' ? v : undefined;
  };
  const page = (message: string): AuthorizeValidation => ({ ok: false, kind: 'page', message });

  const clientId = str('client_id');
  if (!clientId) return page('Missing client_id.');
  const client = store.getClient(clientId);
  if (!client) return page('Unknown client. Remove and re-add the connector in Claude.');

  const requested = str('redirect_uri');
  const redirectUri = requested ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  // Never redirect to an unverified URI: errors before this point render a page instead.
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return page('The redirect URI does not match this client registration.');
  }

  const state = str('state');
  const fail = (error: string, description: string): AuthorizeValidation => ({ ok: false, kind: 'redirect', redirectUri, error, description, state });
  if (str('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be "code"');
  const codeChallenge = str('code_challenge');
  if (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) return fail('invalid_request', 'code_challenge is required (S256)');
  if (str('code_challenge_method') !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');

  return {
    ok: true,
    params: { clientId, clientName: client.clientName, redirectUri, codeChallenge, state, scope: str('scope'), resource: str('resource') },
  };
}

export function errorRedirectUrl(v: Extract<AuthorizeValidation, { kind: 'redirect' }>): string {
  const url = new URL(v.redirectUri);
  url.searchParams.set('error', v.error);
  url.searchParams.set('error_description', v.description);
  if (v.state) url.searchParams.set('state', v.state);
  return url.href;
}
