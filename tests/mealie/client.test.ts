import { delay, http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { MealieClient } from '../../src/mealie/client.js';
import { MealieError, ToolInputError, toToolMessage } from '../../src/mealie/errors.js';
import { MEALIE } from '../helpers/mealie.js';
import { mswServer } from '../helpers/msw.js';

const client = (init: Partial<ConstructorParameters<typeof MealieClient>[0]> = {}) =>
  new MealieClient({ baseUrl: MEALIE, token: 'tok', timeoutMs: 200, retryDelayMs: 0, ...init });

describe('MealieClient', () => {
  it('sends bearer auth, query arrays, and JSON bodies', async () => {
    mswServer.use(
      http.post(`${MEALIE}/api/things`, async ({ request }) => {
        const url = new URL(request.url);
        expect(request.headers.get('authorization')).toBe('Bearer tok');
        expect(url.searchParams.getAll('ids')).toEqual(['a', 'b']);
        expect(url.searchParams.has('skip')).toBe(false);
        expect(await request.json()).toEqual({ name: 'x' });
        return HttpResponse.json({ ok: true }, { status: 201 });
      })
    );
    const res = await client().request({ method: 'POST', path: '/api/things', query: { ids: ['a', 'b'], skip: undefined }, body: { name: 'x' } });
    expect(res).toEqual({ ok: true });
  });

  it('returns undefined for empty bodies and raw text for non-JSON', async () => {
    mswServer.use(
      http.delete(`${MEALIE}/api/a`, () => new HttpResponse(null, { status: 204 })),
      http.get(`${MEALIE}/api/b`, () => HttpResponse.text('"slug-1"'))
    );
    expect(await client().delete('/api/a')).toBeUndefined();
    expect(await client().get('/api/b')).toBe('slug-1');
  });

  it('calls onUnauthorized on 401 and throws MealieError', async () => {
    mswServer.use(http.get(`${MEALIE}/api/x`, () => HttpResponse.json({ detail: 'nope' }, { status: 401 })));
    const onUnauthorized = vi.fn();
    await expect(client({ onUnauthorized }).get('/api/x')).rejects.toMatchObject({ kind: 'http', status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('retries a GET once on 5xx', async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${MEALIE}/api/x`, () => {
        calls++;
        return calls === 1 ? HttpResponse.json({}, { status: 502 }) : HttpResponse.json({ ok: 1 });
      })
    );
    expect(await client().get('/api/x')).toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });

  it('never retries writes', async () => {
    let calls = 0;
    mswServer.use(
      http.post(`${MEALIE}/api/x`, () => {
        calls++;
        return HttpResponse.json({}, { status: 503 });
      })
    );
    await expect(client().post('/api/x', {})).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(1);
  });

  it('times out and reports kind=timeout after one GET retry', async () => {
    let calls = 0;
    mswServer.use(
      http.get(`${MEALIE}/api/slow`, async () => {
        calls++;
        await delay(1000);
        return HttpResponse.json({});
      })
    );
    await expect(client({ timeoutMs: 50 }).get('/api/slow')).rejects.toMatchObject({ kind: 'timeout' });
    expect(calls).toBe(2);
  });

  it('reports kind=network when Mealie is unreachable', async () => {
    mswServer.use(http.get(`${MEALIE}/api/x`, () => HttpResponse.error()));
    await expect(client().get('/api/x')).rejects.toMatchObject({ kind: 'network' });
  });
});

describe('toToolMessage', () => {
  const err = (status: number, detail?: unknown) => new MealieError({ kind: 'http', status, method: 'GET', path: '/api/recipes/x', detail });

  it('maps each status to an actionable message', () => {
    expect(toToolMessage(err(401))).toMatch(/Reconnect the Mealie connector/);
    expect(toToolMessage(err(403))).toMatch(/does not have permission/);
    expect(toToolMessage(err(404), 'Use mealie_search_recipes to find the slug.')).toMatch(/Not found.*mealie_search_recipes/s);
    expect(toToolMessage(err(422, { detail: [{ msg: 'field required' }] }))).toMatch(/field required/);
    expect(toToolMessage(err(500))).toMatch(/HTTP 500/);
    expect(toToolMessage(err(409, { detail: 'dup' }))).toMatch(/HTTP 409.*dup/s);
    expect(toToolMessage(new MealieError({ kind: 'timeout', status: 0, method: 'GET', path: '/api/x' }))).toMatch(/did not respond/);
    expect(toToolMessage(new MealieError({ kind: 'network', status: 0, method: 'GET', path: '/api/x' }))).toMatch(/unreachable/);
    expect(toToolMessage(new ToolInputError('bad input'))).toBe('bad input');
    expect(toToolMessage(new Error('boom'))).toMatch(/Unexpected error: boom/);
  });
});
