import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { http, HttpResponse } from 'msw';
import * as z from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allTools } from '../../src/tools/index.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { MEALIE, mockMealieUser } from '../helpers/mealie.js';
import { mswServer } from '../helpers/msw.js';
import { fullLogin } from '../helpers/oauth.js';

// Keywords a stricter function-calling schema parser (notably Gemini's) is known to reject or
// mishandle. None of these should ever appear in an advertised tool inputSchema.
const FORBIDDEN_KEYS = ['$schema', '$id', '$ref', '$defs', 'definitions', 'exclusiveMinimum', 'exclusiveMaximum', 'propertyNames', 'format'];

const SAFE_INT_MIN = -9007199254740991;
const SAFE_INT_MAX = 9007199254740991;

let app: TestApp;
beforeEach(async () => {
  app = await startTestApp();
  mockMealieUser();
  mswServer.use(http.get(`${MEALIE}/api/households/self`, () => HttpResponse.json({ id: 'h-1', name: 'Home', slug: 'home' })));
});
afterEach(async () => {
  await app.close();
});

async function connect(accessToken: string): Promise<Client> {
  const client = new Client({ name: 'schema-e2e', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', app.baseUrl), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } })
  );
  return client;
}

/** Fetches the raw tools/list response body, so byte size reflects exactly what is on the wire. */
async function rawToolsList(accessToken: string): Promise<string> {
  const res = await fetch(`${app.baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const text = await res.text();
  // Streamable HTTP responds with a single `data:` SSE frame for a one-shot JSON-RPC call.
  const jsonLine = text.split('\n').find((line) => line.startsWith('data:')) ?? text;
  return jsonLine.replace(/^data:\s*/, '').trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walks a JSON Schema tree the same way a schema consumer would (into `properties` values, array
 * `items`, an object-valued `additionalProperties`, and `anyOf`/`oneOf`/`allOf` branches), asserting
 * the portable-schema rules hold at every schema node - not just the top level of each tool.
 */
function assertPortable(node: unknown, path: string): void {
  if (!isPlainObject(node)) return;

  for (const key of FORBIDDEN_KEYS) {
    expect(node, `${path} must not contain "${key}"`).not.toHaveProperty(key);
  }
  expect(node.minimum, `${path}.minimum must not be the safe-integer lower bound`).not.toBe(SAFE_INT_MIN);
  expect(node.maximum, `${path}.maximum must not be the safe-integer upper bound`).not.toBe(SAFE_INT_MAX);

  const hasShape = 'type' in node || 'enum' in node || 'anyOf' in node;
  expect(hasShape, `${path} must declare type, enum, or anyOf: ${JSON.stringify(node)}`).toBe(true);

  if (typeof node.pattern === 'string') {
    // The pre-simplification leap-year date/date-time regexes ran to ~150-300 chars. A short
    // YYYY-MM-DD pattern (the only pattern this server still emits) is 15 chars, so a generous
    // ceiling here catches any long generated pattern sneaking back in without hardcoding one.
    expect(node.pattern.length, `${path}.pattern looks like an unshortened date/date-time regex`).toBeLessThan(40);
  }

  if (isPlainObject(node.properties)) {
    for (const [propName, propSchema] of Object.entries(node.properties)) assertPortable(propSchema, `${path}.properties.${propName}`);
  }
  if (isPlainObject(node.additionalProperties)) assertPortable(node.additionalProperties, `${path}.additionalProperties`);
  if (node.items !== undefined) {
    if (Array.isArray(node.items)) node.items.forEach((item, i) => assertPortable(item, `${path}.items[${i}]`));
    else assertPortable(node.items, `${path}.items`);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) branches.forEach((branch, i) => assertPortable(branch, `${path}.${key}[${i}]`));
  }
}

/** Reproduces what the MCP SDK would have advertised before this change: a plain
 * `z.toJSONSchema(schema, {target, io})` conversion with no post-processing. */
function legacyByteSize(): number {
  const tools = allTools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: { type: 'object', ...z.toJSONSchema(tool.inputSchema, { target: 'draft-2020-12', io: 'input' }) },
    annotations: { title: tool.title, ...tool.annotations },
  }));
  return Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
}

describe('portable tool schemas', () => {
  it('advertises no forbidden keywords, safe-int noise, or shapeless nodes for any tool', async () => {
    const { accessToken } = await fullLogin(app.baseUrl, 'good-token');
    const client = await connect(accessToken);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(30);
    for (const tool of tools) assertPortable(tool.inputSchema, tool.name);
    await client.close();
  });

  it('shrinks the tools/list payload versus the unsimplified zod-to-JSON-Schema conversion', async () => {
    const { accessToken } = await fullLogin(app.baseUrl, 'good-token');
    const after = Buffer.byteLength(await rawToolsList(accessToken), 'utf8');
    const before = legacyByteSize();
    // Purely informational beyond the regression guard: the two numbers land in the test output
    // via this message so `npm test` output can be quoted directly (before was 28308 bytes/38
    // tools at the time this test was written; `before` here is measured live so it never drifts).
    expect(after, `tools/list is now ${after} bytes, versus ${before} bytes unsimplified`).toBeLessThan(before);
    expect(after / before, `only shrank to ${((after / before) * 100).toFixed(1)}% of the unsimplified size`).toBeLessThan(0.9);
  });

  it('keeps the short date pattern and drops format on every date field', async () => {
    const { accessToken } = await fullLogin(app.baseUrl, 'good-token');
    const client = await connect(accessToken);
    const { tools } = await client.listTools();
    const mealplan = tools.find((t) => t.name === 'mealie_list_mealplans')!;
    const schema = mealplan.inputSchema as { properties: Record<string, any> };
    expect(schema.properties.start_date).toEqual({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' });
    expect(schema.properties.end_date).toEqual({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' });
    await client.close();
  });

  it('drops format on the mark-recipe-made timestamp while keeping its description', async () => {
    const { accessToken } = await fullLogin(app.baseUrl, 'good-token');
    const client = await connect(accessToken);
    const { tools } = await client.listTools();
    const markMade = tools.find((t) => t.name === 'mealie_mark_recipe_made')!;
    const schema = markMade.inputSchema as { properties: Record<string, any> };
    expect(schema.properties.made_at).toEqual({ type: 'string', description: 'ISO 8601 timestamp; defaults to now' });
    await client.close();
  });

  it('drops format on URL fields and still tells the model they are URLs', async () => {
    const { accessToken } = await fullLogin(app.baseUrl, 'good-token');
    const client = await connect(accessToken);
    const { tools } = await client.listTools();
    const importFromUrl = tools.find((t) => t.name === 'mealie_import_recipe_from_url')!;
    const schema = importFromUrl.inputSchema as { properties: Record<string, any> };
    expect(schema.properties.url).toEqual({ type: 'string', description: 'URL' });
    await client.close();
  });

  it('turns exclusiveMinimum into minimum for positive-number fields', async () => {
    const { accessToken } = await fullLogin(app.baseUrl, 'good-token');
    const client = await connect(accessToken);
    const { tools } = await client.listTools();
    const addItems = tools.find((t) => t.name === 'mealie_add_shopping_items')!;
    const schema = addItems.inputSchema as { properties: { items: { items: { properties: Record<string, any> } } } };
    expect(schema.properties.items.items.properties.quantity).toEqual({ type: 'number', minimum: 0 });
    await client.close();
  });

  it('drops safe-integer noise but keeps the real bound on paging fields', async () => {
    const { accessToken } = await fullLogin(app.baseUrl, 'good-token');
    const client = await connect(accessToken);
    const { tools } = await client.listTools();
    const listMealplans = tools.find((t) => t.name === 'mealie_list_mealplans')!;
    const schema = listMealplans.inputSchema as { properties: Record<string, any> };
    expect(schema.properties.page).toEqual({ type: 'integer', minimum: 1, default: 1, description: '1-based page number' });
    const deleteEntry = tools.find((t) => t.name === 'mealie_delete_mealplan_entry')!;
    const idSchema = (deleteEntry.inputSchema as { properties: Record<string, any> }).properties.id;
    expect(idSchema).toEqual({ type: 'integer' });
    await client.close();
  });

  it('turns the raw mealie_api_request body into anyOf object/array and keeps a simplified query map', async () => {
    const { accessToken } = await fullLogin(app.baseUrl, 'good-token');
    const client = await connect(accessToken);
    const { tools } = await client.listTools();
    const apiRequest = tools.find((t) => t.name === 'mealie_api_request')!;
    const schema = apiRequest.inputSchema as { properties: Record<string, any> };
    expect(schema.properties.body).toEqual({
      anyOf: [{ type: 'object' }, { type: 'array' }],
      description: 'JSON body for POST, PUT, or PATCH',
    });
    expect(schema.properties.query.additionalProperties).toBeDefined();
    expect(schema.properties.query.propertyNames).toBeUndefined();
    await client.close();
  });
});
