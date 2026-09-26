import type { Response } from 'express';
import type { AuthorizeParams } from './params.js';
import { OAUTH_PATHS } from './paths.js';

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function setPageSecurityHeaders(res: Response, formActionOrigin?: string): void {
  const formAction = formActionOrigin ? `'self' ${formActionOrigin}` : `'self'`;
  res.set({
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    'X-Frame-Options': 'DENY',
    // same-origin, not no-referrer: no-referrer makes browsers send Origin: null on the form POST.
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
}

const STYLE = `
  body { font: 16px/1.5 system-ui, sans-serif; background: #f6f6f4; color: #1d1d1b; margin: 0; }
  main { max-width: 28rem; margin: 10vh auto; padding: 2rem; background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  label { display: block; font-weight: 600; margin: 1rem 0 .25rem; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: .6rem; font: inherit; border: 1px solid #bbb; border-radius: 8px; }
  button, a.button { display: inline-block; margin-top: 1rem; padding: .6rem 1.2rem; font: inherit; background: #e58325; color: #fff; border: 0; border-radius: 8px; text-decoration: none; cursor: pointer; }
  .error { background: #fdecea; color: #8a1c12; padding: .6rem .8rem; border-radius: 8px; }
  .muted { color: #666; font-size: .9rem; }
`;

function shell(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${head}<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function hidden(name: string, value: string | undefined): string {
  return value === undefined ? '' : `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * A display-safe client name: strips control characters and Unicode format characters (bidi
 * overrides, zero-width joins, ...) that a hostile client_name could use to spoof the page.
 */
function sanitizeClientName(clientName: string | null): string {
  const cleaned = (clientName ?? '').replace(/[\p{Cf}\x00-\x1f\x7f]/gu, '').trim();
  return cleaned || 'An MCP client';
}

/** Where the OAuth code will be sent: host only, or host and path for localhost so it is not just "localhost". */
function redirectDisplay(redirectUri: string): string {
  const url = new URL(redirectUri);
  return LOCAL_HOSTS.has(url.hostname) ? `${url.host}${url.pathname}` : url.host;
}

function hiddenFields(params: AuthorizeParams): string {
  return [
    hidden('client_id', params.clientId),
    hidden('redirect_uri', params.redirectUri),
    hidden('response_type', 'code'),
    hidden('code_challenge', params.codeChallenge),
    hidden('code_challenge_method', 'S256'),
    hidden('state', params.state),
    hidden('scope', params.scope),
    hidden('resource', params.resource),
  ].join('\n      ');
}

function tokenPasteForm(params: AuthorizeParams, csrf: string, tokenPage: string): string {
  return `
      <form method="post" action="${OAUTH_PATHS.authorize}">
        ${hiddenFields(params)}
        ${hidden('csrf', csrf)}
        <label for="mealie_token">Mealie API token</label>
        <input type="password" id="mealie_token" name="mealie_token" autocomplete="off" required>
        <p class="muted">Create one in Mealie under <a href="${escapeHtml(tokenPage)}" target="_blank" rel="noopener">Profile, API Tokens</a>. Deleting that token later disconnects this client.</p>
        <button type="submit">Connect</button>
      </form>`;
}

export function renderLoginPage(input: { params: AuthorizeParams; csrf: string; mealiePublicUrl: string; error?: string }): string {
  const { params } = input;
  const host = new URL(params.redirectUri).host;
  const clientName = sanitizeClientName(params.clientName);
  const tokenPage = `${input.mealiePublicUrl}/user/profile/api-tokens`;
  const body = `
    <h1>Connect ${escapeHtml(clientName)} to Mealie</h1>
    <p><strong>${escapeHtml(clientName)}</strong> (returning to <strong>${escapeHtml(host)}</strong>) wants to act on Mealie as you.</p>
    ${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ''}
    <form method="post" action="${OAUTH_PATHS.authorize}">
      ${hidden('client_id', params.clientId)}
      ${hidden('redirect_uri', params.redirectUri)}
      ${hidden('response_type', 'code')}
      ${hidden('code_challenge', params.codeChallenge)}
      ${hidden('code_challenge_method', 'S256')}
      ${hidden('state', params.state)}
      ${hidden('scope', params.scope)}
      ${hidden('resource', params.resource)}
      ${hidden('csrf', input.csrf)}
      <label for="mealie_token">Mealie API token</label>
      <input type="password" id="mealie_token" name="mealie_token" autocomplete="off" required autofocus>
      <p class="muted">Create one in Mealie under <a href="${escapeHtml(tokenPage)}" target="_blank" rel="noopener">Profile, API Tokens</a>. Deleting that token later disconnects this client.</p>
      <button type="submit">Connect</button>
    </form>`;
  return shell('Connect to Mealie', body);
}

export interface MealieSessionUser {
  username: string;
  fullName?: string | null;
  household?: string | null;
}

/** Shown when a valid Mealie session cookie was found: the user can just click Allow. */
export function renderSessionPage(input: {
  params: AuthorizeParams;
  csrf: string;
  mealiePublicUrl: string;
  user: MealieSessionUser;
}): string {
  const { params, user } = input;
  const clientName = sanitizeClientName(params.clientName);
  const redirectHost = redirectDisplay(params.redirectUri);
  const displayName = user.fullName || user.username;
  const who = user.household ? `${displayName} (${user.household})` : displayName;
  const tokenPage = `${input.mealiePublicUrl}/user/profile/api-tokens`;
  const body = `
    <h1>Connect ${escapeHtml(clientName)} to Mealie</h1>
    <p><strong>${escapeHtml(clientName)}</strong> (returning to <strong>${escapeHtml(redirectHost)}</strong>) wants to act on Mealie as you.</p>
    <p>Signed in to Mealie as <strong>${escapeHtml(who)}</strong>.</p>
    <p class="muted">Only click Allow if you just started connecting from an app you trust.</p>
    <form method="post" action="${OAUTH_PATHS.authorize}">
      ${hiddenFields(params)}
      ${hidden('csrf', input.csrf)}
      ${hidden('login', 'session')}
      <button type="submit">Allow</button>
    </form>
    <details>
      <summary>Use a Mealie API token instead</summary>
      ${tokenPasteForm(params, input.csrf, tokenPage)}
    </details>`;
  return shell('Connect to Mealie', body);
}

/** Shown when session login is available but no valid Mealie session cookie was found. */
export function renderSignedOutPage(input: {
  params: AuthorizeParams;
  csrf: string;
  mealiePublicUrl: string;
  continueUrl: string;
  error?: string;
}): string {
  const { params } = input;
  const clientName = sanitizeClientName(params.clientName);
  const loginUrl = `${input.mealiePublicUrl}/login`;
  const tokenPage = `${input.mealiePublicUrl}/user/profile/api-tokens`;
  const body = `
    <h1>Connect ${escapeHtml(clientName)} to Mealie</h1>
    <p>You are not signed in to Mealie in this browser.</p>
    ${input.error ? `<p class="error">${escapeHtml(input.error)}</p>` : ''}
    <p><a class="button" href="${escapeHtml(loginUrl)}" target="_blank" rel="noopener">Sign in to Mealie</a></p>
    <p class="muted">Sign in to Mealie in the tab that opens, then come back to this tab and press Continue.</p>
    <p><a class="button" href="${escapeHtml(input.continueUrl)}">Continue</a></p>
    <details>
      <summary>Use a Mealie API token instead</summary>
      ${tokenPasteForm(params, input.csrf, tokenPage)}
    </details>`;
  return shell('Connect to Mealie', body);
}

export function renderSuccessPage(input: { displayName: string; household?: string; redirectUrl: string }): string {
  const who = input.household ? `${input.displayName} (${input.household})` : input.displayName;
  const url = escapeHtml(input.redirectUrl);
  const body = `
    <h1>Connected</h1>
    <p>Signed in to Mealie as <strong>${escapeHtml(who)}</strong>.</p>
    <p class="muted">Returning you to the app. If nothing happens, use the button.</p>
    <a id="continue" href="${url}" class="button">Continue</a>`;
  return shell('Connected to Mealie', body, `<meta http-equiv="refresh" content="1;url=${url}">`);
}

export function renderErrorPage(message: string): string {
  return shell('Mealie connection error', `<h1>Cannot connect</h1><p class="error">${escapeHtml(message)}</p>`);
}
