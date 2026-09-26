import { describe, expect, it } from 'vitest';
import { compact, names, seg, toPage } from '../../src/tools/shape.js';

describe('compact', () => {
  it('drops noise keys, nulls, undefined, and empty strings recursively', () => {
    expect(
      compact({
        id: 'r1',
        name: 'Soup',
        groupId: 'g',
        householdId: 'h',
        createdAt: 'x',
        image: 'abc',
        tokens: [{ id: 1 }],
        description: '',
        rating: null,
        nested: { userId: 'u', keep: 0, flag: false },
      })
    ).toEqual({ id: 'r1', name: 'Soup', nested: { keep: 0, flag: false } });
  });

  it('keeps empty arrays', () => {
    expect(compact({ items: [], tags: [] })).toEqual({ items: [], tags: [] });
  });

  it('compacts inside arrays', () => {
    expect(compact([{ a: 1, groupId: 'g' }, { b: null }])).toEqual([{ a: 1 }, {}]);
  });
});

describe('toPage', () => {
  it('maps Mealie pagination to camelCase and maps items', () => {
    expect(toPage({ page: 2, per_page: 10, total: 11, total_pages: 2, items: [{ n: 1 }] }, (i) => i.n)).toEqual({
      page: 2,
      perPage: 10,
      total: 11,
      totalPages: 2,
      items: [1],
    });
  });
});

describe('names', () => {
  it('extracts non-empty names', () => {
    expect(names([{ name: 'a' }, { name: null }, {}])).toEqual(['a']);
    expect(names(undefined)).toEqual([]);
  });
});

describe('seg', () => {
  it('encodes an ordinary slug or id', () => {
    expect(seg('soup bowl')).toBe('soup%20bowl');
  });

  it('rejects a single dot segment, encoded or not', () => {
    expect(() => seg('.')).toThrow(/"\." or "\.\."/);
    expect(() => seg('%2e')).toThrow(/"\." or "\.\."/);
    expect(() => seg('%2E')).toThrow(/"\." or "\.\."/);
  });

  it('rejects a double dot segment, encoded or not', () => {
    expect(() => seg('..')).toThrow(/"\." or "\.\."/);
    expect(() => seg('%2e%2e')).toThrow(/"\." or "\.\."/);
    expect(() => seg('%2E%2E')).toThrow(/"\." or "\.\."/);
  });

  it('rejects an empty value', () => {
    expect(() => seg('')).toThrow(/must not be empty/);
  });

  it('does not reject a slug that merely contains dots', () => {
    expect(seg('a.b..c')).toBe('a.b..c');
  });
});
