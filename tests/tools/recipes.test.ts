import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { recipeTools } from '../../src/tools/recipes.js';
import { call, MEALIE } from '../helpers/mealie.js';
import { mswServer } from '../helpers/msw.js';

const tool = (name: string) => recipeTools.find((t) => t.name === name)!;
const page = (items: unknown[]) => ({ page: 1, per_page: 20, total: items.length, total_pages: 1, items });
const RECIPE = {
  id: 'r1', slug: 'soup', name: 'Soup', description: 'Warm', recipeYield: '4 servings', recipeServings: 4,
  prepTime: '10 min', performTime: '30 min', totalTime: '40 min', rating: 4, lastMade: null, orgURL: 'https://x.test/soup',
  groupId: 'g', userId: 'u', image: 'abc',
  tags: [{ id: 't1', name: 'Quick', slug: 'quick' }], recipeCategory: [{ id: 'c1', name: 'Dinner', slug: 'dinner' }], tools: [],
  recipeIngredient: [{ title: 'Base', display: '1 onion', note: '' }, { display: '', note: '2 cups stock' }],
  recipeInstructions: [{ title: '', text: 'Chop.' }, { title: 'Simmer', text: 'Cook 30 min.' }],
  notes: [{ title: 'Tip', text: 'Add salt.' }],
};

describe('mealie_search_recipes', () => {
  it('maps filters to Mealie query params and summarizes results', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/recipes`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        expect(q.get('search')).toBe('soup');
        expect(q.getAll('tags')).toEqual(['quick', 'vegan']);
        expect(q.get('requireAllTags')).toBe('true');
        expect(q.get('orderBy')).toBe('name');
        expect(q.get('orderDirection')).toBe('asc');
        expect(q.get('perPage')).toBe('20');
        expect(q.has('paginationSeed')).toBe(false);
        return HttpResponse.json(page([RECIPE]));
      })
    );
    const r = await call(tool('mealie_search_recipes'), { query: 'soup', tags: ['quick', 'vegan'], require_all: true });
    expect(r.data).toEqual({
      page: 1, perPage: 20, total: 1, totalPages: 1,
      items: [{ slug: 'soup', name: 'Soup', description: 'Warm', totalTime: '40 min', rating: 4, tags: ['Quick'], categories: ['Dinner'] }],
    });
  });

  it('sets a pagination seed for random order', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/recipes`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('paginationSeed')).toMatch(/^\d+$/);
        return HttpResponse.json(page([]));
      })
    );
    const r = await call(tool('mealie_search_recipes'), { order_by: 'random' });
    expect(r.data.items).toEqual([]);
  });
});

describe('mealie_get_recipe', () => {
  it('flattens ingredients, instructions, and notes', async () => {
    mswServer.use(http.get(`${MEALIE}/api/recipes/soup`, () => HttpResponse.json(RECIPE)));
    const r = await call(tool('mealie_get_recipe'), { slug: 'soup' });
    expect(r.data).toEqual({
      id: 'r1', slug: 'soup', name: 'Soup', description: 'Warm', yield: '4 servings', servings: 4,
      prepTime: '10 min', cookTime: '30 min', totalTime: '40 min', rating: 4, sourceUrl: 'https://x.test/soup',
      tags: ['Quick'], categories: ['Dinner'], tools: [],
      ingredients: ['[Base] 1 onion', '2 cups stock'],
      instructions: ['1. Chop.', '2. Simmer: Cook 30 min.'],
      notes: ['Tip: Add salt.'],
    });
  });

  it('encodes slug so it cannot address another endpoint', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/recipes/*`, ({ request }) => {
        expect(new URL(request.url).pathname).toBe('/api/recipes/a%2F..%2Fadmin%3Fx');
        return HttpResponse.json(RECIPE);
      })
    );
    expect((await call(tool('mealie_get_recipe'), { slug: 'a/../admin?x' })).isError).toBe(false);
  });

  it.each(['.', '..', '%2e%2e'])('rejects a dot-segment slug that would address a different endpoint (%s)', async (slug) => {
    let called = false;
    mswServer.use(http.get(`${MEALIE}/api/recipes/*`, () => { called = true; return HttpResponse.json(RECIPE); }));
    const r = await call(tool('mealie_get_recipe'), { slug });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/"\." or "\.\."/);
    expect(called).toBe(false);
  });

  it('points to search on 404', async () => {
    mswServer.use(http.get(`${MEALIE}/api/recipes/nope`, () => HttpResponse.json({ detail: 'x' }, { status: 404 })));
    const r = await call(tool('mealie_get_recipe'), { slug: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/mealie_search_recipes/);
  });
});

describe('mealie_create_recipe', () => {
  it('creates by name then patches structured fields', async () => {
    let patch: any;
    mswServer.use(
      http.post(`${MEALIE}/api/recipes`, async ({ request }) => {
        expect(await request.json()).toEqual({ name: 'Soup' });
        return HttpResponse.json('soup', { status: 201 });
      }),
      http.get(`${MEALIE}/api/organizers/tags`, () => HttpResponse.json(page([{ id: 't1', name: 'Quick', slug: 'quick' }]))),
      http.patch(`${MEALIE}/api/recipes/soup`, async ({ request }) => {
        patch = await request.json();
        return HttpResponse.json({ ...RECIPE, slug: 'soup', name: 'Soup' });
      })
    );
    const r = await call(tool('mealie_create_recipe'), {
      name: 'Soup', cook_time: '30 min', ingredients: ['1 onion'], instructions: ['Chop.'], tags: ['quick'],
    });
    expect(r.data).toEqual({ slug: 'soup', name: 'Soup' });
    expect(patch).toEqual({
      performTime: '30 min',
      recipeIngredient: [{ note: '1 onion', display: '1 onion', referenceId: expect.any(String) }],
      recipeInstructions: [{ id: expect.any(String), title: '', text: 'Chop.', ingredientReferences: [] }],
      tags: [{ id: 't1', name: 'Quick', slug: 'quick' }],
    });
  });

  it('skips the patch when only a name is given', async () => {
    mswServer.use(http.post(`${MEALIE}/api/recipes`, () => HttpResponse.json('bread', { status: 201 })));
    expect((await call(tool('mealie_create_recipe'), { name: 'Bread' })).data).toEqual({ slug: 'bread', name: 'Bread' });
  });
});

describe('mealie_import_recipe_from_url', () => {
  it('posts the URL and returns the new slug', async () => {
    mswServer.use(
      http.post(`${MEALIE}/api/recipes/create/url`, async ({ request }) => {
        expect(await request.json()).toEqual({ url: 'https://example.com/r', includeTags: true });
        return HttpResponse.json('imported', { status: 201 });
      })
    );
    expect((await call(tool('mealie_import_recipe_from_url'), { url: 'https://example.com/r' })).data).toEqual({ slug: 'imported' });
  });
});

describe('mealie_update_recipe', () => {
  it('patches only the given fields', async () => {
    mswServer.use(
      http.patch(`${MEALIE}/api/recipes/soup`, async ({ request }) => {
        expect(await request.json()).toEqual({ rating: 5, name: 'Better Soup' });
        return HttpResponse.json({ ...RECIPE, slug: 'better-soup', name: 'Better Soup' });
      })
    );
    expect((await call(tool('mealie_update_recipe'), { slug: 'soup', name: 'Better Soup', rating: 5 })).data).toEqual({ slug: 'better-soup', name: 'Better Soup' });
  });

  it('rejects an empty update', async () => {
    const r = await call(tool('mealie_update_recipe'), { slug: 'soup' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Nothing to update/);
  });
});

describe('delete and duplicate', () => {
  it('deletes a recipe', async () => {
    mswServer.use(http.delete(`${MEALIE}/api/recipes/soup`, () => HttpResponse.json(RECIPE)));
    expect((await call(tool('mealie_delete_recipe'), { slug: 'soup' })).data).toEqual({ deleted: 'soup' });
  });

  it('duplicates with an optional new name', async () => {
    mswServer.use(
      http.post(`${MEALIE}/api/recipes/soup/duplicate`, async ({ request }) => {
        expect(await request.json()).toEqual({ name: 'Soup 2' });
        return HttpResponse.json({ ...RECIPE, slug: 'soup-2', name: 'Soup 2' }, { status: 201 });
      })
    );
    expect((await call(tool('mealie_duplicate_recipe'), { slug: 'soup', new_name: 'Soup 2' })).data).toEqual({ slug: 'soup-2', name: 'Soup 2' });
  });
});

describe('mealie_suggest_recipes', () => {
  it('resolves food names and reports unmatched ones', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/foods`, ({ request }) => {
        const search = new URL(request.url).searchParams.get('search');
        return HttpResponse.json(page(search === 'chicken' ? [{ id: 'f1', name: 'chicken' }] : []));
      }),
      http.get(`${MEALIE}/api/recipes/suggestions`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        expect(q.getAll('foods')).toEqual(['f1']);
        expect(q.get('maxMissingFoods')).toBe('3');
        return HttpResponse.json({ items: [{ recipe: RECIPE, missingFoods: [{ name: 'stock' }], missingTools: [] }] });
      })
    );
    const r = await call(tool('mealie_suggest_recipes'), { foods: ['chicken', 'unobtainium'] });
    expect(r.data).toEqual({
      matchedFoods: ['chicken'],
      unmatchedFoods: ['unobtainium'],
      suggestions: [{ slug: 'soup', name: 'Soup', missingFoods: ['stock'], missingTools: [] }],
    });
  });

  it('errors when no food matches', async () => {
    mswServer.use(http.get(`${MEALIE}/api/foods`, () => HttpResponse.json(page([]))));
    const r = await call(tool('mealie_suggest_recipes'), { foods: ['unobtainium'] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/mealie_list_foods/);
  });
});

describe('mealie_parse_ingredients', () => {
  it('returns structured quantities', async () => {
    mswServer.use(
      http.post(`${MEALIE}/api/parser/ingredients`, async ({ request }) => {
        expect(await request.json()).toEqual({ parser: 'nlp', ingredients: ['2 cups flour'] });
        return HttpResponse.json([
          { input: '2 cups flour', confidence: { average: 0.9 }, ingredient: { quantity: 2, unit: { name: 'cup' }, food: { name: 'flour' }, note: '' } },
        ]);
      })
    );
    expect((await call(tool('mealie_parse_ingredients'), { ingredients: ['2 cups flour'] })).data).toEqual([
      { input: '2 cups flour', quantity: 2, unit: 'cup', food: 'flour', confidence: 0.9 },
    ]);
  });
});

describe('mealie_mark_recipe_made', () => {
  it('sets last made and adds a timeline event', async () => {
    let event: any;
    mswServer.use(
      http.get(`${MEALIE}/api/recipes/soup`, () => HttpResponse.json(RECIPE)),
      http.patch(`${MEALIE}/api/recipes/soup/last-made`, async ({ request }) => {
        expect(await request.json()).toEqual({ timestamp: '2026-09-25T18:00:00Z' });
        return HttpResponse.json({});
      }),
      http.post(`${MEALIE}/api/recipes/timeline/events`, async ({ request }) => {
        event = await request.json();
        return HttpResponse.json({ id: 'e1' }, { status: 201 });
      })
    );
    const r = await call(tool('mealie_mark_recipe_made'), { slug: 'soup', made_at: '2026-09-25T18:00:00Z', note: 'Great' });
    expect(r.data).toEqual({ slug: 'soup', lastMade: '2026-09-25T18:00:00Z' });
    expect(event).toEqual({ recipeId: 'r1', subject: 'Made this', eventType: 'info', eventMessage: 'Great', timestamp: '2026-09-25T18:00:00Z' });
  });
});

describe('mealie_bulk_tag_recipes', () => {
  it('tags many recipes with resolved tags', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/organizers/tags`, () => HttpResponse.json(page([{ id: 't1', name: 'Quick', slug: 'quick' }]))),
      http.post(`${MEALIE}/api/recipes/bulk-actions/tag`, async ({ request }) => {
        expect(await request.json()).toEqual({ recipes: ['soup', 'bread'], tags: [{ id: 't1', name: 'Quick', slug: 'quick' }] });
        return HttpResponse.json({});
      })
    );
    expect((await call(tool('mealie_bulk_tag_recipes'), { slugs: ['soup', 'bread'], tags: ['quick'] })).data).toEqual({ tagged: 2, tags: ['Quick'] });
  });
});
