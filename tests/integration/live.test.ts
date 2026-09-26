import { beforeAll, describe, expect, it } from 'vitest';
import { MealieClient } from '../../src/mealie/client.js';
import { apiRequest } from '../../src/tools/api-request.js';
import { catalogTools } from '../../src/tools/catalog.js';
import { allTools } from '../../src/tools/index.js';
import { mealplanTools } from '../../src/tools/mealplans.js';
import { recipeTools } from '../../src/tools/recipes.js';
import { shoppingTools } from '../../src/tools/shopping.js';
import { runTool, type ToolContext } from '../../src/tools/types.js';

const LIVE = process.env.MEALIE_TEST_LIVE === '1';
const BASE = process.env.MEALIE_TEST_URL ?? 'http://localhost:9925';
// Mealie's documented first-run admin account on a fresh install.
const ADMIN_USER = process.env.MEALIE_TEST_USER ?? 'changeme@example.com';
const ADMIN_PASSWORD = process.env.MEALIE_TEST_PASSWORD ?? 'MyPassword';

const byName = (name: string) => [...allTools, ...recipeTools, ...mealplanTools, ...shoppingTools, ...catalogTools, apiRequest].find((t) => t.name === name)!;
let ctx: ToolContext;

async function run(name: string, args: unknown): Promise<any> {
  const result = await runTool(byName(name), args, ctx);
  const text = (result.content[0] as { text: string }).text;
  if (result.isError) throw new Error(`${name} failed: ${text}`);
  return JSON.parse(text);
}

async function waitForMealie(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/app/about`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Mealie did not come up at ${BASE}. Run: npm run live:up`);
}

describe.skipIf(!LIVE)('live Mealie smoke test', () => {
  beforeAll(async () => {
    await waitForMealie(150_000);
    const login = await fetch(`${BASE}/api/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASSWORD }).toString(),
    });
    if (!login.ok) throw new Error(`login failed: ${login.status} ${await login.text()}`);
    const { access_token } = (await login.json()) as { access_token: string };
    const created = await fetch(`${BASE}/api/users/api-tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `live-${Date.now()}` }),
    });
    if (!created.ok) throw new Error(`token creation failed: ${created.status} ${await created.text()}`);
    const { token } = (await created.json()) as { token: string };
    ctx = { mealie: new MealieClient({ baseUrl: BASE, token }) };
  });

  it('whoami', async () => {
    const me = await run('mealie_whoami', {});
    expect(me.username).toBeTruthy();
    expect(me.household.name).toBeTruthy();
  });

  it('recipe lifecycle', async () => {
    const { slug } = await run('mealie_create_recipe', {
      name: `Live Soup ${Date.now()}`,
      description: 'Smoke test',
      cook_time: '30 minutes',
      ingredients: ['1 onion', '2 cups stock'],
      instructions: ['Chop the onion.', 'Simmer in stock.'],
      tags: ['live-test'],
      categories: ['Dinner'],
    });
    const recipe = await run('mealie_get_recipe', { slug });
    expect(recipe.ingredients).toHaveLength(2);
    expect(recipe.instructions[0]).toBe('1. Chop the onion.');
    expect(recipe.tags).toContain('live-test');

    const found = await run('mealie_search_recipes', { query: 'Live Soup' });
    expect(found.items.some((r: any) => r.slug === slug)).toBe(true);

    await run('mealie_update_recipe', { slug, rating: 4 });
    await run('mealie_mark_recipe_made', { slug, note: 'tasty' });
    await run('mealie_bulk_tag_recipes', { slugs: [slug], tags: ['bulk-live'] });
    const copy = await run('mealie_duplicate_recipe', { slug, new_name: `Copy ${Date.now()}` });
    await run('mealie_parse_ingredients', { ingredients: ['2 cups flour'] });
    await run('mealie_delete_recipe', { slug: copy.slug });
    await run('mealie_delete_recipe', { slug });
  });

  it('meal plan lifecycle', async () => {
    const { slug } = await run('mealie_create_recipe', { name: `Plan Recipe ${Date.now()}` });
    const entry = await run('mealie_add_mealplan_entry', { date: '2030-01-15', recipe_slug: slug });
    const free = await run('mealie_add_mealplan_entry', { date: '2030-01-15', entry_type: 'lunch', title: 'Leftovers' });
    const moved = await run('mealie_update_mealplan_entry', { id: entry.id, date: '2030-01-16' });
    expect(moved.date).toBe('2030-01-16');
    const list = await run('mealie_list_mealplans', { start_date: '2030-01-15', end_date: '2030-01-16' });
    expect(list.items.length).toBeGreaterThanOrEqual(2);
    await run('mealie_get_todays_meals', {});
    await run('mealie_delete_mealplan_entry', { id: entry.id });
    await run('mealie_delete_mealplan_entry', { id: free.id });
    await run('mealie_delete_recipe', { slug });
  });

  it('shopping lifecycle', async () => {
    const { slug } = await run('mealie_create_recipe', { name: `Shop Recipe ${Date.now()}`, ingredients: ['1 onion'] });
    const list = await run('mealie_create_shopping_list', { name: `Live ${Date.now()}` });
    await run('mealie_add_shopping_items', { list_id: list.id, items: [{ text: 'milk' }, { text: 'bread', quantity: 2 }] });
    await run('mealie_add_recipe_to_shopping_list', { list_id: list.id, recipes: [{ slug }] });
    const full = await run('mealie_get_shopping_list', { list_id: list.id });
    expect(full.items.length).toBeGreaterThanOrEqual(2);
    const first = full.items[0];
    await run('mealie_update_shopping_items', { list_id: list.id, updates: [{ id: first.id, checked: true }] });
    const after = await run('mealie_get_shopping_list', { list_id: list.id, include_checked: true });
    expect(after.items.find((i: any) => i.id === first.id).checked).toBe(true);
    await run('mealie_remove_recipe_from_shopping_list', { list_id: list.id, slug });
    await run('mealie_remove_shopping_items', { item_ids: [first.id] });
    await run('mealie_delete_shopping_list', { list_id: list.id });
    await run('mealie_delete_recipe', { slug });
  });

  it('catalog tools', async () => {
    const food = await run('mealie_upsert_food', { name: `livefood${Date.now()}` });
    await run('mealie_upsert_food', { id: food.id, description: 'updated' });
    const dup = await run('mealie_upsert_food', { name: `livedup${Date.now()}` });
    await run('mealie_merge_foods', { from_food_id: dup.id, to_food_id: food.id });
    expect((await run('mealie_list_foods', { search: 'livefood' })).items.length).toBeGreaterThanOrEqual(1);
    const unit = await run('mealie_upsert_unit', { name: `liveunit${Date.now()}`, abbreviation: 'lu' });
    await run('mealie_upsert_unit', { id: unit.id, description: 'updated' });
    await run('mealie_list_units', {});
    const tag = await run('mealie_upsert_organizer', { type: 'tags', name: `livetag${Date.now()}` });
    await run('mealie_upsert_organizer', { type: 'tags', id: tag.id, name: `${tag.name}-renamed` });
    await run('mealie_list_organizers', { type: 'tags' });
    await run('mealie_delete_organizer', { type: 'tags', id: tag.id });
    const book = await run('mealie_upsert_cookbook', { name: `Live Book ${Date.now()}` });
    await run('mealie_upsert_cookbook', { id: book.id, description: 'updated' });
    await run('mealie_list_cookbooks', {});
    await run('mealie_api_request', { method: 'DELETE', path: `/api/households/cookbooks/${book.id}` });
  });

  it('raw API request allows reads and blocks auth paths', async () => {
    const about = await run('mealie_api_request', { method: 'GET', path: '/api/app/about' });
    expect(about.version).toBeTruthy();
    await expect(run('mealie_api_request', { method: 'POST', path: '/api/users/api-tokens', body: { name: 'x' } })).rejects.toThrow(/blocked/);
  });

  it('suggestions endpoint answers (or reports it is unsupported)', async () => {
    await run('mealie_upsert_food', { name: 'onion' }).catch(() => undefined);
    const result = await runTool(byName('mealie_suggest_recipes'), { foods: ['onion'] }, ctx);
    const text = (result.content[0] as { text: string }).text;
    if (result.isError) expect(text).toMatch(/suggestions endpoint|None of these foods/);
  });
});
