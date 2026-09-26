import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ensureOrganizers, findByName, recipePath, resolveRecipe } from '../../src/tools/lookup.js';
import { MEALIE, testCtx } from '../helpers/mealie.js';
import { mswServer } from '../helpers/msw.js';

const page = (items: unknown[]) => ({ page: 1, per_page: 50, total: items.length, total_pages: 1, items });

describe('lookup helpers', () => {
  it('recipePath encodes the slug as one segment', () => {
    expect(recipePath('a/b c?#')).toBe('/api/recipes/a%2Fb%20c%3F%23');
  });

  it('resolveRecipe returns id, slug, and name', async () => {
    mswServer.use(http.get(`${MEALIE}/api/recipes/soup`, () => HttpResponse.json({ id: 'r1', slug: 'soup', name: 'Soup', tags: [] })));
    expect(await resolveRecipe(testCtx(), 'soup')).toEqual({ id: 'r1', slug: 'soup', name: 'Soup' });
  });

  it('ensureOrganizers reuses case-insensitive matches and creates missing ones', async () => {
    let created: unknown;
    mswServer.use(
      http.get(`${MEALIE}/api/organizers/tags`, ({ request }) => {
        const search = new URL(request.url).searchParams.get('search');
        return HttpResponse.json(page(search === 'Quick' ? [{ id: 't1', name: 'quick', slug: 'quick', groupId: 'g' }] : []));
      }),
      http.post(`${MEALIE}/api/organizers/tags`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ id: 't2', name: 'Vegan', slug: 'vegan', groupId: 'g' }, { status: 201 });
      })
    );
    const refs = await ensureOrganizers(testCtx(), 'tags', ['Quick', ' Vegan ', '']);
    expect(refs).toEqual([
      { id: 't1', name: 'quick', slug: 'quick' },
      { id: 't2', name: 'Vegan', slug: 'vegan' },
    ]);
    expect(created).toEqual({ name: 'Vegan' });
  });

  it('findByName matches name, plural, or abbreviation exactly', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/units`, () =>
        HttpResponse.json(page([{ id: 'u1', name: 'tablespoon', pluralName: 'tablespoons', abbreviation: 'tbsp' }, { id: 'u2', name: 'teaspoon' }]))
      )
    );
    expect(await findByName(testCtx(), 'units', 'TBSP')).toEqual({ id: 'u1', name: 'tablespoon' });
    expect(await findByName(testCtx(), 'units', 'tablespoons')).toEqual({ id: 'u1', name: 'tablespoon' });
    expect(await findByName(testCtx(), 'units', 'cup')).toBeUndefined();
  });
});
