import * as z from 'zod';
import { ToolInputError } from '../mealie/errors.js';

const NOISE_KEYS = new Set([
  'groupId', 'householdId', 'userId', 'createdAt', 'updatedAt', 'update_at', 'dateAdded', 'dateUpdated',
  'image', 'cacheKey', 'tokens', 'groupSlug', 'householdSlug', 'extras',
]);

/** Removes fields that cost context without helping the model. Empty arrays are kept on purpose. */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (NOISE_KEYS.has(key) || v === null || v === undefined || v === '') continue;
    out[key] = compact(v);
  }
  return out;
}

export interface MealiePage<T> { page: number; per_page: number; total: number; total_pages: number; items: T[] }
export interface Page<T> { page: number; perPage: number; total: number; totalPages: number; items: T[] }

export function toPage<T, R>(raw: MealiePage<T>, map: (item: T) => R): Page<R> {
  return { page: raw.page, perPage: raw.per_page, total: raw.total, totalPages: raw.total_pages, items: raw.items.map(map) };
}

export const paging = {
  page: z.number().int().min(1).default(1).describe('1-based page number'),
  per_page: z.number().int().min(1).max(100).default(20).describe('Items per page, max 100'),
};

export interface Named { name?: string | null }

export function names(list: Named[] | null | undefined): string[] {
  return (list ?? []).map((i) => i.name).filter((n): n is string => typeof n === 'string' && n.length > 0);
}

/**
 * Encodes a single Mealie path segment (a slug or id), refusing values that would let it address a
 * different endpoint once Mealie's client builds the request with `new URL(base + path)`. plain
 * `encodeURIComponent` leaves "." and ".." unescaped (they are unreserved characters), and the WHATWG
 * URL parser then collapses them as dot-segments, re-rooting the request one or more levels up. A
 * percent-encoded value such as "%2e" is compared after one decode, since the URL parser's own
 * dot-segment removal treats "%2e"/"%2E" as equivalent to a literal dot.
 */
export function seg(value: string, what = 'id'): string {
  if (!value) throw new ToolInputError(`${what} must not be empty.`);
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding: fall through to compare the raw value below.
  }
  if (value === '.' || value === '..' || decoded === '.' || decoded === '..') {
    throw new ToolInputError(`${what} must not be "." or "..".`);
  }
  return encodeURIComponent(value);
}
