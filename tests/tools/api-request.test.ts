import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { apiRequest, checkApiPath } from '../../src/tools/api-request.js';
import type { HttpMethod } from '../../src/mealie/client.js';
import { call, MEALIE } from '../helpers/mealie.js';
import { mswServer } from '../helpers/msw.js';

describe('checkApiPath', () => {
  const allowed: Array<[HttpMethod, string]> = [
    ['GET', '/api/recipes'],
    ['GET', '/api/users/self'],
    ['GET', '/api/users/self/'],
    ['POST', '/api/households/webhooks'],
    ['PUT', '/api/households/mealplans/rules/1'],
    ['GET', '/api/recipes/soup%20bowl'],
  ];
  const denied: Array<[HttpMethod, string, RegExp]> = [
    ['GET', '/api/admin/users', /blocked/],
    ['GET', '/api/admin', /blocked/],
    ['POST', '/api/auth/token', /blocked/],
    ['POST', '/api/users/api-tokens', /blocked/],
    ['PUT', '/api/users/password', /blocked/],
    ['PUT', '/api/users/self', /blocked/],
    ['GET', '/api/users/self/favorites', /blocked/],
    ['GET', '/api/households/invitations', /blocked/],
    ['POST', '/api/households/invitations', /blocked/],
    ['POST', '/api/households/invitations/email', /blocked/],
    ['PUT', '/api/households/permissions', /blocked/],
    ['GET', '/API/Admin/users', /blocked/],
    ['GET', '/api/%61dmin/users', /blocked/],
    ['GET', '/api/recipes/../admin/users', /\.\./],
    ['GET', '/api/recipes/%2e%2e/admin/users', /\.\./],
    ['GET', '/api/recipes/%252e%252e/admin', /\.\./],
    ['GET', '/api//admin', /\/\//],
    ['GET', '/api/recipes\\..\\admin', /backslash/],
    ['GET', '/recipes', /must start with \/api\//],
    ['GET', 'http://evil.test/api/recipes', /must start with \/api\//],
    ['GET', '/api/recipes?search=x', /query/],
    // Single-dot segments the WHATWG URL parser collapses when MealieClient builds the real
    // request URL, even though they never match the literal ".." check on the decoded string.
    ['POST', '/api/./users/api-tokens', /\.\./],
    ['GET', '/api/%2e/admin/users', /\.\./],
    ['PUT', '/api/./users/password', /\.\./],
    ['POST', '/api/./auth/token', /\.\./],
    // Control characters the URL parser silently strips, so the denylist check and the request
    // that actually goes out would otherwise see two different paths.
    ['POST', '/api/ad%09min/users', /control charact/],
    ['POST', '/api/us%0Aers/api-tokens', /control charact/],
    // Encoded deeply enough that the 5-iteration decode limit stops one layer short of revealing
    // the ".." segments, so the string returned must never be treated as safe.
    ['POST', '/api/recipes/%25252525252e%25252525252e/users/api-tokens', /encoded too many times/],
  ];

  it.each(allowed)('allows %s %s', (method, path) => {
    expect(() => checkApiPath(method, path)).not.toThrow();
  });

  it.each(denied)('denies %s %s', (method, path, message) => {
    expect(() => checkApiPath(method, path)).toThrow(message);
  });
});

describe('mealie_api_request', () => {
  it('forwards method, path, query, and body and compacts the result', async () => {
    mswServer.use(
      http.post(`${MEALIE}/api/households/webhooks`, async ({ request }) => {
        expect(new URL(request.url).searchParams.get('x')).toBe('1');
        expect(await request.json()).toEqual({ name: 'hook' });
        return HttpResponse.json({ id: 'w1', name: 'hook', groupId: 'g' }, { status: 201 });
      })
    );
    const r = await call(apiRequest, { method: 'POST', path: '/api/households/webhooks', query: { x: 1 }, body: { name: 'hook' } });
    expect(r.data).toEqual({ id: 'w1', name: 'hook' });
  });

  it('blocks denied paths without calling Mealie', async () => {
    let called = false;
    mswServer.use(http.post(`${MEALIE}/api/users/api-tokens`, () => { called = true; return HttpResponse.json({}); }));
    const r = await call(apiRequest, { method: 'POST', path: '/api/users/api-tokens', body: { name: 'x' } });
    expect(r.isError).toBe(true);
    expect(called).toBe(false);
  });
});
