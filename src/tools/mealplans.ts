import * as z from 'zod';
import { ToolInputError } from '../mealie/errors.js';
import { resolveRecipe } from './lookup.js';
import { compact, paging, toPage, type MealiePage } from './shape.js';
import { defineTool, DESTROY, READ, UPDATE, WRITE, type AnyToolDef } from './types.js';

const ENTRY_TYPES = ['breakfast', 'lunch', 'dinner', 'side', 'snack', 'drink', 'dessert'] as const;
const date = z.iso.date().describe('YYYY-MM-DD');
const entryType = z.enum(ENTRY_TYPES);
const ENTRY_HINT = 'Use mealie_list_mealplans to find entry ids.';
const SLUG_HINT = 'Use mealie_search_recipes to find the recipe slug.';

interface PlanEntry {
  id: number; date: string; entryType: string; title?: string | null; text?: string | null;
  recipeId?: string | null; recipe?: { slug: string; name: string } | null; groupId: string; userId: string;
}

function toEntry(e: PlanEntry) {
  return compact({
    id: e.id, date: e.date, type: e.entryType, title: e.title, note: e.text,
    recipe: e.recipe ? { slug: e.recipe.slug, name: e.recipe.name } : undefined,
  });
}

const listMealplans = defineTool({
  name: 'mealie_list_mealplans',
  title: 'List meal plan',
  description: 'List meal plan entries between two dates (inclusive), in date order.',
  inputSchema: z.object({ start_date: date, end_date: date, ...paging }),
  annotations: READ,
  async run(args, ctx) {
    if (args.end_date < args.start_date) throw new ToolInputError('end_date must be on or after start_date.');
    const raw = await ctx.mealie.get<MealiePage<PlanEntry>>('/api/households/mealplans', {
      start_date: args.start_date, end_date: args.end_date, orderBy: 'date', orderDirection: 'asc', page: args.page, perPage: args.per_page,
    });
    return toPage(raw, toEntry);
  },
});

const getTodaysMeals = defineTool({
  name: 'mealie_get_todays_meals',
  title: "Today's meals",
  description: "List today's meal plan entries for the household.",
  inputSchema: z.object({}),
  annotations: READ,
  async run(_args, ctx) {
    const entries = await ctx.mealie.get<PlanEntry[]>('/api/households/mealplans/today');
    return { items: (entries ?? []).map(toEntry) };
  },
});

const addMealplanEntry = defineTool({
  name: 'mealie_add_mealplan_entry',
  title: 'Add meal plan entry',
  description: 'Plan a recipe (by slug) or a free-text meal (by title) for a date and meal type.',
  inputSchema: z.object({
    date,
    entry_type: entryType.default('dinner'),
    recipe_slug: z.string().min(1).optional(),
    title: z.string().min(1).optional().describe('Free-text meal name when there is no recipe'),
    note: z.string().optional(),
  }),
  annotations: WRITE,
  notFoundHint: SLUG_HINT,
  async run(args, ctx) {
    if (!args.recipe_slug && !args.title) throw new ToolInputError('Provide recipe_slug, or a title for a free-text entry.');
    const recipeId = args.recipe_slug ? (await resolveRecipe(ctx, args.recipe_slug)).id : null;
    const created = await ctx.mealie.post<PlanEntry>('/api/households/mealplans', {
      date: args.date, entryType: args.entry_type, title: args.title ?? '', text: args.note ?? '', recipeId,
    });
    return toEntry(created);
  },
});

const updateMealplanEntry = defineTool({
  name: 'mealie_update_mealplan_entry',
  title: 'Update meal plan entry',
  description: 'Move or change a meal plan entry. Only the fields you pass change. Pass recipe_slug null to remove the recipe.',
  inputSchema: z.object({
    id: z.number().int().describe('Entry id from mealie_list_mealplans'),
    date: date.optional(),
    entry_type: entryType.optional(),
    recipe_slug: z.string().min(1).nullable().optional(),
    title: z.string().optional(),
    note: z.string().optional(),
  }),
  annotations: UPDATE,
  notFoundHint: ENTRY_HINT,
  async run(args, ctx) {
    const current = await ctx.mealie.get<PlanEntry>(`/api/households/mealplans/${args.id}`);
    let recipeId = current.recipeId ?? null;
    if (args.recipe_slug === null) recipeId = null;
    else if (args.recipe_slug) recipeId = (await resolveRecipe(ctx, args.recipe_slug)).id;
    const updated = await ctx.mealie.put<PlanEntry>(`/api/households/mealplans/${args.id}`, {
      id: current.id,
      groupId: current.groupId,
      userId: current.userId,
      date: args.date ?? current.date,
      entryType: args.entry_type ?? current.entryType,
      title: args.title ?? current.title ?? '',
      text: args.note ?? current.text ?? '',
      recipeId,
    });
    return toEntry(updated);
  },
});

const deleteMealplanEntry = defineTool({
  name: 'mealie_delete_mealplan_entry',
  title: 'Delete meal plan entry',
  description: 'Remove one entry from the meal plan.',
  inputSchema: z.object({ id: z.number().int() }),
  annotations: DESTROY,
  notFoundHint: ENTRY_HINT,
  async run(args, ctx) {
    await ctx.mealie.delete(`/api/households/mealplans/${args.id}`);
    return { deleted: args.id };
  },
});

const randomMealplanEntry = defineTool({
  name: 'mealie_random_mealplan_entry',
  title: 'Add random meal',
  description: "Let Mealie pick a random recipe for a date and meal type, honoring the household's meal plan rules.",
  inputSchema: z.object({ date, entry_type: entryType.default('dinner') }),
  annotations: WRITE,
  notFoundHint: 'Mealie found no recipe that matches the meal plan rules for that day and meal type.',
  async run(args, ctx) {
    return toEntry(await ctx.mealie.post<PlanEntry>('/api/households/mealplans/random', { date: args.date, entryType: args.entry_type }));
  },
});

export const mealplanTools: readonly AnyToolDef[] = [
  listMealplans, getTodaysMeals, addMealplanEntry, updateMealplanEntry, deleteMealplanEntry, randomMealplanEntry,
];
