import { createHash, randomBytes } from 'node:crypto';

export const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export async function registerClient(baseUrl: string, clientName = 'Test Client'): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { client_id: string }).client_id;
}

export function authorizeUrl(baseUrl: string, clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  const url = new URL('/mcp/oauth/authorize', baseUrl);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st4te',
    ...extra,
  }).toString();
  return url.href;
}

export interface LoginForm { status: number; html: string; cookie: string; action: string; fields: Record<string, string>; headers: Headers }

export async function openLoginForm(url: string, mealieSessionCookie?: string): Promise<LoginForm> {
  const res = await fetch(url, {
    redirect: 'manual',
    headers: mealieSessionCookie ? { cookie: mealieSessionCookie } : {},
  });
  const html = await res.text();
  const csrfCookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  // Combine the fresh CSRF cookie with any Mealie session cookie the caller simulated, so a
  // subsequent submitForm call sends both, the way a real browser would.
  const cookie = [csrfCookie, mealieSessionCookie].filter(Boolean).join('; ');
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[m[1]!] = unescapeHtml(m[2]!);
  const action = unescapeHtml(html.match(/<form method="post" action="([^"]+)"/)?.[1] ?? '');
  return { status: res.status, html, cookie, action, fields, headers: res.headers };
}

export async function submitForm(
  baseUrl: string,
  form: LoginForm,
  fields: Record<string, string> = {},
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  // Post to the form's own action so a wrong action attribute in the page fails the tests.
  return fetch(new URL(form.action || '/mcp/oauth/authorize', baseUrl), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: form.cookie, ...extraHeaders },
    body: new URLSearchParams({ ...form.fields, ...fields }).toString(),
  });
}

export async function submitLogin(baseUrl: string, form: LoginForm, mealieToken: string): Promise<Response> {
  return submitForm(baseUrl, form, { mealie_token: mealieToken });
}

export function codeFromSuccessPage(html: string): { code: string; state: string | null; iss: string | null } {
  const match = html.match(/<a id="continue" href="([^"]+)"/);
  if (!match) throw new Error(`no continue link in page:\n${html}`);
  const url = new URL(unescapeHtml(match[1]!));
  return { code: url.searchParams.get('code')!, state: url.searchParams.get('state'), iss: url.searchParams.get('iss') };
}

export function unescapeHtml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export async function exchangeCode(baseUrl: string, clientId: string, code: string, verifier: string, redirectUri = REDIRECT): Promise<Response> {
  return fetch(`${baseUrl}/mcp/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri }).toString(),
  });
}

export async function refreshTokens(baseUrl: string, clientId: string, refreshToken: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken }).toString(),
  });
}

export async function fullLogin(baseUrl: string, mealieToken: string): Promise<{ clientId: string; accessToken: string; refreshToken: string }> {
  const clientId = await registerClient(baseUrl);
  const { verifier, challenge } = pkcePair();
  const form = await openLoginForm(authorizeUrl(baseUrl, clientId, challenge));
  const page = await submitLogin(baseUrl, form, mealieToken);
  if (page.status !== 200) throw new Error(`login failed: ${page.status}`);
  const { code } = codeFromSuccessPage(await page.text());
  const res = await exchangeCode(baseUrl, clientId, code, verifier);
  if (res.status !== 200) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; refresh_token: string };
  return { clientId, accessToken: body.access_token, refreshToken: body.refresh_token };
}
