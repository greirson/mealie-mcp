import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import { ToolInputError } from '../mealie/errors.js';
import { ensureOrganizers, findByName, recipePath, resolveRecipe } from './lookup.js';
import { compact, names, paging, toPage, type MealiePage, type Named } from './shape.js';
import { defineTool, DESTROY, READ, UPDATE, WRITE, type AnyToolDef, type ToolContext } from './types.js';

const SLUG_HINT = 'Use mealie_search_recipes to find the recipe slug.';
const slug = z.string().min(1).describe('Recipe slug, e.g. "chicken-tikka-masala" (from mealie_search_recipes)');

interface RecipeSummary {
  id: string; slug: string; name: string; description?: string | null; totalTime?: string | null;
  rating?: number | null; lastMade?: string | null; tags?: Named[] | null; recipeCategory?: Named[] | null;
}

interface RecipeFull extends RecipeSummary {
  recipeYield?: string | null; recipeServings?: number | null; prepTime?: string | null; performTime?: string | null;
  cookTime?: string | null; orgURL?: string | null; tools?: Named[] | null;
  recipeIngredient?: Array<{ title?: string | null; display?: string | null; note?: string | null }> | null;
  recipeInstructions?: Array<{ title?: string | null; text: string }> | null;
  notes?: Array<{ title?: string | null; text?: string | null }> | null;
  nutrition?: Record<string, unknown> | null;
}

function summarize(r: RecipeSummary) {
  return compact({
    slug: r.slug, name: r.name, description: r.description, totalTime: r.totalTime, rating: r.rating, lastMade: r.lastMade,
    tags: names(r.tags), categories: names(r.recipeCategory),
  });
}

function detail(r: RecipeFull) {
  return compact({
    id: r.id, slug: r.slug, name: r.name, description: r.description, yield: r.recipeYield, servings: r.recipeServings || undefined,
    prepTime: r.prepTime, cookTime: r.performTime ?? r.cookTime, totalTime: r.totalTime, rating: r.rating, lastMade: r.lastMade,
    sourceUrl: r.orgURL, tags: names(r.tags), categories: names(r.recipeCategory), tools: names(r.tools),
    ingredients: (r.recipeIngredient ?? []).map((i) => [i.title ? `[${i.title}]` : '', i.display || i.note || ''].filter(Boolean).join(' ')),
    instructions: (r.recipeInstructions ?? []).map((s, n) => `${n + 1}. ${s.title ? `${s.title}: ` : ''}${s.text}`),
    notes: (r.notes ?? []).map((n) => [n.title, n.text].filter(Boolean).join(': ')),
    nutrition: r.nutrition,
  });
}

const editableFields = {
  description: z.string().optional(),
  recipe_yield: z.string().optional().describe('Free text, e.g. "4 servings"'),
  servings: z.number().positive().optional(),
  prep_time: z.string().optional().describe('Free text, e.g. "15 minutes"'),
  cook_time: z.string().optional().describe('Free text, e.g. "40 minutes"'),
  total_time: z.string().optional(),
  ingredients: z.array(z.string().min(1)).optional().describe('One ingredient per entry as free text, e.g. "2 cups flour". Replaces the whole list.'),
  instructions: z.array(z.string().min(1)).optional().describe('One step per entry, in order. Replaces the whole list.'),
  tags: z.array(z.string().min(1)).optional().describe('Tag names; missing tags are created. Replaces the recipe tags.'),
  categories: z.array(z.string().min(1)).optional().describe('Category names; missing categories are created. Replaces the recipe categories.'),
  rating: z.number().min(0).max(5).optional(),
  source_url: z.url().optional(),
};

type EditableArgs = { [K in keyof typeof editableFields]?: z.infer<(typeof editableFields)[K]> };

async function buildRecipePatch(ctx: ToolContext, args: EditableArgs): Promise<Record<string, unknown>> {
  const patch: Record<string, unknown> = {};
  if (args.description !== undefined) patch.description = args.description;
  if (args.recipe_yield !== undefined) patch.recipeYield = args.recipe_yield;
  if (args.servings !== undefined) patch.recipeServings = args.servings;
  if (args.prep_time !== undefined) patch.prepTime = args.prep_time;
  // Mealie labels performTime as "Cook Time" in its UI.
  if (args.cook_time !== undefined) patch.performTime = args.cook_time;
  if (args.total_time !== undefined) patch.totalTime = args.total_time;
  if (args.rating !== undefined) patch.rating = args.rating;
  if (args.source_url !== undefined) patch.orgURL = args.source_url;
  if (args.ingredients) patch.recipeIngredient = args.ingredients.map((text) => ({ note: text, display: text, referenceId: randomUUID() }));
  if (args.instructions) {
    patch.recipeInstructions = args.instructions.map((text) => ({ id: randomUUID(), title: '', text, ingredientReferences: [] }));
  }
  if (args.tags) patch.tags = await ensureOrganizers(ctx, 'tags', args.tags);
  if (args.categories) patch.recipeCategory = await ensureOrganizers(ctx, 'categories', args.categories);
  return patch;
}

const searchRecipes = defineTool({
  name: 'mealie_search_recipes',
  title: 'Search recipes',
  description: 'Search recipes by text and filter by tag, category, tool, or food. Returns the slugs every other recipe tool needs.',
  inputSchema: z.object({
    query: z.string().optional().describe('Free-text search over names, descriptions, and ingredients'),
    tags: z.array(z.string()).optional().describe('Tag slugs or ids (see mealie_list_organizers)'),
    categories: z.array(z.string()).optional().describe('Category slugs or ids'),
    tools: z.array(z.string()).optional().describe('Kitchen tool slugs or ids'),
    foods: z.array(z.string()).optional().describe('Food ids (see mealie_list_foods)'),
    require_all: z.boolean().default(false).describe('Require every given tag/category/tool/food instead of any one'),
    order_by: z.enum(['name', 'createdAt', 'updatedAt', 'lastMade', 'rating', 'random']).default('name'),
    ...paging,
  }),
  annotations: READ,
  async run(args, ctx) {
    const raw = await ctx.mealie.get<MealiePage<RecipeSummary>>('/api/recipes', {
      search: args.query,
      tags: args.tags,
      categories: args.categories,
      tools: args.tools,
      foods: args.foods,
      requireAllTags: args.require_all,
      requireAllCategories: args.require_all,
      requireAllTools: args.require_all,
      requireAllFoods: args.require_all,
      orderBy: args.order_by,
      orderDirection: args.order_by === 'name' ? 'asc' : 'desc',
      paginationSeed: args.order_by === 'random' ? String(Date.now()) : undefined,
      page: args.page,
      perPage: args.per_page,
    });
    return toPage(raw, summarize);
  },
});

const getRecipe = defineTool({
  name: 'mealie_get_recipe',
  title: 'Get recipe',
  description: 'Get one recipe with ingredients, numbered instructions, notes, times, tags, and nutrition.',
  inputSchema: z.object({ slug }),
  annotations: READ,
  notFoundHint: SLUG_HINT,
  async run(args, ctx) {
    return detail(await ctx.mealie.get<RecipeFull>(recipePath(args.slug)));
  },
});

const createRecipe = defineTool({
  name: 'mealie_create_recipe',
  title: 'Create recipe',
  description: 'Create a recipe from structured fields. Ingredients and instructions are plain text lines. Returns the new slug.',
  inputSchema: z.object({ name: z.string().min(1), ...editableFields }),
  annotations: WRITE,
  async run(args, ctx) {
    const { name, ...fields } = args;
    const createdSlug = await ctx.mealie.post<string>('/api/recipes', { name });
    const patch = await buildRecipePatch(ctx, fields);
    if (Object.keys(patch).length === 0) return { slug: createdSlug, name };
    const updated = await ctx.mealie.patch<RecipeFull>(recipePath(createdSlug), patch);
    return { slug: updated.slug ?? createdSlug, name: updated.name ?? name };
  },
});

const importRecipeFromUrl = defineTool({
  name: 'mealie_import_recipe_from_url',
  title: 'Import recipe from URL',
  description: 'Have Mealie scrape a recipe web page and save it. Returns the new slug.',
  inputSchema: z.object({
    url: z.url(),
    include_tags: z.boolean().default(true).describe('Keep tags found on the page'),
  }),
  annotations: { ...WRITE, openWorldHint: true },
  async run(args, ctx) {
    const newSlug = await ctx.mealie.post<string>('/api/recipes/create/url', { url: args.url, includeTags: args.include_tags });
    return { slug: newSlug };
  },
});

const updateRecipe = defineTool({
  name: 'mealie_update_recipe',
  title: 'Update recipe',
  description: 'Change fields on an existing recipe. Only the fields you pass change. Renaming changes the slug; the new slug is returned.',
  inputSchema: z.object({ slug, name: z.string().min(1).optional(), ...editableFields }),
  annotations: UPDATE,
  notFoundHint: SLUG_HINT,
  async run(args, ctx) {
    const { slug: target, name, ...fields } = args;
    const patch = await buildRecipePatch(ctx, fields);
    if (name !== undefined) patch.name = name;
    if (Object.keys(patch).length === 0) throw new ToolInputError('Nothing to update: pass at least one field to change.');
    const updated = await ctx.mealie.patch<RecipeFull>(recipePath(target), patch);
    return { slug: updated.slug, name: updated.name };
  },
});

const deleteRecipe = defineTool({
  name: 'mealie_delete_recipe',
  title: 'Delete recipe',
  description: 'Permanently delete a recipe. Confirm with the user first.',
  inputSchema: z.object({ slug }),
  annotations: DESTROY,
  notFoundHint: SLUG_HINT,
  async run(args, ctx) {
    await ctx.mealie.delete(recipePath(args.slug));
    return { deleted: args.slug };
  },
});

const duplicateRecipe = defineTool({
  name: 'mealie_duplicate_recipe',
  title: 'Duplicate recipe',
  description: 'Copy a recipe, optionally under a new name. Returns the copy slug.',
  inputSchema: z.object({ slug, new_name: z.string().min(1).optional() }),
  annotations: WRITE,
  notFoundHint: SLUG_HINT,
  async run(args, ctx) {
    const copy = await ctx.mealie.post<RecipeFull>(`${recipePath(args.slug)}/duplicate`, { name: args.new_name ?? null });
    return { slug: copy.slug, name: copy.name };
  },
});

const suggestRecipes = defineTool({
  name: 'mealie_suggest_recipes',
  title: 'Suggest recipes from ingredients',
  description: 'Find recipes you can make with the foods you have. Reports which foods matched Mealie and what each recipe is missing.',
  inputSchema: z.object({
    foods: z.array(z.string().min(1)).min(1).max(30).describe('Food names you have, e.g. ["chicken", "rice"]'),
    max_missing_foods: z.number().int().min(0).max(20).default(3),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  annotations: READ,
  notFoundHint: 'This Mealie version has no recipe suggestions endpoint. Upgrade Mealie or use mealie_search_recipes with foods.',
  async run(args, ctx) {
    const matched: Array<{ id: string; name: string }> = [];
    const unmatched: string[] = [];
    for (const food of args.foods) {
      const hit = await findByName(ctx, 'foods', food);
      if (hit) matched.push(hit);
      else unmatched.push(food);
    }
    if (matched.length === 0) {
      throw new ToolInputError(`None of these foods exist in Mealie: ${unmatched.join(', ')}. Use mealie_list_foods to see known food names.`);
    }
    const res = await ctx.mealie.get<{ items: Array<{ recipe: RecipeSummary; missingFoods?: Named[] | null; missingTools?: Named[] | null }> }>(
      '/api/recipes/suggestions',
      { foods: matched.map((f) => f.id), maxMissingFoods: args.max_missing_foods, limit: args.limit, includeFoodsOnHand: true }
    );
    return {
      matchedFoods: matched.map((f) => f.name),
      unmatchedFoods: unmatched,
      suggestions: res.items.map((i) => ({ slug: i.recipe.slug, name: i.recipe.name, missingFoods: names(i.missingFoods), missingTools: names(i.missingTools) })),
    };
  },
});

const parseIngredients = defineTool({
  name: 'mealie_parse_ingredients',
  title: 'Parse ingredient lines',
  description: 'Split free-text ingredient lines into quantity, unit, food, and note using Mealie\'s parser. Does not save anything.',
  inputSchema: z.object({
    ingredients: z.array(z.string().min(1)).min(1).max(100),
    parser: z.enum(['nlp', 'brute', 'openai']).default('nlp'),
  }),
  annotations: READ,
  async run(args, ctx) {
    const parsed = await ctx.mealie.post<
      Array<{ input: string; confidence?: { average?: number | null } | null; ingredient: { quantity?: number | null; unit?: Named | null; food?: Named | null; note?: string | null } }>
    >('/api/parser/ingredients', { parser: args.parser, ingredients: args.ingredients });
    return parsed.map((p) =>
      compact({ input: p.input, quantity: p.ingredient.quantity, unit: p.ingredient.unit?.name, food: p.ingredient.food?.name, note: p.ingredient.note, confidence: p.confidence?.average })
    );
  },
});

const markRecipeMade = defineTool({
  name: 'mealie_mark_recipe_made',
  title: 'Mark recipe as made',
  description: 'Record that a recipe was cooked: sets its last-made date and adds a timeline entry with an optional note.',
  inputSchema: z.object({
    slug,
    made_at: z.iso.datetime({ offset: true }).optional().describe('ISO 8601 timestamp; defaults to now'),
    note: z.string().optional(),
  }),
  annotations: WRITE,
  notFoundHint: SLUG_HINT,
  async run(args, ctx) {
    const recipe = await resolveRecipe(ctx, args.slug);
    const timestamp = args.made_at ?? new Date().toISOString();
    await ctx.mealie.patch(`${recipePath(args.slug)}/last-made`, { timestamp });
    await ctx.mealie.post('/api/recipes/timeline/events', {
      recipeId: recipe.id,
      subject: 'Made this',
      eventType: 'info',
      eventMessage: args.note ?? null,
      timestamp,
    });
    return { slug: recipe.slug, lastMade: timestamp };
  },
});

const bulkTagRecipes = defineTool({
  name: 'mealie_bulk_tag_recipes',
  title: 'Tag many recipes',
  description: 'Add tags to many recipes at once. Missing tags are created.',
  inputSchema: z.object({
    slugs: z.array(slug).min(1).max(200),
    tags: z.array(z.string().min(1)).min(1).max(20).describe('Tag names'),
  }),
  annotations: UPDATE,
  notFoundHint: SLUG_HINT,
  async run(args, ctx) {
    const refs = await ensureOrganizers(ctx, 'tags', args.tags);
    await ctx.mealie.post('/api/recipes/bulk-actions/tag', { recipes: args.slugs, tags: refs });
    return { tagged: args.slugs.length, tags: refs.map((t) => t.name) };
  },
});

export const recipeTools: readonly AnyToolDef[] = [
  searchRecipes, getRecipe, createRecipe, importRecipeFromUrl, updateRecipe, deleteRecipe,
  duplicateRecipe, suggestRecipes, parseIngredients, markRecipeMade, bulkTagRecipes,
];
