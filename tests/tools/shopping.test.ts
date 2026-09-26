import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { shoppingTools } from '../../src/tools/shopping.js';
import { call, MEALIE } from '../helpers/mealie.js';
import { mswServer } from '../helpers/msw.js';

const tool = (name: string) => shoppingTools.find((t) => t.name === name)!;
const page = (items: unknown[]) => ({ page: 1, per_page: 20, total: items.length, total_pages: 1, items });
const ITEM_A = {
  id: 'i1', shoppingListId: 'L1', display: '2 cup milk', note: '', quantity: 2, checked: false, position: 0,
  foodId: 'f1', unitId: 'u1', labelId: null, food: { name: 'milk' }, unit: { name: 'cup' }, label: { name: 'Dairy' },
  recipeReferences: [], createdAt: 'x', groupId: 'g',
};
const ITEM_B = { ...ITEM_A, id: 'i2', display: 'bread', food: null, unit: null, foodId: null, unitId: null, note: 'bread', quantity: 1, checked: true, label: null };
const LIST = { id: 'L1', name: 'Groceries', listItems: [ITEM_A, ITEM_B], recipeReferences: [{ recipeId: 'r1', recipeQuantity: 1, recipe: { slug: 'soup', name: 'Soup' } }] };

describe('lists', () => {
  it('lists shopping lists', async () => {
    mswServer.use(http.get(`${MEALIE}/api/households/shopping/lists`, () => HttpResponse.json(page([{ id: 'L1', name: 'Groceries', groupId: 'g' }]))));
    expect((await call(tool('mealie_list_shopping_lists'), {})).data.items).toEqual([{ id: 'L1', name: 'Groceries' }]);
  });

  it('gets a list, hiding checked items by default', async () => {
    mswServer.use(http.get(`${MEALIE}/api/households/shopping/lists/L1`, () => HttpResponse.json(LIST)));
    const r = await call(tool('mealie_get_shopping_list'), { list_id: 'L1' });
    expect(r.data).toEqual({
      id: 'L1',
      name: 'Groceries',
      uncheckedCount: 1,
      checkedCount: 1,
      items: [{ id: 'i1', text: '2 cup milk', quantity: 2, unit: 'cup', food: 'milk', checked: false, label: 'Dairy' }],
      recipes: [{ recipeId: 'r1', slug: 'soup', name: 'Soup', quantity: 1 }],
    });
    const all = await call(tool('mealie_get_shopping_list'), { list_id: 'L1', include_checked: true });
    expect(all.data.items).toHaveLength(2);
  });

  it.each(['.', '..', '%2e%2e'])('rejects a dot-segment list id that would address a different endpoint (%s)', async (listIdArg) => {
    let called = false;
    mswServer.use(http.get(`${MEALIE}/api/households/shopping/lists/*`, () => { called = true; return HttpResponse.json({}); }));
    const r = await call(tool('mealie_get_shopping_list'), { list_id: listIdArg });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/"\." or "\.\."/);
    expect(called).toBe(false);
  });

  it('returns an empty items array for an empty list', async () => {
    mswServer.use(http.get(`${MEALIE}/api/households/shopping/lists/L2`, () => HttpResponse.json({ id: 'L2', name: 'Empty', listItems: [], recipeReferences: [] })));
    const r = await call(tool('mealie_get_shopping_list'), { list_id: 'L2' });
    expect(r.data.items).toEqual([]);
  });

  it('creates and deletes lists', async () => {
    mswServer.use(
      http.post(`${MEALIE}/api/households/shopping/lists`, async ({ request }) => {
        expect(await request.json()).toEqual({ name: 'Party' });
        return HttpResponse.json({ id: 'L9', name: 'Party' }, { status: 201 });
      }),
      http.delete(`${MEALIE}/api/households/shopping/lists/L9`, () => HttpResponse.json({}))
    );
    expect((await call(tool('mealie_create_shopping_list'), { name: 'Party' })).data).toEqual({ id: 'L9', name: 'Party' });
    expect((await call(tool('mealie_delete_shopping_list'), { list_id: 'L9' })).data).toEqual({ deleted: 'L9' });
  });
});

describe('items', () => {
  it('adds items, linking known foods and units', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/foods`, ({ request }) =>
        HttpResponse.json(page(new URL(request.url).searchParams.get('search') === 'milk' ? [{ id: 'f1', name: 'milk' }] : []))
      ),
      http.get(`${MEALIE}/api/units`, () => HttpResponse.json(page([{ id: 'u1', name: 'cup', abbreviation: 'c' }]))),
      http.post(`${MEALIE}/api/households/shopping/items/create-bulk`, async ({ request }) => {
        expect(await request.json()).toEqual([
          { shoppingListId: 'L1', quantity: 2, note: '', foodId: 'f1', unitId: 'u1', checked: false },
          { shoppingListId: 'L1', quantity: 1, note: 'fancy cheese (aged)', foodId: null, unitId: null, checked: false },
        ]);
        return HttpResponse.json({ createdItems: [ITEM_A], updatedItems: [ITEM_B], deletedItems: [] }, { status: 201 });
      })
    );
    const r = await call(tool('mealie_add_shopping_items'), {
      list_id: 'L1',
      items: [
        { text: '2 cups milk', quantity: 2, unit: 'cup', food: 'milk' },
        { text: 'fancy cheese', note: 'aged' },
      ],
    });
    expect(r.data).toEqual({ created: 1, merged: 1 });
  });

  it('updates items by merging into current values', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/households/shopping/lists/L1`, () => HttpResponse.json(LIST)),
      http.put(`${MEALIE}/api/households/shopping/items`, async ({ request }) => {
        expect(await request.json()).toEqual([
          {
            id: 'i1', shoppingListId: 'L1', checked: true, quantity: 3, note: '', display: '2 cup milk', position: 0,
            foodId: 'f1', unitId: 'u1', labelId: null, recipeReferences: [], extras: {},
          },
        ]);
        return HttpResponse.json({ createdItems: [], updatedItems: [ITEM_A], deletedItems: [] });
      })
    );
    expect((await call(tool('mealie_update_shopping_items'), { list_id: 'L1', updates: [{ id: 'i1', checked: true, quantity: 3 }] })).data).toEqual({ updated: 1 });
  });

  it('keeps existing extras when updating an item', async () => {
    const withExtras = { ...ITEM_A, extras: { barcode: '012345' } };
    mswServer.use(
      http.get(`${MEALIE}/api/households/shopping/lists/L1`, () => HttpResponse.json({ ...LIST, listItems: [withExtras, ITEM_B] })),
      http.put(`${MEALIE}/api/households/shopping/items`, async ({ request }) => {
        const [body] = (await request.json()) as Array<{ extras: unknown }>;
        expect(body.extras).toEqual({ barcode: '012345' });
        return HttpResponse.json({ createdItems: [], updatedItems: [withExtras], deletedItems: [] });
      })
    );
    expect((await call(tool('mealie_update_shopping_items'), { list_id: 'L1', updates: [{ id: 'i1', checked: true }] })).data).toEqual({ updated: 1 });
  });

  it('reports unknown item ids', async () => {
    mswServer.use(http.get(`${MEALIE}/api/households/shopping/lists/L1`, () => HttpResponse.json(LIST)));
    const r = await call(tool('mealie_update_shopping_items'), { list_id: 'L1', updates: [{ id: 'zzz', checked: true }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/zzz/);
  });

  it('removes items by id', async () => {
    mswServer.use(
      http.delete(`${MEALIE}/api/households/shopping/items`, ({ request }) => {
        expect(new URL(request.url).searchParams.getAll('ids')).toEqual(['i1', 'i2']);
        return HttpResponse.json({});
      })
    );
    expect((await call(tool('mealie_remove_shopping_items'), { item_ids: ['i1', 'i2'] })).data).toEqual({ removed: 2 });
  });
});

describe('recipes on lists', () => {
  it('adds recipe ingredients with scaling', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/recipes/soup`, () => HttpResponse.json({ id: 'r1', slug: 'soup', name: 'Soup' })),
      http.post(`${MEALIE}/api/households/shopping/lists/L1/recipe`, async ({ request }) => {
        expect(await request.json()).toEqual([{ recipeId: 'r1', recipeIncrementQuantity: 2 }]);
        return HttpResponse.json(LIST);
      })
    );
    const r = await call(tool('mealie_add_recipe_to_shopping_list'), { list_id: 'L1', recipes: [{ slug: 'soup', scale: 2 }] });
    expect(r.data).toEqual({ added: [{ slug: 'soup', scale: 2 }] });
  });

  it('removes a recipe from a list', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/recipes/soup`, () => HttpResponse.json({ id: 'r1', slug: 'soup', name: 'Soup' })),
      http.post(`${MEALIE}/api/households/shopping/lists/L1/recipe/r1/delete`, async ({ request }) => {
        expect(await request.json()).toEqual({ recipeDecrementQuantity: 1 });
        return HttpResponse.json(LIST);
      })
    );
    expect((await call(tool('mealie_remove_recipe_from_shopping_list'), { list_id: 'L1', slug: 'soup' })).data).toEqual({ removed: 'soup' });
  });
});
