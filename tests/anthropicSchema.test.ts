/**
 * Anthropic tool-schema sanitizer — offline. Anthropic rejects numeric range
 * keywords on integer/number properties; we strip them and fold the bound into the
 * property description so the model still sees the range (Zod re-validates at run).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __test } from '../src/llm/anthropic.js';

const { sanitizeAnthropicSchema, sanitizeAnthropicTool } = __test;

describe('sanitizeAnthropicTool', () => {
  it('forces tools non-strict (Anthropic caps strict tools at 20) and sanitizes the schema', () => {
    const out = sanitizeAnthropicTool({
      name: 'web_search',
      description: 'Search.',
      strict: true,
      input_schema: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 10 } } },
    } as any) as any;
    assert.equal(out.strict, false);
    assert.equal(out.input_schema.properties.n.minimum, undefined);
    assert.match(out.input_schema.properties.n.description, />= 1/);
  });
});

describe('sanitizeAnthropicSchema', () => {
  it('strips minimum/maximum from an integer property and folds the range into its description', () => {
    const out = sanitizeAnthropicSchema({
      type: 'object',
      properties: {
        max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'How many results.' },
      },
      required: ['max_results'],
    }) as any;
    const prop = out.properties.max_results;
    assert.equal(prop.minimum, undefined);
    assert.equal(prop.maximum, undefined);
    assert.match(prop.description, /How many results\./);
    assert.match(prop.description, />= 1/);
    assert.match(prop.description, /<= 10/);
  });

  it('handles exclusive bounds and properties with no prior description', () => {
    const out = sanitizeAnthropicSchema({
      type: 'number',
      exclusiveMinimum: 0,
      exclusiveMaximum: 1,
    }) as any;
    assert.equal(out.exclusiveMinimum, undefined);
    assert.equal(out.exclusiveMaximum, undefined);
    assert.match(out.description, /> 0/);
    assert.match(out.description, /< 1/);
  });

  it('recurses into nested objects and arrays', () => {
    const out = sanitizeAnthropicSchema({
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'integer', minimum: 5 } },
      },
    }) as any;
    assert.equal(out.properties.items.items.minimum, undefined);
    assert.match(out.properties.items.items.description, />= 5/);
  });

  it('coerces a schema-valued additionalProperties to false (Anthropic requirement)', () => {
    const out = sanitizeAnthropicSchema({
      type: 'object',
      properties: { meta: { type: 'object', additionalProperties: { type: 'string' } } },
      additionalProperties: { type: 'number' },
    }) as any;
    assert.equal(out.additionalProperties, false);
    assert.equal(out.properties.meta.additionalProperties, false);
  });

  it('leaves additionalProperties: false as-is', () => {
    const out = sanitizeAnthropicSchema({ type: 'object', additionalProperties: false }) as any;
    assert.equal(out.additionalProperties, false);
  });

  it('drops propertyNames and strips string-length keywords (record/map schema)', () => {
    const out = sanitizeAnthropicSchema({
      type: 'object',
      propertyNames: { type: 'string', minLength: 1 },
      additionalProperties: { type: 'string', maxLength: 50 },
    }) as any;
    assert.equal(out.propertyNames, undefined);
    assert.equal(out.additionalProperties, false);
  });

  it('folds string minLength/maxLength into the description', () => {
    const out = sanitizeAnthropicSchema({ type: 'string', minLength: 2, maxLength: 8, description: 'A code.' }) as any;
    assert.equal(out.minLength, undefined);
    assert.equal(out.maxLength, undefined);
    assert.match(out.description, /A code\./);
    assert.match(out.description, /minLength 2/);
    assert.match(out.description, /maxLength 8/);
  });

  it('leaves schemas without numeric bounds untouched', () => {
    const input = { type: 'object', properties: { name: { type: 'string', description: 'A name.' } } };
    const out = sanitizeAnthropicSchema(input) as any;
    assert.deepEqual(out, input);
  });
});
