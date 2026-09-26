import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { MEALIE } from '../helpers/mealie.js';
import { mswServer } from '../helpers/msw.js';

let app: TestApp;
beforeEach(async () => { app = await startTestApp(); });
afterEach(async () => { await app.close(); });

describe('GET /healthz', () => {
  it('reports ok with the Mealie version', async () => {
    mswServer.use(http.get(`${MEALIE}/api/app/about`, () => HttpResponse.json({ version: 'v3.1.0' })));
    const res = await fetch(`${app.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', mealieVersion: 'v3.1.0' });
  });

  it('reports 503 when Mealie is down', async () => {
    mswServer.use(http.get(`${MEALIE}/api/app/about`, () => HttpResponse.error()));
    expect((await fetch(`${app.baseUrl}/healthz`)).status).toBe(503);
  });
});
