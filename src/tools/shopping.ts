import * as z from 'zod';
import { ToolInputError } from '../mealie/errors.js';
import { findByName, resolveRecipe } from './lookup.js';
import { compact, paging, seg, toPage, type MealiePage, type Named } from './shape.js';
import { defineTool, DESTROY, READ, UPDATE, WRITE, type AnyToolDef } from './types.js';

const LIST_HINT = 'Use mealie_list_shopping_lists to find list ids.';
const listId = z.string().min(1).describe('Shopping list id (from mealie_list_shopping_lists)');
const listPath = (id: string) => `/api/households/shopping/lists/${seg(id, 'list_id')}`;

interface ListItem {
  id: string; shoppingListId: string; display?: string | null; note?: string | null; quantity?: number | null;
  checked: boolean; position?: number | null; foodId?: string | null; unitId?: string | null; labelId?: string | null;
  food?: Named | null; unit?: Named | null; label?: Named | null; recipeReferences?: unknown[] | null;
  extras?: Record<string, unknown> | null;
}

interface ShoppingList {
  id: string; name: string; listItems?: ListItem[] | null;
  recipeReferences?: Array<{ recipeId: string; recipeQuantity?: number | null; recipe?: { slug: string; name: string } | null }> | null;
}

function toItem(i: ListItem) {
  return compact({
    id: i.id, text: i.display || i.note || i.food?.name, quantity: i.quantity, unit: i.unit?.name, food: i.food?.name,
    note: i.note, checked: i.checked, label: i.label?.name,
  });
}

const listShoppingLists = defineTool({
  name: 'mealie_list_shopping_lists',
  title: 'List shopping lists',
  description: "List the household's shopping lists with their ids.",
  inputSchema: z.object({ ...paging }),
  annotations: READ,
  async run(args, ctx) {
    const raw = await ctx.mealie.get<MealiePage<ShoppingList>>('/api/households/shopping/lists', {
      page: args.page, perPage: args.per_page, orderBy: 'name', orderDirection: 'asc',
    });
    return toPage(raw, (l) => ({ id: l.id, name: l.name }));
  },
});

const getShoppingList = defineTool({
  name: 'mealie_get_shopping_list',
  title: 'Get shopping list',
  description: 'Get the items on a shopping list (unchecked only unless include_checked) and the recipes it was built from.',
  inputSchema: z.object({ list_id: listId, include_checked: z.boolean().default(false) }),
  annotations: READ,
  notFoundHint: LIST_HINT,
  async run(args, ctx) {
    const list = await ctx.mealie.get<ShoppingList>(listPath(args.list_id));
    const all = list.listItems ?? [];
    const visible = args.include_checked ? all : all.filter((i) => !i.checked);
    return {
      id: list.id,
      name: list.name,
      uncheckedCount: all.filter((i) => !i.checked).length,
      checkedCount: all.filter((i) => i.checked).length,
      items: visible.map(toItem),
      recipes: (list.recipeReferences ?? []).map((r) =>
        compact({ recipeId: r.recipeId, slug: r.recipe?.slug, name: r.recipe?.name, quantity: r.recipeQuantity })
      ),
    };
  },
});

const createShoppingList = defineTool({
  name: 'mealie_create_shopping_list',
  title: 'Create shopping list',
  description: 'Create a new, empty shopping list.',
  inputSchema: z.object({ name: z.string().min(1) }),
  annotations: WRITE,
  async run(args, ctx) {
    const list = await ctx.mealie.post<ShoppingList>('/api/households/shopping/lists', { name: args.name });
    return { id: list.id, name: list.name };
  },
});

const deleteShoppingList = defineTool({
  name: 'mealie_delete_shopping_list',
  title: 'Delete shopping list',
  description: 'Permanently delete a shopping list and its items. Confirm with the user first.',
  inputSchema: z.object({ list_id: listId }),
  annotations: DESTROY,
  notFoundHint: LIST_HINT,
  async run(args, ctx) {
    await ctx.mealie.delete(listPath(args.list_id));
    return { deleted: args.list_id };
  },
});

const addShoppingItems = defineTool({
  name: 'mealie_add_shopping_items',
  title: 'Add shopping items',
  description:
    'Add items to a shopping list. Give food and unit names to link Mealie foods (for grouping and merging); otherwise the text is stored as a note. Mealie merges duplicates into existing items.',
  inputSchema: z.object({
    list_id: listId,
    items: z
      .array(
        z.object({
          text: z.string().min(1).describe('What to buy as the user said it, e.g. "2 lb chicken thighs"'),
          quantity: z.number().positive().optional(),
          unit: z.string().optional().describe('Unit name, e.g. "cup"'),
          food: z.string().optional().describe('Food name, e.g. "milk"'),
          note: z.string().optional(),
        })
      )
      .min(1)
      .max(100),
  }),
  annotations: WRITE,
  notFoundHint: LIST_HINT,
  async run(args, ctx) {
    const body = [];
    for (const item of args.items) {
      const food = item.food ? await findByName(ctx, 'foods', item.food) : undefined;
      const unit = item.unit ? await findByName(ctx, 'units', item.unit) : undefined;
      const note = food ? (item.note ?? '') : item.note ? `${item.text} (${item.note})` : item.text;
      body.push({ shoppingListId: args.list_id, quantity: item.quantity ?? 1, note, foodId: food?.id ?? null, unitId: unit?.id ?? null, checked: false });
    }
    const res = await ctx.mealie.post<{ createdItems?: ListItem[] | null; updatedItems?: ListItem[] | null }>(
      '/api/households/shopping/items/create-bulk',
      body
    );
    return { created: res.createdItems?.length ?? 0, merged: res.updatedItems?.length ?? 0 };
  },
});

const updateShoppingItems = defineTool({
  name: 'mealie_update_shopping_items',
  title: 'Update shopping items',
  description: 'Check off, uncheck, or edit items on a shopping list. Item ids come from mealie_get_shopping_list.',
  inputSchema: z.object({
    list_id: listId,
    updates: z
      .array(z.object({ id: z.string().min(1), checked: z.boolean().optional(), quantity: z.number().positive().optional(), note: z.string().optional() }))
      .min(1)
      .max(100),
  }),
  annotations: UPDATE,
  notFoundHint: LIST_HINT,
  async run(args, ctx) {
    const list = await ctx.mealie.get<ShoppingList>(listPath(args.list_id));
    const byId = new Map((list.listItems ?? []).map((i) => [i.id, i]));
    const missing = args.updates.filter((u) => !byId.has(u.id)).map((u) => u.id);
    if (missing.length > 0) {
      throw new ToolInputError(`Items not found on list ${args.list_id}: ${missing.join(', ')}. Use mealie_get_shopping_list with include_checked=true to see item ids.`);
    }
    const body = args.updates.map((u) => {
      const cur = byId.get(u.id)!;
      return {
        id: cur.id,
        shoppingListId: cur.shoppingListId,
        checked: u.checked ?? cur.checked,
        quantity: u.quantity ?? cur.quantity ?? 1,
        note: u.note ?? cur.note ?? '',
        display: cur.display ?? '',
        position: cur.position ?? 0,
        foodId: cur.foodId ?? null,
        unitId: cur.unitId ?? null,
        labelId: cur.labelId ?? null,
        recipeReferences: cur.recipeReferences ?? [],
        extras: cur.extras ?? {},
      };
    });
    await ctx.mealie.put('/api/households/shopping/items', body);
    return { updated: body.length };
  },
});

const removeShoppingItems = defineTool({
  name: 'mealie_remove_shopping_items',
  title: 'Remove shopping items',
  description: 'Delete items from shopping lists by id. To mark bought, use mealie_update_shopping_items with checked=true instead.',
  inputSchema: z.object({ item_ids: z.array(z.string().min(1)).min(1).max(100) }),
  annotations: DESTROY,
  async run(args, ctx) {
    await ctx.mealie.delete('/api/households/shopping/items', { ids: args.item_ids });
    return { removed: args.item_ids.length };
  },
});

const addRecipeToShoppingList = defineTool({
  name: 'mealie_add_recipe_to_shopping_list',
  title: 'Add recipe ingredients to list',
  description: "Add one or more recipes' ingredients to a shopping list, optionally scaled (2 = double).",
  inputSchema: z.object({
    list_id: listId,
    recipes: z.array(z.object({ slug: z.string().min(1), scale: z.number().positive().default(1) })).min(1).max(30),
  }),
  annotations: WRITE,
  notFoundHint: `${LIST_HINT} Use mealie_search_recipes to find recipe slugs.`,
  async run(args, ctx) {
    const body = [];
    for (const r of args.recipes) body.push({ recipeId: (await resolveRecipe(ctx, r.slug)).id, recipeIncrementQuantity: r.scale });
    await ctx.mealie.post(`${listPath(args.list_id)}/recipe`, body);
    return { added: args.recipes.map((r) => ({ slug: r.slug, scale: r.scale })) };
  },
});

const removeRecipeFromShoppingList = defineTool({
  name: 'mealie_remove_recipe_from_shopping_list',
  title: 'Remove recipe from list',
  description: "Remove a recipe's ingredients from a shopping list (scale 1 removes one batch).",
  inputSchema: z.object({ list_id: listId, slug: z.string().min(1), scale: z.number().positive().default(1) }),
  annotations: DESTROY,
  notFoundHint: `${LIST_HINT} Use mealie_search_recipes to find recipe slugs.`,
  async run(args, ctx) {
    const recipe = await resolveRecipe(ctx, args.slug);
    await ctx.mealie.post(`${listPath(args.list_id)}/recipe/${seg(recipe.id, 'recipe id')}/delete`, { recipeDecrementQuantity: args.scale });
    return { removed: args.slug };
  },
});

export const shoppingTools: readonly AnyToolDef[] = [
  listShoppingLists, getShoppingList, createShoppingList, deleteShoppingList, addShoppingItems,
  updateShoppingItems, removeShoppingItems, addRecipeToShoppingList, removeRecipeFromShoppingList,
];
