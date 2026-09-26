import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import * as z from 'zod';

/**
 * Draft targeted for every conversion. Matches the MCP SDK's own default so the shapes it expects
 * at the root (an object schema) line up with what zod emits before this module simplifies it.
 */
const JSON_SCHEMA_TARGET = 'draft-2020-12';

// z.int() adds these bounds to every unbounded integer field. They describe what a JS number can
// hold, not anything about the tool's actual domain, so they are pure noise once advertised.
const SAFE_INT_MIN = -9007199254740991;
const SAFE_INT_MAX = 9007199254740991;

const SHORT_DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$';

type JsonSchemaNode = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Appends `(<label>)` to a description unless it already mentions `keyword`, so dropping `format`
 * never leaves a field with no hint of what shape the model should send. */
function ensureMentions(description: unknown, keyword: string, label: string): string {
  const text = typeof description === 'string' ? description : undefined;
  if (text && text.toLowerCase().includes(keyword)) return text;
  return text ? `${text} (${label})` : label;
}

/**
 * Resolves every `$ref` against `$defs`/`definitions` and returns a fully inlined copy. None of
 * this server's tool schemas currently produce refs (each tool is converted independently and no
 * schema is repeated within one tool's shape), but stricter clients reject `$ref` outright, so this
 * stays in place as a safety net rather than an assumption the input is already ref-free.
 * Unresolvable or cyclic refs are left as-is rather than guessed at.
 */
function inlineRefs(root: JsonSchemaNode): JsonSchemaNode {
  const defs = (root.$defs ?? root.definitions ?? {}) as JsonSchemaNode;
  if (Object.keys(defs).length === 0) return root;

  const refPattern = /^#\/(?:\$defs|definitions)\/(.+)$/;

  function resolve(node: unknown, seen: ReadonlySet<string>): unknown {
    if (Array.isArray(node)) return node.map((n) => resolve(n, seen));
    if (!isPlainObject(node)) return node;
    const ref = node.$ref;
    if (typeof ref === 'string') {
      const match = refPattern.exec(ref);
      const defName = match?.[1];
      if (defName !== undefined && defs[defName] !== undefined && !seen.has(defName)) {
        const { $ref: _drop, ...rest } = node;
        const resolved = resolve(defs[defName], new Set(seen).add(defName));
        return isPlainObject(resolved) ? { ...resolved, ...rest } : resolved;
      }
      return node;
    }
    const out: JsonSchemaNode = {};
    for (const [key, value] of Object.entries(node)) out[key] = resolve(value, seen);
    return out;
  }

  const resolved = resolve(root, new Set()) as JsonSchemaNode;
  delete resolved.$defs;
  delete resolved.definitions;
  return resolved;
}

/** Rewrites a draft-2020-12 multi-value `type` array (zod's shorthand for a union of primitives)
 * into an equivalent `anyOf`, since stricter function-calling parsers expect one string per node. */
function splitMultiType(node: JsonSchemaNode): void {
  if (!Array.isArray(node.type)) return;
  const types = node.type;
  const { type: _drop, ...rest } = node;
  for (const key of Object.keys(node)) delete node[key];
  Object.assign(node, rest, { anyOf: types.map((t) => ({ type: t })) });
}

/** Every property schema must carry `type`, `enum`, or `anyOf` (rule 6). `z.unknown()`/`z.any()`
 * convert to an empty `{}`, which satisfies none of those, so it becomes the two shapes a JSON body
 * actually takes on the wire. Mealie's bulk endpoints (e.g. shopping item create/update) post a JSON
 * array rather than an object, so both must stay representable. */
function widenUnconstrained(node: JsonSchemaNode): void {
  const hasShape = 'type' in node || 'enum' in node || 'anyOf' in node || 'oneOf' in node || 'allOf' in node || 'const' in node || '$ref' in node;
  if (hasShape) return;
  const description = typeof node.description === 'string' ? node.description : undefined;
  for (const key of Object.keys(node)) delete node[key];
  node.anyOf = [{ type: 'object' }, { type: 'array' }];
  if (description) node.description = description;
}

function simplifyNode(node: JsonSchemaNode): void {
  delete node.$schema;
  delete node.$id;
  delete node.$defs;
  delete node.definitions;
  delete node.propertyNames;

  if (typeof node.exclusiveMinimum === 'number') node.minimum = node.exclusiveMinimum;
  delete node.exclusiveMinimum;
  if (typeof node.exclusiveMaximum === 'number') node.maximum = node.exclusiveMaximum;
  delete node.exclusiveMaximum;

  if (node.minimum === SAFE_INT_MIN) delete node.minimum;
  if (node.maximum === SAFE_INT_MAX) delete node.maximum;

  if (node.type === 'string' && typeof node.format === 'string') {
    const format = node.format;
    if (format === 'date') {
      node.pattern = SHORT_DATE_PATTERN;
    } else {
      // Other formats (date-time, uri, email, uuid, ...) have no equivalent in the target parsers'
      // supported keyword set. Drop the pattern zod paired with the format too: it describes the
      // same constraint the format named and is just as unportable (e.g. the ~300-char leap-year
      // date-time regex), and it is not something a user wrote by hand via `.regex()`.
      delete node.pattern;
      if (format === 'uri' || format === 'url') node.description = ensureMentions(node.description, 'url', 'URL');
    }
    delete node.format;
  }

  splitMultiType(node);
  widenUnconstrained(node);
}

/** Walks a JSON Schema tree bottom-up, normalizing every node in place. */
function walk(node: unknown): unknown {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) node[i] = walk(node[i]);
    return node;
  }
  if (!isPlainObject(node)) return node;

  for (const key of ['properties', 'patternProperties'] as const) {
    const value = node[key];
    if (isPlainObject(value)) for (const propName of Object.keys(value)) value[propName] = walk(value[propName]);
  }
  if (node.additionalProperties !== undefined) node.additionalProperties = walk(node.additionalProperties);
  if (node.items !== undefined) node.items = walk(node.items);
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(node[key])) node[key] = (node[key] as unknown[]).map(walk);
  }

  simplifyNode(node);
  return node;
}

/**
 * Converts a tool's zod input schema into the simplified JSON Schema advertised over MCP, so
 * non-Claude clients (Gemini's function-calling parser in particular) do not choke on constructs
 * such as `$schema`, `exclusiveMinimum`, safe-integer bounds, or long date regexes. Validation stays
 * with zod: this only changes what is advertised, never what `runTool` accepts.
 */
export function portableJsonSchema(schema: z.ZodObject<any>): JsonSchemaNode {
  const raw = z.toJSONSchema(schema, { target: JSON_SCHEMA_TARGET, io: 'input' }) as JsonSchemaNode;
  // Deep-clone before mutating: zod may reuse sub-schema objects across a single conversion, and
  // walk()/simplifyNode() mutate nodes in place.
  const cloned = JSON.parse(JSON.stringify(raw)) as JsonSchemaNode;
  const inlined = inlineRefs(cloned);
  const result = walk(inlined) as JsonSchemaNode;
  return { type: 'object', ...result };
}

/**
 * Wraps a zod object schema so the MCP SDK advertises `portableJsonSchema`'s output in `tools/list`
 * while `~standard.validate` still delegates to zod's own runtime validation - the check the SDK
 * runs on every `tools/call` before the request reaches `runTool`. The two concerns stay separate:
 * the wire-visible shape may be looser than zod, but request handling is exactly as strict as before.
 */
export function withPortableSchema<S extends z.ZodObject<any>>(schema: S): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
  const std = (schema as unknown as { '~standard': StandardSchemaWithJSON<z.input<S>, z.output<S>>['~standard'] })['~standard'];
  const jsonSchema = portableJsonSchema(schema);
  return {
    '~standard': {
      version: 1,
      vendor: std.vendor,
      validate: (value: unknown) => std.validate(value),
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}
