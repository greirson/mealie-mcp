import { http, HttpResponse } from 'msw';
import { MealieClient } from '../../src/mealie/client.js';
import { runTool, type AnyToolDef, type ToolContext } from '../../src/tools/types.js';
import { mswServer } from './msw.js';

export const MEALIE = 'http://mealie.test';

export const USER = {
  id: 'user-1',
  username: 'sam',
  fullName: 'Sam Cook',
  email: 'sam@example.com',
  admin: false,
  group: 'Family',
  household: 'Home',
  groupId: 'g-1',
  householdId: 'h-1',
  canOrganize: true,
  canManage: false,
  tokens: [{ id: 1, name: 'mcp' }],
};

export function mockMealieUser(token = 'good-token', user = USER): void {
  mswServer.use(
    http.get(`${MEALIE}/api/users/self`, ({ request }) =>
      request.headers.get('authorization') === `Bearer ${token}`
        ? HttpResponse.json(user)
        : HttpResponse.json({ detail: 'Unauthorized' }, { status: 401 })
    )
  );
}

export interface MintedTokenRequest { authorization: string | null; name: string }

/**
 * Mocks the "sign in with your Mealie session" flow: /api/users/self accepts the given JWT
 * (a stand-in for the mealie.access_token cookie) or the token that gets minted, and
 * /api/users/api-tokens mints that token, recording each request it receives.
 */
export function mockMealieSession(jwt: string, mintedToken: string, user = USER): MintedTokenRequest[] {
  const requests: MintedTokenRequest[] = [];
  mswServer.use(
    http.get(`${MEALIE}/api/users/self`, ({ request }) => {
      const auth = request.headers.get('authorization');
      return auth === `Bearer ${jwt}` || auth === `Bearer ${mintedToken}`
        ? HttpResponse.json(user)
        : HttpResponse.json({ detail: 'Unauthorized' }, { status: 401 });
    }),
    http.post(`${MEALIE}/api/users/api-tokens`, async ({ request }) => {
      const authorization = request.headers.get('authorization');
      const body = (await request.json()) as { name: string };
      requests.push({ authorization, name: body.name });
      if (authorization !== `Bearer ${jwt}`) return HttpResponse.json({ detail: 'Unauthorized' }, { status: 401 });
      return HttpResponse.json({ id: 1, name: body.name, token: mintedToken }, { status: 201 });
    })
  );
  return requests;
}

export function testCtx(): ToolContext {
  return { mealie: new MealieClient({ baseUrl: MEALIE, token: 'tok', timeoutMs: 500, retryDelayMs: 0 }) };
}

export async function call(tool: AnyToolDef, args: unknown): Promise<{ isError: boolean; text: string; data: any }> {
  const result = await runTool(tool, args, testCtx());
  const text = (result.content[0] as { type: 'text'; text: string }).text;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { isError: result.isError === true, text, data };
}
