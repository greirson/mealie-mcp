import type { Request, RequestHandler, Response } from 'express';
import { MealieClient } from '../mealie/client.js';
import { MealieError } from '../mealie/errors.js';
import { encrypt, hashToken, randomToken, safeEqual } from '../store/crypto.js';
import type { AuthDeps } from './index.js';
import { authServerIssuer } from './metadata.js';
import {
  renderErrorPage,
  renderLoginPage,
  renderSessionPage,
  renderSignedOutPage,
  renderSuccessPage,
  setPageSecurityHeaders,
} from './pages.js';
import { errorRedirectUrl, validateAuthorizeParams, type AuthorizeParams, type AuthorizeValidation } from './params.js';
import { OAUTH_PATHS } from './paths.js';

export const CSRF_COOKIE = 'mealie_mcp_csrf';
/** Mealie v3.27.0's own login cookie: Path=/, SameSite=Lax, not HttpOnly, holding a Mealie JWT. */
const MEALIE_SESSION_COOKIE = 'mealie.access_token';
const CODE_TTL_MS = 60_000;
const SESSION_NOT_FOUND_MESSAGE = 'Your Mealie sign-in was not found or has expired. Sign in to Mealie, then press Continue.';

interface MealieUser { id: string; username: string; fullName?: string | null; household?: string | null }

/** Handles the two failure shapes; returns params only when valid. */
function handleInvalid(res: Response, v: AuthorizeValidation, deps: AuthDeps): v is Extract<AuthorizeValidation, { ok: true }> {
  if (v.ok) return true;
  if (v.kind === 'page') {
    setPageSecurityHeaders(res);
    res.status(400).type('html').send(renderErrorPage(v.message));
  } else {
    res.redirect(302, errorRedirectUrl(v, authServerIssuer(deps.config)));
  }
  return false;
}

/** Builds the "Continue" link from validated params only, never by reflecting the raw query string. */
function continueUrl(params: AuthorizeParams): string {
  const qs = new URLSearchParams();
  qs.set('client_id', params.clientId);
  qs.set('redirect_uri', params.redirectUri);
  qs.set('response_type', 'code');
  qs.set('code_challenge', params.codeChallenge);
  qs.set('code_challenge_method', 'S256');
  if (params.state) qs.set('state', params.state);
  if (params.scope) qs.set('scope', params.scope);
  if (params.resource) qs.set('resource', params.resource);
  return `${OAUTH_PATHS.authorize}?${qs.toString()}`;
}

/**
 * Rejects cross-origin POSTs before anything else runs. SameSite=Lax cookies do not stop a
 * sibling subdomain (same-site, different origin) from planting the CSRF cookie and auto-posting
 * here, so the CSRF token match alone is not enough; this checks the browser-supplied origin too.
 */
function isSameOriginRequest(req: Request, deps: AuthDeps): boolean {
  // Sec-Fetch-Site is set by the browser and cannot be changed by a page, so it decides when present.
  // Origin alone is not enough: under a no-referrer policy a genuine same-origin POST sends "null".
  const secFetchSite = req.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string') return secFetchSite === 'same-origin';
  const origin = req.headers.origin;
  if (typeof origin === 'string') return origin === deps.config.publicUrl.origin;
  // Neither header present: a non-browser client (or this test harness). Nothing to check against.
  return true;
}

/** Returns the single value of a cookie, or undefined if it is missing or duplicated. */
function singleCookieValue(header: string | undefined, name: string): string | undefined {
  const values: string[] = [];
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) values.push(rest.join('='));
  }
  return values.length === 1 ? values[0] : undefined;
}

/** Checks whether `jwt` is a live Mealie session, returning the user or undefined if signed out. */
async function checkMealieSession(deps: AuthDeps, jwt: string): Promise<MealieUser | undefined> {
  try {
    return await new MealieClient({ baseUrl: deps.config.mealieUrl, token: jwt }).get<MealieUser>('/api/users/self');
  } catch (err) {
    if (err instanceof MealieError && err.kind === 'http' && (err.status === 401 || err.status === 403)) return undefined;
    deps.logger.warn({ reason: err instanceof Error ? err.message : String(err) }, 'mealie session check failed');
    return undefined;
  }
}

export function authorizeGetHandler(deps: AuthDeps): RequestHandler {
  return async (req, res) => {
    const v = validateAuthorizeParams(deps.store, req.query as Record<string, unknown>);
    if (!handleInvalid(res, v, deps)) return;
    const { params } = v;
    const csrf = randomToken(16);
    res.cookie(CSRF_COOKIE, csrf, {
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.config.publicUrl.protocol === 'https:',
      path: OAUTH_PATHS.authorize,
      maxAge: 15 * 60_000,
    });
    setPageSecurityHeaders(res, new URL(params.redirectUri).origin);

    if (!deps.config.mealieSessionLogin) {
      res.status(200).type('html').send(renderLoginPage({ params, csrf, mealiePublicUrl: deps.config.mealiePublicUrl }));
      return;
    }

    const sessionJwt = singleCookieValue(req.headers.cookie, MEALIE_SESSION_COOKIE);
    const user = sessionJwt ? await checkMealieSession(deps, sessionJwt) : undefined;
    if (user) {
      res.status(200).type('html').send(renderSessionPage({ params, csrf, mealiePublicUrl: deps.config.mealiePublicUrl, user }));
    } else {
      res
        .status(200)
        .type('html')
        .send(renderSignedOutPage({ params, csrf, mealiePublicUrl: deps.config.mealiePublicUrl, continueUrl: continueUrl(params) }));
    }
  };
}

/** Completes the login for either path: mints the OAuth session and shows the success page. */
function finalizeLogin(deps: AuthDeps, res: Response, params: AuthorizeParams, user: MealieUser, tokenForSession: string): void {
  const session = deps.store.createSession({
    mealieUserId: user.id,
    mealieUsername: user.username,
    mealieTokenEnc: encrypt(deps.config.encryptionKey, tokenForSession),
    clientId: params.clientId,
  });
  const code = randomToken();
  deps.store.createAuthCode(hashToken(code), {
    sessionId: session.sessionId,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    codeChallenge: params.codeChallenge,
    expiresAt: Date.now() + CODE_TTL_MS,
  });

  const redirect = new URL(params.redirectUri);
  redirect.searchParams.set('code', code);
  if (params.state) redirect.searchParams.set('state', params.state);
  // RFC 9207: every authorization response carries iss, exactly matching the AS metadata issuer.
  redirect.searchParams.set('iss', authServerIssuer(deps.config));

  res.clearCookie(CSRF_COOKIE, { path: OAUTH_PATHS.authorize });
  deps.logger.info({ mealieUser: user.username, clientId: params.clientId }, 'connector authorized');
  setPageSecurityHeaders(res, new URL(params.redirectUri).origin);
  res.status(200).type('html').send(
    renderSuccessPage({ displayName: user.fullName || user.username, household: user.household ?? undefined, redirectUrl: redirect.href })
  );
}

/** `MCP: <client name> <YYYY-MM-DD>`, with the client name sanitized against a hostile registration. */
function mintedTokenName(clientName: string | null): string {
  const raw = (clientName ?? '').trim() || 'MCP client';
  // Strips control characters and Unicode format characters (bidi overrides, zero-width joins, ...)
  // that a hostile client_name could use to disguise itself in the token list.
  const sanitized = raw.replace(/[\p{Cf}\x00-\x1f\x7f]/gu, '').slice(0, 40).trim() || 'MCP client';
  const date = new Date().toISOString().slice(0, 10);
  return `MCP: ${sanitized} ${date}`;
}

/** Best-effort cleanup of a token minted for a session that then failed verification. */
async function tryDeleteMintedToken(deps: AuthDeps, jwt: string, tokenId: number): Promise<void> {
  try {
    await new MealieClient({ baseUrl: deps.config.mealieUrl, token: jwt }).delete(`/api/users/api-tokens/${tokenId}`);
  } catch (err) {
    deps.logger.warn({ reason: err instanceof Error ? err.message : String(err) }, 'cleaning up an unverified minted mealie token failed');
  }
}

/** Handles `login=session`: mints a dedicated Mealie API token from the caller's session cookie. */
async function handleSessionLogin(deps: AuthDeps, req: Request, res: Response, params: AuthorizeParams, csrf: string): Promise<void> {
  const redirectOrigin = new URL(params.redirectUri).origin;
  const renderSignedOut = (status: number, error: string) => {
    setPageSecurityHeaders(res, redirectOrigin);
    res
      .status(status)
      .type('html')
      .send(renderSignedOutPage({ params, csrf, mealiePublicUrl: deps.config.mealiePublicUrl, continueUrl: continueUrl(params), error }));
  };

  if (!deps.config.mealieSessionLogin) {
    return void renderSignedOut(400, 'Sign-in with your Mealie session is not available for this connection.');
  }

  const jwt = singleCookieValue(req.headers.cookie, MEALIE_SESSION_COOKIE);
  if (!jwt) return void renderSignedOut(400, SESSION_NOT_FOUND_MESSAGE);

  let user: MealieUser;
  try {
    user = await new MealieClient({ baseUrl: deps.config.mealieUrl, token: jwt }).get<MealieUser>('/api/users/self');
  } catch (err) {
    if (err instanceof MealieError && err.kind === 'http' && (err.status === 401 || err.status === 403)) {
      return void renderSignedOut(400, SESSION_NOT_FOUND_MESSAGE);
    }
    deps.logger.warn({ reason: err instanceof Error ? err.message : String(err) }, 'mealie session validation failed');
    return void renderSignedOut(502, 'Could not reach Mealie to check your session. Try again in a minute.');
  }

  let minted: { id: number; name: string; token: string };
  try {
    minted = await new MealieClient({ baseUrl: deps.config.mealieUrl, token: jwt }).post<{ id: number; name: string; token: string }>(
      '/api/users/api-tokens',
      { name: mintedTokenName(params.clientName) }
    );
  } catch (err) {
    deps.logger.warn({ reason: err instanceof Error ? err.message : String(err) }, 'minting mealie api token failed');
    return void renderSignedOut(502, 'Could not create a Mealie API token for this connection. Try again in a minute.');
  }

  let verified: MealieUser;
  try {
    verified = await new MealieClient({ baseUrl: deps.config.mealieUrl, token: minted.token }).get<MealieUser>('/api/users/self');
  } catch (err) {
    deps.logger.warn({ reason: err instanceof Error ? err.message : String(err) }, 'verifying minted mealie token failed');
    await tryDeleteMintedToken(deps, jwt, minted.id);
    setPageSecurityHeaders(res);
    return void res.status(502).type('html').send(renderErrorPage('Something went wrong finishing your Mealie sign-in. Please try again.'));
  }
  if (verified.id !== user.id) {
    deps.logger.warn('minted mealie token verification returned a different user');
    await tryDeleteMintedToken(deps, jwt, minted.id);
    setPageSecurityHeaders(res);
    return void res.status(502).type('html').send(renderErrorPage('Something went wrong finishing your Mealie sign-in. Please try again.'));
  }

  finalizeLogin(deps, res, params, user, minted.token);
}

export function authorizePostHandler(deps: AuthDeps): RequestHandler {
  return async (req, res) => {
    if (!isSameOriginRequest(req, deps)) {
      setPageSecurityHeaders(res);
      return void res.status(403).type('html').send(renderErrorPage('This sign-in form expired. Start the connection again from the app you were connecting.'));
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const v = validateAuthorizeParams(deps.store, body);
    if (!handleInvalid(res, v, deps)) return;
    const { params } = v;
    const redirectOrigin = new URL(params.redirectUri).origin;

    const cookieCsrf = readCookie(req.headers.cookie, CSRF_COOKIE);
    if (!cookieCsrf || typeof body.csrf !== 'string' || !safeEqual(cookieCsrf, body.csrf)) {
      setPageSecurityHeaders(res);
      return void res.status(403).type('html').send(renderErrorPage('This sign-in form expired. Start the connection again from the app you were connecting.'));
    }

    if (body.login === 'session') {
      return void (await handleSessionLogin(deps, req, res, params, cookieCsrf));
    }

    const renderAgain = (status: number, error: string) => {
      setPageSecurityHeaders(res, redirectOrigin);
      const page = deps.config.mealieSessionLogin
        ? renderSignedOutPage({ params, csrf: cookieCsrf, mealiePublicUrl: deps.config.mealiePublicUrl, continueUrl: continueUrl(params), error })
        : renderLoginPage({ params, csrf: cookieCsrf, mealiePublicUrl: deps.config.mealiePublicUrl, error });
      res.status(status).type('html').send(page);
    };

    const token = typeof body.mealie_token === 'string' ? body.mealie_token.trim() : '';
    if (!token) return void renderAgain(400, 'Paste your Mealie API token.');

    let user: MealieUser;
    try {
      user = await new MealieClient({ baseUrl: deps.config.mealieUrl, token }).get<MealieUser>('/api/users/self');
    } catch (err) {
      if (err instanceof MealieError && err.kind === 'http' && (err.status === 401 || err.status === 403)) {
        return void renderAgain(400, 'Mealie did not accept that API token. Check that you copied the whole token and that it has not been deleted.');
      }
      deps.logger.warn({ reason: err instanceof Error ? err.message : String(err) }, 'mealie token validation failed');
      return void renderAgain(502, 'Could not reach Mealie to check the token. Try again in a minute.');
    }

    finalizeLogin(deps, res, params, user, token);
  };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}
