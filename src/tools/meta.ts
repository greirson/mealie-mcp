import * as z from 'zod';
import { defineTool, READ } from './types.js';

interface UserOut {
  id: string; username: string; fullName?: string | null; email: string; admin: boolean;
  group?: string | null; canOrganize?: boolean; canManage?: boolean;
}
interface HouseholdOut { id: string; name: string; slug: string }

export const whoami = defineTool({
  name: 'mealie_whoami',
  title: 'Who am I in Mealie',
  description: 'Show the Mealie user and household this connection acts as, and their permissions. Use to confirm identity before making changes.',
  inputSchema: z.object({}),
  annotations: READ,
  async run(_args, ctx) {
    const [user, household] = await Promise.all([
      ctx.mealie.get<UserOut>('/api/users/self'),
      ctx.mealie.get<HouseholdOut>('/api/households/self'),
    ]);
    return {
      id: user.id,
      username: user.username,
      fullName: user.fullName ?? undefined,
      email: user.email,
      admin: user.admin,
      group: user.group ?? undefined,
      household: { id: household.id, name: household.name, slug: household.slug },
      permissions: { canOrganize: user.canOrganize ?? false, canManage: user.canManage ?? false },
    };
  },
});
