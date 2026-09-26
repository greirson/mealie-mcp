import * as z from 'zod';
import type { HttpMethod } from '../mealie/client.js';
import { ToolInputError } from '../mealie/errors.js';
import { compact } from './shape.js';
import { defineTool, type AnyToolDef } from './types.js';

// Recipe text is untrusted input to Claude. These prefixes could mint credentials, change passwords,
// or reach admin functions if a prompt injection steered the raw API tool, so they are never forwarded.
// Household invitations mint invite tokens that let an outside party register into the household, and
// household permissions can grant that new account (or any existing member) manage/invite/organize
// rights, so both are credential-minting surfaces just like /api/admin, /api/auth, and /api/users.
const DENIED_PREFIXES = ['/api/admin', '/api/auth', '/api/users', '/api/households/invitations', '/api/households/permissions'];

// ASCII control characters, including tab (\t), LF (\n) and CR (\r). The WHATWG URL parser silently
// strips these from a URL string before it does anything else, so a decoded path containing one would
// be checked against the denylist as one string but requested as a different, shorter one. Refuse them
// once they surface (i.e. after decoding, since a percent-encoded control character like %09 is only a
// control character once decoded).
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function fullyDecode(path: string): string {
  let current = path;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      throw new ToolInputError('Path contains invalid percent-encoding.');
    }
    if (next === current) return current;
    current = next;
  }
  // Still changing after the iteration limit: returning this value would forward a string that may
  // still be percent-encoded (e.g. a ".." hidden behind several layers of "%25" that would fully
  // resolve on one more decode), silently missing the checks below. Refuse instead of guessing.
  throw new ToolInputError('Path is encoded too many times.');
}

export function checkApiPath(method: HttpMethod, rawPath: string): string {
  if (/[?#]/.test(rawPath)) throw new ToolInputError('Put query parameters in "query", not in "path".');
  if (!rawPath.toLowerCase().startsWith('/api/')) throw new ToolInputError('path must start with /api/ (for example /api/recipes).');
  const decoded = fullyDecode(rawPath);
  if (CONTROL_CHAR_RE.test(decoded)) throw new ToolInputError('Path contains control characters.');
  if (decoded.includes('\\')) throw new ToolInputError('Path must not contain a backslash.');
  const segments = decoded.split('/');
  if (segments.includes('..') || segments.includes('.')) {
    throw new ToolInputError('Path must not contain "." or ".." segments.');
  }
  if (decoded.includes('//')) throw new ToolInputError('Path must not contain "//".');
  if (/[?#]/.test(decoded)) throw new ToolInputError('Put query parameters in "query", not in "path".');

  // Defense in depth: MealieClient.buildUrl sends `new URL(baseUrl + decoded)`, and the WHATWG URL
  // parser canonicalizes its own way (collapsing dot-segments, including percent-encoded ones the
  // checks above may not anticipate). Run the denylist against that canonical pathname too, so the
  // request Mealie actually receives can never fall outside what was checked here.
  let resolvedPath: string;
  try {
    resolvedPath = new URL(`http://mealie-api-request.invalid${decoded}`).pathname;
  } catch {
    throw new ToolInputError('Path could not be parsed.');
  }

  const normalized = decoded.toLowerCase().replace(/\/+$/, '');
  const resolvedNormalized = resolvedPath.toLowerCase().replace(/\/+$/, '');
  if (method === 'GET' && normalized === '/api/users/self') return decoded;
  for (const prefix of DENIED_PREFIXES) {
    if (
      normalized === prefix ||
      normalized.startsWith(`${prefix}/`) ||
      resolvedNormalized === prefix ||
      resolvedNormalized.startsWith(`${prefix}/`)
    ) {
      throw new ToolInputError(
        `${prefix} is blocked for mealie_api_request because it can create credentials, change passwords, or reach admin functions. Use the Mealie web UI for this.`
      );
    }
  }
  return decoded;
}

const queryValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]);

export const apiRequest: AnyToolDef = defineTool({
  name: 'mealie_api_request',
  title: 'Raw Mealie API request',
  description:
    'Call any Mealie REST endpoint as the connected user, for features without a dedicated tool (webhooks, meal plan rules, comments). ' +
    'Prefer the dedicated mealie_ tools. Admin, auth, user-account, household-invitation, and household-permission endpoints are blocked. ' +
    'See /openapi.json on the Mealie server for endpoints.',
  inputSchema: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    path: z.string().min(5).describe('Path starting with /api/, without a query string'),
    query: z.record(z.string(), queryValue).optional(),
    body: z.unknown().optional().describe('JSON body for POST, PUT, or PATCH'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  async run(args, ctx) {
    const path = checkApiPath(args.method, args.path);
    const result = await ctx.mealie.request({ method: args.method, path, query: args.query, body: args.body });
    return result === undefined ? { ok: true } : compact(result);
  },
});
