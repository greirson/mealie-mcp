import { seg, type MealiePage } from './shape.js';
import type { ToolContext } from './types.js';

export type OrganizerType = 'tags' | 'categories' | 'tools';

export interface OrganizerRef {
  id: string;
  name: string;
  slug: string;
}

export function recipePath(slug: string): string {
  return `/api/recipes/${seg(slug, 'slug')}`;
}

export async function resolveRecipe(ctx: ToolContext, slug: string): Promise<{ id: string; slug: string; name: string }> {
  const recipe = await ctx.mealie.get<{ id: string; slug: string; name: string }>(recipePath(slug));
  return { id: recipe.id, slug: recipe.slug, name: recipe.name };
}

/** Resolves organizer names to existing records, creating any that do not exist yet. */
export async function ensureOrganizers(ctx: ToolContext, type: OrganizerType, names: string[]): Promise<OrganizerRef[]> {
  const refs: OrganizerRef[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    const page = await ctx.mealie.get<MealiePage<OrganizerRef>>(`/api/organizers/${type}`, { search: name, perPage: 50 });
    const existing = page.items.find((o) => o.name.toLowerCase() === name.toLowerCase());
    const ref = existing ?? (await ctx.mealie.post<OrganizerRef>(`/api/organizers/${type}`, { name }));
    refs.push({ id: ref.id, name: ref.name, slug: ref.slug });
  }
  return refs;
}

interface CatalogItem {
  id: string;
  name: string;
  pluralName?: string | null;
  abbreviation?: string | null;
}

export async function findByName(ctx: ToolContext, collection: 'foods' | 'units', name: string): Promise<{ id: string; name: string } | undefined> {
  const wanted = name.trim().toLowerCase();
  const page = await ctx.mealie.get<MealiePage<CatalogItem>>(`/api/${collection}`, { search: name.trim(), perPage: 50 });
  const hit = page.items.find((i) => [i.name, i.pluralName, i.abbreviation].some((v) => v?.toLowerCase() === wanted));
  return hit ? { id: hit.id, name: hit.name } : undefined;
}
