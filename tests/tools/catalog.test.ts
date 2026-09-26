import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { catalogTools } from '../../src/tools/catalog.js';
import { call, MEALIE } from '../helpers/mealie.js';
import { mswServer } from '../helpers/msw.js';

const tool = (name: string) => catalogTools.find((t) => t.name === name)!;
const page = (items: unknown[]) => ({ page: 1, per_page: 20, total: items.length, total_pages: 1, items });
const FOOD = { id: 'f1', name: 'onion', pluralName: 'onions', description: '', labelId: null, label: { name: 'Produce' }, aliases: [{ name: 'brown onion' }], householdsWithIngredientFood: ['home'], extras: { onHand: 'true' }, substitutions: [{ substituteFoodId: 'f9', note: 'shallot works too' }], groupId: 'g' };
const UNIT = { id: 'u1', name: 'cup', pluralName: 'cups', description: '', abbreviation: 'c', pluralAbbreviation: '', useAbbreviation: false, fraction: true, aliases: [], standardQuantity: null, standardUnit: null, extras: { volumeMl: '236' } };
const BOOK = { id: 'b1', name: 'Weeknight', slug: 'weeknight', description: 'Fast', position: 1, public: false, queryFilterString: 'tags.name IN ["quick"]', groupId: 'g', householdId: 'h' };

describe('foods', () => {
  it('lists foods with search', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/foods`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('search')).toBe('oni');
        return HttpResponse.json(page([FOOD]));
      })
    );
    expect((await call(tool('mealie_list_foods'), { search: 'oni' })).data.items).toEqual([{ id: 'f1', name: 'onion', pluralName: 'onions', label: 'Produce' }]);
  });

  it('creates a food', async () => {
    mswServer.use(
      http.post(`${MEALIE}/api/foods`, async ({ request }) => {
        expect(await request.json()).toEqual({ name: 'leek', pluralName: null, description: '' });
        return HttpResponse.json({ ...FOOD, id: 'f2', name: 'leek' }, { status: 201 });
      })
    );
    expect((await call(tool('mealie_upsert_food'), { name: 'leek' })).data).toEqual({ id: 'f2', name: 'leek' });
  });

  it('updates a food by merging the current record', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/foods/f1`, () => HttpResponse.json(FOOD)),
      http.put(`${MEALIE}/api/foods/f1`, async ({ request }) => {
        expect(await request.json()).toEqual({
          id: 'f1', name: 'onion', pluralName: 'onions', description: 'Allium', labelId: null,
          extras: { onHand: 'true' }, aliases: [{ name: 'brown onion' }],
          substitutions: [{ substituteFoodId: 'f9', note: 'shallot works too' }], householdsWithIngredientFood: ['home'],
        });
        return HttpResponse.json({ ...FOOD, description: 'Allium' });
      })
    );
    expect((await call(tool('mealie_upsert_food'), { id: 'f1', description: 'Allium' })).data).toEqual({ id: 'f1', name: 'onion' });
  });

  it.each(['.', '..', '%2e%2e'])('rejects a dot-segment food id that would address a different endpoint (%s)', async (id) => {
    let called = false;
    mswServer.use(http.get(`${MEALIE}/api/foods/*`, () => { called = true; return HttpResponse.json(FOOD); }));
    const r = await call(tool('mealie_upsert_food'), { id, description: 'Allium' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/"\." or "\.\."/);
    expect(called).toBe(false);
  });

  it('requires a name to create', async () => {
    expect((await call(tool('mealie_upsert_food'), {})).isError).toBe(true);
  });

  it('merges foods', async () => {
    mswServer.use(
      http.put(`${MEALIE}/api/foods/merge`, async ({ request }) => {
        expect(await request.json()).toEqual({ fromFood: 'f2', toFood: 'f1' });
        return HttpResponse.json({ message: 'ok' });
      })
    );
    expect((await call(tool('mealie_merge_foods'), { from_food_id: 'f2', to_food_id: 'f1' })).data).toEqual({ merged: 'f2', into: 'f1' });
  });
});

describe('units', () => {
  it('lists and creates units', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/units`, () => HttpResponse.json(page([UNIT]))),
      http.post(`${MEALIE}/api/units`, async ({ request }) => {
        expect(await request.json()).toEqual({ name: 'pinch', pluralName: null, abbreviation: '', description: '' });
        return HttpResponse.json({ ...UNIT, id: 'u2', name: 'pinch' }, { status: 201 });
      })
    );
    expect((await call(tool('mealie_list_units'), {})).data.items).toEqual([{ id: 'u1', name: 'cup', pluralName: 'cups', abbreviation: 'c' }]);
    expect((await call(tool('mealie_upsert_unit'), { name: 'pinch' })).data).toEqual({ id: 'u2', name: 'pinch' });
  });

  it('updates a unit by merging the current record, keeping extras', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/units/u1`, () => HttpResponse.json(UNIT)),
      http.put(`${MEALIE}/api/units/u1`, async ({ request }) => {
        expect(await request.json()).toEqual({
          id: 'u1', name: 'cup', pluralName: 'cups', description: '', extras: { volumeMl: '236' },
          abbreviation: 'c', pluralAbbreviation: '', useAbbreviation: false, fraction: true,
          aliases: [], standardQuantity: null, standardUnit: null,
        });
        return HttpResponse.json(UNIT);
      })
    );
    expect((await call(tool('mealie_upsert_unit'), { id: 'u1', abbreviation: 'c' })).data).toEqual({ id: 'u1', name: 'cup' });
  });
});

describe('organizers', () => {
  it('lists by type', async () => {
    mswServer.use(http.get(`${MEALIE}/api/organizers/categories`, () => HttpResponse.json(page([{ id: 'c1', name: 'Dinner', slug: 'dinner', groupId: 'g' }]))));
    expect((await call(tool('mealie_list_organizers'), { type: 'categories' })).data.items).toEqual([{ id: 'c1', name: 'Dinner', slug: 'dinner' }]);
  });

  it('creates, renames, and deletes', async () => {
    mswServer.use(
      http.post(`${MEALIE}/api/organizers/tools`, () => HttpResponse.json({ id: 'k1', name: 'Wok', slug: 'wok' }, { status: 201 })),
      http.put(`${MEALIE}/api/organizers/tags/t1`, async ({ request }) => {
        expect(await request.json()).toEqual({ name: 'Speedy' });
        return HttpResponse.json({ id: 't1', name: 'Speedy', slug: 'speedy' });
      }),
      http.delete(`${MEALIE}/api/organizers/tags/t1`, () => HttpResponse.json({}))
    );
    expect((await call(tool('mealie_upsert_organizer'), { type: 'tools', name: 'Wok' })).data).toEqual({ id: 'k1', name: 'Wok', slug: 'wok' });
    expect((await call(tool('mealie_upsert_organizer'), { type: 'tags', id: 't1', name: 'Speedy' })).data).toEqual({ id: 't1', name: 'Speedy', slug: 'speedy' });
    expect((await call(tool('mealie_delete_organizer'), { type: 'tags', id: 't1' })).data).toEqual({ deleted: 't1', type: 'tags' });
  });

  it('renames a tool by merging the current record, keeping householdsWithTool', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/organizers/tools/k1`, () => HttpResponse.json({ id: 'k1', name: 'Wok', slug: 'wok', householdsWithTool: ['home'] })),
      http.put(`${MEALIE}/api/organizers/tools/k1`, async ({ request }) => {
        expect(await request.json()).toEqual({ name: 'Carbon steel wok', householdsWithTool: ['home'] });
        return HttpResponse.json({ id: 'k1', name: 'Carbon steel wok', slug: 'carbon-steel-wok', householdsWithTool: ['home'] });
      })
    );
    expect((await call(tool('mealie_upsert_organizer'), { type: 'tools', id: 'k1', name: 'Carbon steel wok' })).data).toEqual({
      id: 'k1', name: 'Carbon steel wok', slug: 'carbon-steel-wok',
    });
  });
});

describe('cookbooks', () => {
  it('lists cookbooks', async () => {
    mswServer.use(http.get(`${MEALIE}/api/households/cookbooks`, () => HttpResponse.json(page([BOOK]))));
    expect((await call(tool('mealie_list_cookbooks'), {})).data.items).toEqual([
      { id: 'b1', name: 'Weeknight', slug: 'weeknight', description: 'Fast', filter: 'tags.name IN ["quick"]', public: false },
    ]);
  });

  it('creates a cookbook and merges on update', async () => {
    mswServer.use(
      http.post(`${MEALIE}/api/households/cookbooks`, async ({ request }) => {
        expect(await request.json()).toEqual({ name: 'Soups', description: '', public: false, queryFilterString: '' });
        return HttpResponse.json({ ...BOOK, id: 'b2', name: 'Soups', slug: 'soups' }, { status: 201 });
      }),
      http.get(`${MEALIE}/api/households/cookbooks/b1`, () => HttpResponse.json(BOOK)),
      http.put(`${MEALIE}/api/households/cookbooks/b1`, async ({ request }) => {
        expect(await request.json()).toEqual({
          name: 'Weeknight', description: 'Fast', slug: 'weeknight', position: 1, public: true, queryFilterString: 'tags.name IN ["quick"]',
        });
        return HttpResponse.json({ ...BOOK, public: true });
      })
    );
    expect((await call(tool('mealie_upsert_cookbook'), { name: 'Soups' })).data).toEqual({ id: 'b2', name: 'Soups', slug: 'soups' });
    expect((await call(tool('mealie_upsert_cookbook'), { id: 'b1', public: true })).data).toEqual({ id: 'b1', name: 'Weeknight', slug: 'weeknight' });
  });
});
