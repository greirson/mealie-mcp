import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { mealplanTools } from '../../src/tools/mealplans.js';
import { call, MEALIE } from '../helpers/mealie.js';
import { mswServer } from '../helpers/msw.js';

const tool = (name: string) => mealplanTools.find((t) => t.name === name)!;
const ENTRY = {
  id: 7, date: '2026-09-26', entryType: 'dinner', title: '', text: '', recipeId: 'r1',
  recipe: { id: 'r1', slug: 'soup', name: 'Soup' }, groupId: 'g1', userId: 'u1', householdId: 'h1',
};
const page = (items: unknown[]) => ({ page: 1, per_page: 20, total: items.length, total_pages: 1, items });

describe('mealie_list_mealplans', () => {
  it('queries the date range in date order', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/households/mealplans`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        expect(q.get('start_date')).toBe('2026-09-21');
        expect(q.get('end_date')).toBe('2026-09-27');
        expect(q.get('orderBy')).toBe('date');
        return HttpResponse.json(page([ENTRY]));
      })
    );
    const r = await call(tool('mealie_list_mealplans'), { start_date: '2026-09-21', end_date: '2026-09-27' });
    expect(r.data.items).toEqual([{ id: 7, date: '2026-09-26', type: 'dinner', recipe: { slug: 'soup', name: 'Soup' } }]);
  });

  it('empty range returns an empty items array', async () => {
    mswServer.use(http.get(`${MEALIE}/api/households/mealplans`, () => HttpResponse.json(page([]))));
    const r = await call(tool('mealie_list_mealplans'), { start_date: '2026-09-21', end_date: '2026-09-27' });
    expect(r.isError).toBe(false);
    expect(r.data.items).toEqual([]);
  });

  it('rejects an end date before the start date', async () => {
    const r = await call(tool('mealie_list_mealplans'), { start_date: '2026-09-27', end_date: '2026-09-21' });
    expect(r.isError).toBe(true);
  });
});

describe('mealie_get_todays_meals', () => {
  it('returns today entries', async () => {
    mswServer.use(http.get(`${MEALIE}/api/households/mealplans/today`, () => HttpResponse.json([ENTRY])));
    expect((await call(tool('mealie_get_todays_meals'), {})).data).toEqual({ items: [{ id: 7, date: '2026-09-26', type: 'dinner', recipe: { slug: 'soup', name: 'Soup' } }] });
  });
});

describe('mealie_add_mealplan_entry', () => {
  it('resolves the recipe slug and creates the entry', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/recipes/soup`, () => HttpResponse.json({ id: 'r1', slug: 'soup', name: 'Soup' })),
      http.post(`${MEALIE}/api/households/mealplans`, async ({ request }) => {
        expect(await request.json()).toEqual({ date: '2026-09-26', entryType: 'dinner', title: '', text: '', recipeId: 'r1' });
        return HttpResponse.json(ENTRY, { status: 201 });
      })
    );
    const r = await call(tool('mealie_add_mealplan_entry'), { date: '2026-09-26', recipe_slug: 'soup' });
    expect(r.data).toEqual({ id: 7, date: '2026-09-26', type: 'dinner', recipe: { slug: 'soup', name: 'Soup' } });
  });

  it('creates a free-text entry without a recipe', async () => {
    mswServer.use(
      http.post(`${MEALIE}/api/households/mealplans`, async ({ request }) => {
        expect(await request.json()).toEqual({ date: '2026-09-26', entryType: 'lunch', title: 'Leftovers', text: 'from Sunday', recipeId: null });
        return HttpResponse.json({ ...ENTRY, entryType: 'lunch', title: 'Leftovers', text: 'from Sunday', recipeId: null, recipe: null }, { status: 201 });
      })
    );
    const r = await call(tool('mealie_add_mealplan_entry'), { date: '2026-09-26', entry_type: 'lunch', title: 'Leftovers', note: 'from Sunday' });
    expect(r.data).toEqual({ id: 7, date: '2026-09-26', type: 'lunch', title: 'Leftovers', note: 'from Sunday' });
  });

  it('requires a recipe or a title', async () => {
    expect((await call(tool('mealie_add_mealplan_entry'), { date: '2026-09-26' })).isError).toBe(true);
  });
});

describe('mealie_update_mealplan_entry', () => {
  it('merges changes into the current entry and PUTs the full object', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/households/mealplans/7`, () => HttpResponse.json(ENTRY)),
      http.put(`${MEALIE}/api/households/mealplans/7`, async ({ request }) => {
        expect(await request.json()).toEqual({
          id: 7, groupId: 'g1', userId: 'u1', date: '2026-09-27', entryType: 'dinner', title: '', text: '', recipeId: null,
        });
        return HttpResponse.json({ ...ENTRY, date: '2026-09-27', recipeId: null, recipe: null });
      })
    );
    const r = await call(tool('mealie_update_mealplan_entry'), { id: 7, date: '2026-09-27', recipe_slug: null });
    expect(r.data).toEqual({ id: 7, date: '2026-09-27', type: 'dinner' });
  });
});

describe('delete and random', () => {
  it('deletes an entry', async () => {
    mswServer.use(http.delete(`${MEALIE}/api/households/mealplans/7`, () => HttpResponse.json(ENTRY)));
    expect((await call(tool('mealie_delete_mealplan_entry'), { id: 7 })).data).toEqual({ deleted: 7 });
  });

  it('adds a random entry and explains a 404', async () => {
    mswServer.use(
      http.post(`${MEALIE}/api/households/mealplans/random`, async ({ request }) => {
        expect(await request.json()).toEqual({ date: '2026-09-26', entryType: 'dinner' });
        return HttpResponse.json(ENTRY, { status: 201 });
      })
    );
    expect((await call(tool('mealie_random_mealplan_entry'), { date: '2026-09-26' })).data.recipe).toEqual({ slug: 'soup', name: 'Soup' });
    mswServer.use(http.post(`${MEALIE}/api/households/mealplans/random`, () => HttpResponse.json({}, { status: 404 })));
    expect((await call(tool('mealie_random_mealplan_entry'), { date: '2026-09-26' })).text).toMatch(/meal plan rules/);
  });
});
