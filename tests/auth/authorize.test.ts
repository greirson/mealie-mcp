import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { MEALIE, mockMealieSession, mockMealieUser, USER } from '../helpers/mealie.js';
import { mswServer } from '../helpers/msw.js';
import {
  authorizeUrl,
  codeFromSuccessPage,
  exchangeCode,
  openLoginForm,
  pkcePair,
  REDIRECT,
  registerClient,
  submitForm,
  submitLogin,
  unescapeHtml,
} from '../helpers/oauth.js';

let app: TestApp;
beforeEach(async () => { app = await startTestApp(); mockMealieUser(); });
afterEach(async () => { await app.close(); });

async function form(extra: Record<string, string> = {}, clientName?: string) {
  const clientId = await registerClient(app.baseUrl, clientName);
  return openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge, extra));
}

describe('GET /authorize', () => {
  it('renders the login page with hidden fields, a CSRF cookie, and security headers', async () => {
    const f = await form();
    expect(f.status).toBe(200);
    expect(f.html).toContain('Test Client');
    expect(f.html).toContain('claude.ai');
    expect(f.html).toContain('https://mealie.example.com');
    expect(f.fields.redirect_uri).toBe(REDIRECT);
    expect(f.fields.state).toBe('st4te');
    expect(f.fields.csrf).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(f.cookie).toBe(`mealie_mcp_csrf=${f.fields.csrf}`);
    // A browser only returns the CSRF cookie when its Path covers the form's action.
    expect(f.action).toBe('/mcp/oauth/authorize');
    expect(f.headers.get('set-cookie')).toContain('Path=/mcp/oauth/authorize');
    expect(f.headers.get('content-security-policy')).toContain("form-action 'self' https://claude.ai");
    expect(f.headers.get('x-frame-options')).toBe('DENY');
    expect(f.headers.get('cache-control')).toBe('no-store');
  });

  it('escapes the client name', async () => {
    const f = await form({}, '<script>alert(1)</script>');
    expect(f.html).not.toContain('<script>alert(1)</script>');
    expect(f.html).toContain('&lt;script&gt;');
  });

  it('shows an error page (no redirect) for an unknown client', async () => {
    const f = await openLoginForm(authorizeUrl(app.baseUrl, 'nope', pkcePair().challenge));
    expect(f.status).toBe(400);
    expect(f.html).toMatch(/Unknown client/);
  });

  it('shows an error page for a redirect_uri the client did not register', async () => {
    const f = await form({ redirect_uri: 'https://claude.ai/other' });
    expect(f.status).toBe(400);
    expect(f.html).toMatch(/redirect URI does not match/);
  });

  it('redirects with invalid_request when PKCE is missing or not S256', async () => {
    const clientId = await registerClient(app.baseUrl);
    for (const extra of [{ code_challenge: '' }, { code_challenge_method: 'plain' }]) {
      const res = await fetch(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge, extra), { redirect: 'manual' });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location')!);
      expect(location.origin + location.pathname).toBe(REDIRECT);
      expect(location.searchParams.get('error')).toBe('invalid_request');
      expect(location.searchParams.get('state')).toBe('st4te');
      // RFC 9207: every error redirect carries iss, exactly matching the AS metadata issuer.
      expect(location.searchParams.get('iss')).toBe(`${app.baseUrl}/`);
    }
  });

  it('redirects with unsupported_response_type and iss when response_type is not "code"', async () => {
    const clientId = await registerClient(app.baseUrl);
    const res = await fetch(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge, { response_type: 'token' }), { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('unsupported_response_type');
    expect(location.searchParams.get('iss')).toBe(`${app.baseUrl}/`);
  });
});

describe('POST /authorize', () => {
  it('validates the token with Mealie and returns a success page with a code', async () => {
    const f = await form();
    const res = await submitLogin(app.baseUrl, f, 'good-token');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sam Cook (Home)');
    const { code, state, iss } = codeFromSuccessPage(html);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(state).toBe('st4te');
    // RFC 9207: the success redirect carries iss, exactly matching the AS metadata issuer.
    expect(iss).toBe(`${app.baseUrl}/`);
  });

  it('trims pasted token whitespace', async () => {
    const res = await submitLogin(app.baseUrl, await form(), '  good-token\n');
    expect(res.status).toBe(200);
  });

  it('re-renders the form when Mealie rejects the token', async () => {
    const res = await submitLogin(app.baseUrl, await form(), 'wrong-token');
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/Mealie did not accept that API token/);
    expect(html).not.toContain('id="continue"');
  });

  it('asks for a token when the field is empty', async () => {
    const res = await submitLogin(app.baseUrl, await form(), '   ');
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Paste your Mealie API token/);
  });

  it('returns 502 when Mealie is unreachable', async () => {
    mswServer.use(http.get(`${MEALIE}/api/users/self`, () => HttpResponse.error()));
    const res = await submitLogin(app.baseUrl, await form(), 'good-token');
    expect(res.status).toBe(502);
    expect(await res.text()).toMatch(/Could not reach Mealie/);
  });

  it('rejects a submission without the CSRF cookie', async () => {
    const f = await form();
    const res = await submitLogin(app.baseUrl, { ...f, cookie: '' }, 'good-token');
    expect(res.status).toBe(403);
  });

  it('rate limits repeated submissions', async () => {
    await app.close();
    app = await startTestApp({ authRateLimitPerMinute: 2 });
    const f = await form();
    expect((await submitLogin(app.baseUrl, f, 'wrong-token')).status).toBe(400);
    expect((await submitLogin(app.baseUrl, f, 'wrong-token')).status).toBe(400);
    expect((await submitLogin(app.baseUrl, f, 'wrong-token')).status).toBe(429);
  });
});

describe('GET /authorize (sign in with Mealie session)', () => {
  it('shows the session page with a login=session form and the token fallback when the session cookie is valid', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    mockMealieSession('jwt-good', 'minted-token');
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge), 'mealie.access_token=jwt-good');
    expect(f.status).toBe(200);
    expect(f.html).toContain('Sam Cook (Home)');
    expect(f.fields.login).toBe('session');
    expect(f.html).toContain('Use a Mealie API token instead');
    expect(f.html).toContain('name="mealie_token"');
  });

  it('shows the signed-out page with a sign-in link and a Continue link built only from validated params', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    const clientId = await registerClient(app.baseUrl);
    const url = authorizeUrl(app.baseUrl, clientId, pkcePair().challenge, { evil: '<script>alert(1)</script>' });
    const f = await openLoginForm(url);
    expect(f.status).toBe(200);
    expect(f.html).not.toContain('Signed in to Mealie as');
    expect(f.html).toContain(`href="${app.config.mealiePublicUrl}/login"`);
    expect(f.html).toContain('target="_blank"');
    expect(f.html).toContain('Use a Mealie API token instead');

    const continueHref = f.html.match(/href="([^"]*\/mcp\/oauth\/authorize\?[^"]*)"/)?.[1];
    expect(continueHref).toBeTruthy();
    const continueParsed = new URL(unescapeHtml(continueHref!), app.baseUrl);
    expect(continueParsed.searchParams.get('client_id')).toBe(clientId);
    expect(continueParsed.searchParams.get('response_type')).toBe('code');
    expect(continueParsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(continueParsed.searchParams.get('evil')).toBeNull();
    expect(f.html).not.toContain('evil');
    expect(f.html).not.toContain('<script>alert(1)</script>');
  });

  it('shows the signed-out page when the Mealie session cookie is no longer valid', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    mswServer.use(http.get(`${MEALIE}/api/users/self`, () => HttpResponse.json({ detail: 'Unauthorized' }, { status: 401 })));
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge), 'mealie.access_token=expired-jwt');
    expect(f.status).toBe(200);
    expect(f.html).not.toContain('Signed in to Mealie as');
    expect(f.html).toContain(`${app.config.mealiePublicUrl}/login`);
  });

  it('shows the plain token-paste page when session login is not available for this deployment', async () => {
    const f = await form();
    expect(f.html).not.toContain('Sign in to Mealie');
    expect(f.html).not.toContain('Use a Mealie API token instead');
    expect(f.html).toContain('Mealie API token');
  });
});

describe('POST /authorize (sign in with Mealie session)', () => {
  it('mints a dedicated Mealie API token from the session and stores it instead of the jwt', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    const jwt = 'jwt-good';
    const mintedToken = 'minted-token-xyz';
    const mintRequests = mockMealieSession(jwt, mintedToken);
    const clientId = await registerClient(app.baseUrl, 'My Client');
    const { verifier, challenge } = pkcePair();
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, challenge), `mealie.access_token=${jwt}`);
    expect(f.fields.login).toBe('session');

    const res = await submitForm(app.baseUrl, f);
    expect(res.status).toBe(200);
    expect(mintRequests).toHaveLength(1);
    expect(mintRequests[0]!.authorization).toBe(`Bearer ${jwt}`);
    const today = new Date().toISOString().slice(0, 10);
    expect(mintRequests[0]!.name).toBe(`MCP: My Client ${today}`);

    const html = await res.text();
    expect(html).toContain('Sam Cook (Home)');
    const { code } = codeFromSuccessPage(html);
    const tokenRes = await exchangeCode(app.baseUrl, clientId, code, verifier);
    expect(tokenRes.status).toBe(200);
    const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };

    // The completed connection must act as the MINTED token, never the jwt.
    let sawAuth: string | null = null;
    mswServer.use(
      http.get(`${MEALIE}/api/users/self`, ({ request }) => {
        sawAuth = request.headers.get('authorization');
        return HttpResponse.json(USER);
      }),
      http.get(`${MEALIE}/api/households/self`, () => HttpResponse.json({ id: 'h-1', name: 'Home', slug: 'home' }))
    );
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('/mcp', app.baseUrl), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } })
    );
    await client.callTool({ name: 'mealie_whoami', arguments: {} });
    await client.close();
    expect(sawAuth).toBe(`Bearer ${mintedToken}`);
  });

  it('re-renders the signed-out page when there is no Mealie session cookie', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge));
    const res = await submitForm(app.baseUrl, f, { login: 'session' });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Your Mealie sign-in was not found or has expired/);
  });

  it('re-renders the signed-out page when the Mealie session cookie has expired', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge), 'mealie.access_token=expired-jwt');
    mswServer.use(http.get(`${MEALIE}/api/users/self`, () => HttpResponse.json({ detail: 'Unauthorized' }, { status: 401 })));
    const res = await submitForm(app.baseUrl, f, { login: 'session' });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Your Mealie sign-in was not found or has expired/);
  });

  it('rejects a session submission without the CSRF cookie', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    mockMealieSession('jwt-good', 'minted-token');
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge), 'mealie.access_token=jwt-good');
    const res = await submitForm(app.baseUrl, { ...f, cookie: '' }, { login: 'session' });
    expect(res.status).toBe(403);
  });

  it('fails with a 502 page, creates no session, and deletes the orphaned token when the minted token verifies as a different user', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    const jwt = 'jwt-good';
    const mintedToken = 'minted-token-xyz';
    const deleteRequests: { authorization: string | null; tokenId: string }[] = [];
    mswServer.use(
      http.get(`${MEALIE}/api/users/self`, ({ request }) => {
        const auth = request.headers.get('authorization');
        if (auth === `Bearer ${jwt}`) return HttpResponse.json(USER);
        if (auth === `Bearer ${mintedToken}`) return HttpResponse.json({ ...USER, id: 'someone-else' });
        return HttpResponse.json({ detail: 'Unauthorized' }, { status: 401 });
      }),
      http.post(`${MEALIE}/api/users/api-tokens`, async ({ request }) => {
        const body = (await request.json()) as { name: string };
        return HttpResponse.json({ id: 42, name: body.name, token: mintedToken }, { status: 201 });
      }),
      http.delete(`${MEALIE}/api/users/api-tokens/:tokenId`, ({ request, params }) => {
        deleteRequests.push({ authorization: request.headers.get('authorization'), tokenId: params.tokenId as string });
        return HttpResponse.json({ tokenId: '42' });
      })
    );
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge), `mealie.access_token=${jwt}`);
    const res = await submitForm(app.baseUrl, f);
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).not.toContain('id="continue"');
    expect(deleteRequests).toHaveLength(1);
    expect(deleteRequests[0]!.authorization).toBe(`Bearer ${jwt}`);
    expect(deleteRequests[0]!.tokenId).toBe('42');
  });

  it('deletes the orphaned token and shows a 502 page when verifying the minted token errors', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    const jwt = 'jwt-good';
    const mintedToken = 'minted-token-xyz';
    const deleteRequests: { authorization: string | null; tokenId: string }[] = [];
    mswServer.use(
      http.get(`${MEALIE}/api/users/self`, ({ request }) => {
        const auth = request.headers.get('authorization');
        if (auth === `Bearer ${jwt}`) return HttpResponse.json(USER);
        if (auth === `Bearer ${mintedToken}`) return HttpResponse.error();
        return HttpResponse.json({ detail: 'Unauthorized' }, { status: 401 });
      }),
      http.post(`${MEALIE}/api/users/api-tokens`, async ({ request }) => {
        const body = (await request.json()) as { name: string };
        return HttpResponse.json({ id: 7, name: body.name, token: mintedToken }, { status: 201 });
      }),
      http.delete(`${MEALIE}/api/users/api-tokens/:tokenId`, ({ request, params }) => {
        deleteRequests.push({ authorization: request.headers.get('authorization'), tokenId: params.tokenId as string });
        return HttpResponse.json({ tokenId: '7' });
      })
    );
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge), `mealie.access_token=${jwt}`);
    const res = await submitForm(app.baseUrl, f);
    expect(res.status).toBe(502);
    expect(deleteRequests).toHaveLength(1);
    expect(deleteRequests[0]!.authorization).toBe(`Bearer ${jwt}`);
    expect(deleteRequests[0]!.tokenId).toBe('7');
  });

  it('still supports the token-paste path when session login is available', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge));
    const res = await submitLogin(app.baseUrl, f, 'good-token');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sam Cook (Home)');
  });

  it('re-renders the signed-out page (not the legacy page) when a pasted token is rejected and session login is available', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge));
    const res = await submitLogin(app.baseUrl, f, 'wrong-token');
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/Mealie did not accept that API token/);
    expect(html).toContain('Sign in to Mealie');
    expect(html).toContain('Use a Mealie API token instead');
  });
});

describe('POST /authorize (cross-origin protection)', () => {
  it('rejects a POST whose Origin header is a different (e.g. sibling) origin, minting nothing', async () => {
    const mintRequests = mockMealieSession('jwt-good', 'minted-token');
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge), 'mealie.access_token=jwt-good');
    const res = await submitForm(app.baseUrl, f, {}, { origin: 'http://attacker.example.com' });
    expect(res.status).toBe(403);
    expect(mintRequests).toHaveLength(0);
  });

  it('rejects a POST with Origin: null', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge));
    const res = await submitForm(app.baseUrl, f, { login: 'session' }, { origin: 'null' });
    expect(res.status).toBe(403);
  });

  it('rejects a POST with Sec-Fetch-Site: same-site', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge));
    const res = await submitForm(app.baseUrl, f, { login: 'session' }, { 'sec-fetch-site': 'same-site' });
    expect(res.status).toBe(403);
  });

  it('allows a POST whose Origin header matches this server', async () => {
    const res = await submitForm(app.baseUrl, await form(), { mealie_token: 'good-token' }, { origin: app.baseUrl });
    expect(res.status).toBe(200);
  });

  it('allows a POST with Sec-Fetch-Site: same-origin', async () => {
    const res = await submitForm(app.baseUrl, await form(), { mealie_token: 'good-token' }, { 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBe(200);
  });

  // What a real browser sent in production: a same-origin form POST from a page whose
  // Referrer-Policy forced Origin to "null". Sec-Fetch-Site is browser-set and cannot be forged by a page.
  it('allows Origin: null when Sec-Fetch-Site says same-origin', async () => {
    const res = await submitForm(app.baseUrl, await form(), { mealie_token: 'good-token' }, { origin: 'null', 'sec-fetch-site': 'same-origin' });
    expect(res.status).toBe(200);
  });

  it('rejects a matching Origin when Sec-Fetch-Site says cross-site', async () => {
    const res = await submitForm(app.baseUrl, await form(), { mealie_token: 'good-token' }, { origin: app.baseUrl, 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
  });

  it('uses a referrer policy that lets browsers send a real Origin on same-origin form posts', async () => {
    const f = await form();
    expect(f.headers.get('referrer-policy')).toBe('same-origin');
  });
});

describe('GET/POST /authorize (consent phishing hardening)', () => {
  it('shows who is asking and where the code goes on the session page, with a trust warning', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    mockMealieSession('jwt-good', 'minted-token');
    const clientId = await registerClient(app.baseUrl, 'My Client');
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge), 'mealie.access_token=jwt-good');
    expect(f.html).toContain('My Client');
    expect(f.html).toContain(`returning to <strong>${new URL(REDIRECT).host}</strong>`);
    expect(f.html).toContain('Only click Allow if you just started connecting from an app you trust.');
  });

  it('shows the redirect host and path for a localhost redirect_uri', async () => {
    await app.close();
    app = await startTestApp({ allowedRedirectHosts: ['localhost'] }, undefined, { sessionLogin: true });
    mockMealieSession('jwt-good', 'minted-token');
    const localRedirect = 'http://localhost:9999/callback';
    const res = await fetch(`${app.baseUrl}/mcp/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Local App', redirect_uris: [localRedirect], token_endpoint_auth_method: 'none' }),
    });
    const { client_id: clientId } = (await res.json()) as { client_id: string };
    const url = new URL('/mcp/oauth/authorize', app.baseUrl);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: localRedirect,
      response_type: 'code',
      code_challenge: pkcePair().challenge,
      code_challenge_method: 'S256',
      state: 'st4te',
    }).toString();
    const f = await openLoginForm(url.href, 'mealie.access_token=jwt-good');
    expect(f.html).toContain('returning to <strong>localhost:9999/callback</strong>');
  });
});

describe('GET/POST /authorize (RFC 9207 issuer identification)', () => {
  async function metadataIssuer(): Promise<string> {
    const res = await fetch(`${app.baseUrl}/.well-known/oauth-authorization-server`);
    return ((await res.json()) as { issuer: string }).issuer;
  }

  it('carries iss on the success redirect, exactly matching the AS metadata issuer', async () => {
    const issuer = await metadataIssuer();
    const res = await submitLogin(app.baseUrl, await form(), 'good-token');
    const { iss } = codeFromSuccessPage(await res.text());
    expect(iss).toBe(issuer);
  });

  it('carries iss on an error redirect, exactly matching the AS metadata issuer', async () => {
    const issuer = await metadataIssuer();
    const clientId = await registerClient(app.baseUrl);
    const res = await fetch(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge, { code_challenge: '' }), { redirect: 'manual' });
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('iss')).toBe(issuer);
  });
});

describe('GET /authorize (rate limiting)', () => {
  it('rate limits repeated GETs', async () => {
    await app.close();
    app = await startTestApp({ authRateLimitPerMinute: 2 });
    const clientId = await registerClient(app.baseUrl);
    const url = authorizeUrl(app.baseUrl, clientId, pkcePair().challenge);
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(200);
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(200);
    expect((await fetch(url, { redirect: 'manual' })).status).toBe(429);
  });
});

describe('GET/POST /authorize (duplicate Mealie session cookie)', () => {
  it('treats a duplicated Mealie session cookie as signed out on GET', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    mockMealieSession('jwt-good', 'minted-token');
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(
      authorizeUrl(app.baseUrl, clientId, pkcePair().challenge),
      'mealie.access_token=jwt-good; mealie.access_token=jwt-good'
    );
    expect(f.status).toBe(200);
    expect(f.html).not.toContain('Signed in to Mealie as');
    expect(f.html).toContain('Sign in to Mealie');
  });

  it('rejects a session POST with the signed-out error when the Mealie session cookie is duplicated', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    const mintRequests = mockMealieSession('jwt-good', 'minted-token');
    const clientId = await registerClient(app.baseUrl);
    const f = await openLoginForm(
      authorizeUrl(app.baseUrl, clientId, pkcePair().challenge),
      'mealie.access_token=jwt-good; mealie.access_token=jwt-good'
    );
    const res = await submitForm(app.baseUrl, f, { login: 'session' });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Your Mealie sign-in was not found or has expired/);
    expect(mintRequests).toHaveLength(0);
  });
});

describe('GET/POST /authorize (hostile client name sanitization)', () => {
  const HOSTILE_NAME = 'Trusted‮exe.cod';

  it('strips Unicode format characters (e.g. a bidi override) from the client name in the page', async () => {
    const f = await form({}, HOSTILE_NAME);
    expect(f.html).not.toContain('‮');
  });

  it('strips Unicode format characters from the minted token name', async () => {
    await app.close();
    app = await startTestApp({}, undefined, { sessionLogin: true });
    const mintRequests = mockMealieSession('jwt-good', 'minted-token');
    const clientId = await registerClient(app.baseUrl, HOSTILE_NAME);
    const f = await openLoginForm(authorizeUrl(app.baseUrl, clientId, pkcePair().challenge), 'mealie.access_token=jwt-good');
    const res = await submitForm(app.baseUrl, f);
    expect(res.status).toBe(200);
    expect(mintRequests).toHaveLength(1);
    expect(mintRequests[0]!.name).not.toContain('‮');
    expect(mintRequests[0]!.name.startsWith('MCP: Trustedexe.cod')).toBe(true);
  });
});
