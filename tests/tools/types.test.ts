import { http, HttpResponse } from 'msw';
import * as z from 'zod';
import { describe, expect, it } from 'vitest';
import { defineTool, READ } from '../../src/tools/types.js';
import { call, MEALIE } from '../helpers/mealie.js';
import { mswServer } from '../helpers/msw.js';

const echo = defineTool({
  name: 'mealie_test_echo',
  title: 'Echo',
  description: 'test',
  inputSchema: z.object({ slug: z.string(), n: z.number().default(3) }),
  annotations: READ,
  notFoundHint: 'Use mealie_search_recipes to find the slug.',
  async run(args, ctx) {
    if (args.slug === 'missing') return ctx.mealie.get('/api/recipes/missing');
    return { got: args };
  },
});

describe('runTool', () => {
  it('returns JSON text for successful runs with defaults applied', async () => {
    const r = await call(echo, { slug: 'a' });
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ got: { slug: 'a', n: 3 } });
  });

  it('returns isError with a readable message for invalid input', async () => {
    const r = await call(echo, { slug: 5 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Invalid input/);
    expect(r.text).toMatch(/slug/);
  });

  it('maps Mealie errors using the tool notFoundHint', async () => {
    mswServer.use(http.get(`${MEALIE}/api/recipes/missing`, () => HttpResponse.json({ detail: 'x' }, { status: 404 })));
    const r = await call(echo, { slug: 'missing' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/mealie_search_recipes/);
  });

  it('returns {"ok":true} when a tool returns undefined', async () => {
    const quiet = defineTool({ ...echo, name: 'mealie_test_quiet', async run() { return undefined; } });
    expect((await call(quiet, { slug: 'a' })).data).toEqual({ ok: true });
  });
});
