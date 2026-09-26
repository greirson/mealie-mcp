import { describe, expect, it } from 'vitest';
import { allTools } from '../../src/tools/index.js';
import { portableJsonSchema, withPortableSchema } from '../../src/tools/json-schema.js';
import { mealplanTools } from '../../src/tools/mealplans.js';
import { shoppingTools } from '../../src/tools/shopping.js';

const tool = (name: string) => allTools.find((t) => t.name === name)!;

describe('portableJsonSchema', () => {
  it('drops $schema, exclusiveMinimum, and safe-integer bounds', () => {
    const schema = portableJsonSchema(tool('mealie_create_recipe').inputSchema);
    expect(schema).not.toHaveProperty('$schema');
    const properties = schema.properties as Record<string, any>;
    expect(properties.servings).toEqual({ type: 'number', minimum: 0 });
  });

  it('shortens a date field to YYYY-MM-DD and drops its format/long pattern', () => {
    const schema = portableJsonSchema(tool('mealie_list_mealplans').inputSchema);
    const properties = schema.properties as Record<string, any>;
    expect(properties.start_date).toEqual({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' });
  });

  it('drops format on a datetime field without adding a wrong pattern', () => {
    const schema = portableJsonSchema(tool('mealie_mark_recipe_made').inputSchema);
    const properties = schema.properties as Record<string, any>;
    expect(properties.made_at).toEqual({ type: 'string', description: 'ISO 8601 timestamp; defaults to now' });
  });

  it('drops format on a URL field and adds a description when none existed', () => {
    const schema = portableJsonSchema(tool('mealie_import_recipe_from_url').inputSchema);
    const properties = schema.properties as Record<string, any>;
    expect(properties.url).toEqual({ type: 'string', description: 'URL' });
  });

  it('removes propertyNames and keeps a simplified additionalProperties value schema', () => {
    const schema = portableJsonSchema(tool('mealie_api_request').inputSchema);
    const properties = schema.properties as Record<string, any>;
    expect(properties.query).not.toHaveProperty('propertyNames');
    expect(properties.query.additionalProperties.anyOf).toEqual([
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
    ]);
  });

  it('widens an unconstrained field (z.unknown()) to anyOf object/array instead of an empty schema', () => {
    const schema = portableJsonSchema(tool('mealie_api_request').inputSchema);
    const properties = schema.properties as Record<string, any>;
    expect(properties.body).toEqual({ anyOf: [{ type: 'object' }, { type: 'array' }], description: 'JSON body for POST, PUT, or PATCH' });
  });

  it('keeps a nullable field as anyOf[T, null]', () => {
    const schema = portableJsonSchema(tool('mealie_update_mealplan_entry').inputSchema);
    const properties = schema.properties as Record<string, any>;
    expect(properties.recipe_slug).toEqual({ anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] });
  });

  it('produces a plain object schema at the top level with no forbidden keys anywhere', () => {
    for (const t of allTools) {
      const schema = portableJsonSchema(t.inputSchema);
      expect(schema.type, t.name).toBe('object');
      const json = JSON.stringify(schema);
      for (const key of ['$schema', '$id', '$ref', '$defs', 'definitions', 'exclusiveMinimum', 'exclusiveMaximum', 'propertyNames', 'format']) {
        expect(json.includes(`"${key}"`), `${t.name} still has "${key}"`).toBe(false);
      }
      expect(json.includes('9007199254740991'), `${t.name} still has a safe-integer bound`).toBe(false);
    }
  });
});

describe('withPortableSchema', () => {
  it('advertises the simplified schema while still validating with the real zod schema', async () => {
    const original = tool('mealie_add_shopping_items').inputSchema;
    const wrapped = withPortableSchema(original);
    const advertised = wrapped['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
    expect(advertised).toEqual(portableJsonSchema(original));

    // Same validation behavior as the unwrapped schema: rejects what zod rejects...
    const badInput = { list_id: 'l1', items: [{ text: 'milk', quantity: 0 }] };
    const badResult = await wrapped['~standard'].validate(badInput);
    expect(badResult.issues, 'quantity 0 should still fail validation').toBeDefined();

    // ...and accepts (with defaults applied by zod) what zod accepts.
    const goodInput = { list_id: 'l1', items: [{ text: 'milk' }] };
    const goodResult = await wrapped['~standard'].validate(goodInput);
    expect(goodResult.issues).toBeUndefined();
    expect('value' in goodResult ? goodResult.value : undefined).toEqual(original.parse(goodInput));
  });
});

describe('server-side zod validation is unchanged by the advertised schema simplification', () => {
  it('still rejects an invalid calendar date like 2026-02-30', () => {
    const listMealplans = mealplanTools.find((t) => t.name === 'mealie_list_mealplans')!;
    const result = listMealplans.inputSchema.safeParse({ start_date: '2026-02-30', end_date: '2026-03-01' });
    expect(result.success).toBe(false);
  });

  it('still rejects a zero quantity where exclusiveMinimum 0 applied before simplification', () => {
    const addShoppingItems = shoppingTools.find((t) => t.name === 'mealie_add_shopping_items')!;
    const result = addShoppingItems.inputSchema.safeParse({ list_id: 'l1', items: [{ text: 'milk', quantity: 0 }] });
    expect(result.success).toBe(false);
  });

  it('still rejects a zero scale on add-recipe-to-shopping-list', () => {
    const addRecipe = shoppingTools.find((t) => t.name === 'mealie_add_recipe_to_shopping_list')!;
    const result = addRecipe.inputSchema.safeParse({ list_id: 'l1', recipes: [{ slug: 's1', scale: 0 }] });
    expect(result.success).toBe(false);
  });
});
