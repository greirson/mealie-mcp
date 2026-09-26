import { describe, expect, it } from 'vitest';
import { allTools } from '../../src/tools/index.js';

describe('tool catalog', () => {
  it('has 38 uniquely named mealie_ tools', () => {
    const names = allTools.map((t) => t.name);
    expect(names).toHaveLength(38);
    expect(new Set(names).size).toBe(38);
    for (const n of names) expect(n).toMatch(/^mealie_[a-z_]+$/);
  });

  it('marks every delete, remove, merge, and raw API tool as destructive', () => {
    for (const t of allTools) {
      if (/_(delete|remove|merge)_|_api_request$/.test(t.name)) expect(t.annotations.destructiveHint, t.name).toBe(true);
    }
  });

  it('never marks a read-only tool destructive and gives every tool a description', () => {
    for (const t of allTools) {
      if (t.annotations.readOnlyHint) expect(t.annotations.destructiveHint, t.name).toBe(false);
      expect(t.description.length, t.name).toBeGreaterThan(20);
    }
  });
});
