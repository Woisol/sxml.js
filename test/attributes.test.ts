import { describe, it } from 'node:test';
import assert from 'node:assert';
import { collectSync, buildEvents } from './helpers';

describe('attribute handling', () => {
  it('should parse single-quoted attributes', () => {
    const results = collectSync(
      ["<tag name='value' key='val2'>text</tag>"],
      { legalTags: ['tag'] }
    );
    const events = buildEvents(results);
    const tag = events.find((e: any) => e.type === 'tag');
    assert.ok(tag);
    assert.strictEqual(tag.name, 'value');
    assert.strictEqual(tag.key, 'val2');
    assert.strictEqual(tag.content, 'text');
  });

  it('should handle nested quotes in attribute values', () => {
    const results = collectSync(
      ['<tool_call name="read" args=\'{"key":"val"}\'>done</tool_call>'],
      { legalTags: ['tool_call'] }
    );
    const events = buildEvents(results);
    const tc = events.find((e: any) => e.type === 'tool_call');
    assert.ok(tc);
    assert.strictEqual(tc.name, 'read');
    assert.strictEqual(tc.args, '{"key":"val"}');
  });

  it('should handle boolean attributes (name only, no value)', () => {
    const results = collectSync(
      ['<input disabled>text</input>'],
      { legalTags: ['input'] }
    );
    const events = buildEvents(results);
    const tag = events.find((e: any) => e.type === 'input');
    assert.ok(tag);
    assert.strictEqual(tag.disabled, '');
  });
});
