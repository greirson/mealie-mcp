import * as z from 'zod';
import { ToolInputError } from '../mealie/errors.js';
import { compact, paging, seg, toPage, type MealiePage, type Named } from './shape.js';
import { defineTool, DESTROY, READ, UPDATE, WRITE, type AnyToolDef } from './types.js';

const enc = (id: string) => seg(id, 'id');
const search = z.string().optional().describe('Filter by name');
const organizerType = z.enum(['tags', 'categories', 'tools']).describe('Which organizer: tags, categories, or kitchen tools');

interface Food {
  id: string; name: string; pluralName?: string | null; description?: string | null; labelId?: string | null;
  label?: Named | null; aliases?: Array<{ name: string }> | null; householdsWithIngredientFood?: string[] | null;
  extras?: Record<string, unknown> | null; substitutions?: Array<{ substituteFoodId?: string | null; note?: string | null }> | null;
}
interface Unit {
  id: string; name: string; pluralName?: string | null; description?: string | null; abbreviation?: string | null;
  pluralAbbreviation?: string | null; useAbbreviation?: boolean; fraction?: boolean; aliases?: Array<{ name: string }> | null;
  standardQuantity?: number | null; standardUnit?: string | null; extras?: Record<string, unknown> | null;
}
interface Organizer { id: string; name: string; slug: string; householdsWithTool?: string[] | null }
interface Cookbook {
  id: string; name: string; slug: string; description?: string | null; position?: number;
  public?: boolean; queryFilterString?: string | null;
}

function requireName(name: string | undefined, what: string): string {
  if (!name) throw new ToolInputError(`name is required to create a ${what} (pass id to update an existing one).`);
  return name;
}

const listFoods = defineTool({
  name: 'mealie_list_foods',
  title: 'List foods',
  description: 'List ingredient foods known to Mealie (used for shopping list grouping and recipe suggestions).',
  inputSchema: z.object({ search, ...paging }),
  annotations: READ,
  async run(args, ctx) {
    const raw = await ctx.mealie.get<MealiePage<Food>>('/api/foods', {
      search: args.search, orderBy: 'name', orderDirection: 'asc', page: args.page, perPage: args.per_page,
    });
    return toPage(raw, (f) => compact({ id: f.id, name: f.name, pluralName: f.pluralName, description: f.description, label: f.label?.name }));
  },
});

const upsertFood = defineTool({
  name: 'mealie_upsert_food',
  title: 'Create or update food',
  description: 'Create a food, or update one by id. Only the fields you pass change on update.',
  inputSchema: z.object({
    id: z.string().optional().describe('Existing food id to update; omit to create'),
    name: z.string().min(1).optional(),
    plural_name: z.string().optional(),
    description: z.string().optional(),
  }),
  annotations: WRITE,
  notFoundHint: 'Use mealie_list_foods to find food ids.',
  async run(args, ctx) {
    if (!args.id) {
      const created = await ctx.mealie.post<Food>('/api/foods', {
        name: requireName(args.name, 'food'), pluralName: args.plural_name ?? null, description: args.description ?? '',
      });
      return { id: created.id, name: created.name };
    }
    const cur = await ctx.mealie.get<Food>(`/api/foods/${enc(args.id)}`);
    const updated = await ctx.mealie.put<Food>(`/api/foods/${enc(args.id)}`, {
      id: cur.id,
      name: args.name ?? cur.name,
      pluralName: args.plural_name ?? cur.pluralName ?? null,
      description: args.description ?? cur.description ?? '',
      labelId: cur.labelId ?? null,
      extras: cur.extras ?? {},
      aliases: cur.aliases ?? [],
      substitutions: cur.substitutions ?? [],
      householdsWithIngredientFood: cur.householdsWithIngredientFood ?? [],
    });
    return { id: updated.id, name: updated.name };
  },
});

const mergeFoods = defineTool({
  name: 'mealie_merge_foods',
  title: 'Merge foods',
  description: 'Merge a duplicate food into another: every reference moves to the target and the source is deleted. Confirm with the user first.',
  inputSchema: z.object({ from_food_id: z.string().min(1), to_food_id: z.string().min(1) }),
  annotations: DESTROY,
  notFoundHint: 'Use mealie_list_foods to find food ids.',
  async run(args, ctx) {
    await ctx.mealie.put('/api/foods/merge', { fromFood: args.from_food_id, toFood: args.to_food_id });
    return { merged: args.from_food_id, into: args.to_food_id };
  },
});

const listUnits = defineTool({
  name: 'mealie_list_units',
  title: 'List units',
  description: 'List measurement units known to Mealie.',
  inputSchema: z.object({ search, ...paging }),
  annotations: READ,
  async run(args, ctx) {
    const raw = await ctx.mealie.get<MealiePage<Unit>>('/api/units', {
      search: args.search, orderBy: 'name', orderDirection: 'asc', page: args.page, perPage: args.per_page,
    });
    return toPage(raw, (u) => compact({ id: u.id, name: u.name, pluralName: u.pluralName, abbreviation: u.abbreviation }));
  },
});

const upsertUnit = defineTool({
  name: 'mealie_upsert_unit',
  title: 'Create or update unit',
  description: 'Create a unit, or update one by id. Only the fields you pass change on update.',
  inputSchema: z.object({
    id: z.string().optional().describe('Existing unit id to update; omit to create'),
    name: z.string().min(1).optional(),
    plural_name: z.string().optional(),
    abbreviation: z.string().optional(),
    description: z.string().optional(),
  }),
  annotations: WRITE,
  notFoundHint: 'Use mealie_list_units to find unit ids.',
  async run(args, ctx) {
    if (!args.id) {
      const created = await ctx.mealie.post<Unit>('/api/units', {
        name: requireName(args.name, 'unit'), pluralName: args.plural_name ?? null, abbreviation: args.abbreviation ?? '', description: args.description ?? '',
      });
      return { id: created.id, name: created.name };
    }
    const cur = await ctx.mealie.get<Unit>(`/api/units/${enc(args.id)}`);
    const updated = await ctx.mealie.put<Unit>(`/api/units/${enc(args.id)}`, {
      id: cur.id,
      name: args.name ?? cur.name,
      pluralName: args.plural_name ?? cur.pluralName ?? null,
      description: args.description ?? cur.description ?? '',
      extras: cur.extras ?? {},
      abbreviation: args.abbreviation ?? cur.abbreviation ?? '',
      pluralAbbreviation: cur.pluralAbbreviation ?? null,
      useAbbreviation: cur.useAbbreviation ?? false,
      fraction: cur.fraction ?? true,
      aliases: cur.aliases ?? [],
      standardQuantity: cur.standardQuantity ?? null,
      standardUnit: cur.standardUnit ?? null,
    });
    return { id: updated.id, name: updated.name };
  },
});

const listOrganizers = defineTool({
  name: 'mealie_list_organizers',
  title: 'List tags, categories, or tools',
  description: 'List recipe tags, categories, or kitchen tools with the slugs used by mealie_search_recipes filters.',
  inputSchema: z.object({ type: organizerType, search, ...paging }),
  annotations: READ,
  async run(args, ctx) {
    const raw = await ctx.mealie.get<MealiePage<Organizer>>(`/api/organizers/${args.type}`, {
      search: args.search, orderBy: 'name', orderDirection: 'asc', page: args.page, perPage: args.per_page,
    });
    return toPage(raw, (o) => ({ id: o.id, name: o.name, slug: o.slug }));
  },
});

const upsertOrganizer = defineTool({
  name: 'mealie_upsert_organizer',
  title: 'Create or rename tag, category, or tool',
  description: 'Create a tag, category, or kitchen tool, or rename one by id.',
  inputSchema: z.object({ type: organizerType, id: z.string().optional().describe('Existing id to rename; omit to create'), name: z.string().min(1) }),
  annotations: UPDATE,
  notFoundHint: 'Use mealie_list_organizers to find ids.',
  async run(args, ctx) {
    const base = `/api/organizers/${args.type}`;
    if (!args.id) {
      const created = await ctx.mealie.post<Organizer>(base, { name: args.name });
      return { id: created.id, name: created.name, slug: created.slug };
    }
    const path = `${base}/${enc(args.id)}`;
    if (args.type === 'tools') {
      const cur = await ctx.mealie.get<Organizer>(path);
      const saved = await ctx.mealie.put<Organizer>(path, { name: args.name, householdsWithTool: cur.householdsWithTool ?? [] });
      return { id: saved.id, name: saved.name, slug: saved.slug };
    }
    const saved = await ctx.mealie.put<Organizer>(path, { name: args.name });
    return { id: saved.id, name: saved.name, slug: saved.slug };
  },
});

const deleteOrganizer = defineTool({
  name: 'mealie_delete_organizer',
  title: 'Delete tag, category, or tool',
  description: 'Delete a tag, category, or kitchen tool. Recipes keep existing but lose it. Confirm with the user first.',
  inputSchema: z.object({ type: organizerType, id: z.string().min(1) }),
  annotations: DESTROY,
  notFoundHint: 'Use mealie_list_organizers to find ids.',
  async run(args, ctx) {
    await ctx.mealie.delete(`/api/organizers/${args.type}/${enc(args.id)}`);
    return { deleted: args.id, type: args.type };
  },
});

const listCookbooks = defineTool({
  name: 'mealie_list_cookbooks',
  title: 'List cookbooks',
  description: 'List household cookbooks (saved recipe filters).',
  inputSchema: z.object({ ...paging }),
  annotations: READ,
  async run(args, ctx) {
    const raw = await ctx.mealie.get<MealiePage<Cookbook>>('/api/households/cookbooks', { page: args.page, perPage: args.per_page });
    return toPage(raw, (b) => compact({ id: b.id, name: b.name, slug: b.slug, description: b.description, filter: b.queryFilterString, public: b.public }));
  },
});

const upsertCookbook = defineTool({
  name: 'mealie_upsert_cookbook',
  title: 'Create or update cookbook',
  description: 'Create a cookbook, or update one by id. query_filter uses Mealie query filter syntax, e.g. tags.name IN ["quick"].',
  inputSchema: z.object({
    id: z.string().optional().describe('Existing cookbook id to update; omit to create'),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    query_filter: z.string().optional(),
    public: z.boolean().optional(),
  }),
  annotations: WRITE,
  notFoundHint: 'Use mealie_list_cookbooks to find cookbook ids.',
  async run(args, ctx) {
    if (!args.id) {
      const created = await ctx.mealie.post<Cookbook>('/api/households/cookbooks', {
        name: requireName(args.name, 'cookbook'), description: args.description ?? '', public: args.public ?? false, queryFilterString: args.query_filter ?? '',
      });
      return { id: created.id, name: created.name, slug: created.slug };
    }
    const path = `/api/households/cookbooks/${enc(args.id)}`;
    const cur = await ctx.mealie.get<Cookbook>(path);
    const updated = await ctx.mealie.put<Cookbook>(path, {
      name: args.name ?? cur.name,
      description: args.description ?? cur.description ?? '',
      slug: cur.slug,
      position: cur.position ?? 1,
      public: args.public ?? cur.public ?? false,
      queryFilterString: args.query_filter ?? cur.queryFilterString ?? '',
    });
    return { id: updated.id, name: updated.name, slug: updated.slug };
  },
});

export const catalogTools: readonly AnyToolDef[] = [
  listFoods, upsertFood, mergeFoods, listUnits, upsertUnit, listOrganizers, upsertOrganizer, deleteOrganizer, listCookbooks, upsertCookbook,
];
