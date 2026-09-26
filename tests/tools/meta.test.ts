import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { whoami } from '../../src/tools/meta.js';
import { call, MEALIE, USER } from '../helpers/mealie.js';
import { mswServer } from '../helpers/msw.js';

describe('mealie_whoami', () => {
  it('returns the user and household without token metadata', async () => {
    mswServer.use(
      http.get(`${MEALIE}/api/users/self`, () => HttpResponse.json(USER)),
      http.get(`${MEALIE}/api/households/self`, () => HttpResponse.json({ id: 'h-1', name: 'Home', slug: 'home', users: [] }))
    );
    const r = await call(whoami, {});
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({
      id: 'user-1',
      username: 'sam',
      fullName: 'Sam Cook',
      email: 'sam@example.com',
      admin: false,
      group: 'Family',
      household: { id: 'h-1', name: 'Home', slug: 'home' },
      permissions: { canOrganize: true, canManage: false },
    });
    expect(r.text).not.toContain('tokens');
  });
});
