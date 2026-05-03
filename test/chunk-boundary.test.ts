import { describe, it } from 'node:test';
import assert from 'node:assert';
import { collectSync, buildEvents } from './helpers';

describe('chunk boundary handling', () => {
  it('should handle tag name split across chunks', () => {
    const results = collectSync(
      ['<thi', 'nk>content</think>'],
      { legalTags: ['think'] }
    );
    const events = buildEvents(results);
    const think = events.find((e: any) => e.type === 'think');
    assert.ok(think);
    assert.strictEqual(think.content, 'content');
  });

  it('should handle attribute value split across chunks', () => {
    const results = collectSync(
      ['<tool_call name="re', 'ad">done</tool_call>'],
      { legalTags: ['tool_call'] }
    );
    const events = buildEvents(results);
    const tc = events.find((e: any) => e.type === 'tool_call');
    assert.ok(tc);
    assert.strictEqual(tc.name, 'read');
  });

  it('should handle close tag split across chunks', () => {
    const results = collectSync(
      ['<think>content</thi', 'nk>'],
      { legalTags: ['think'] }
    );
    const events = buildEvents(results);
    const think = events.find((e: any) => e.type === 'think');
    assert.ok(think);
  });

  it('should handle chunk ending at <', () => {
    const results = collectSync(
      ['text<', 'tag>content</tag>'],
      { legalTags: ['tag'] }
    );
    const events = buildEvents(results);
    const tag = events.find((e: any) => e.type === 'tag');
    assert.ok(tag);
    assert.strictEqual(tag.content, 'content');
  });

  it('should handle self-closing tag split across chunks', () => {
    const results = collectSync(
      ['before<br', '/>after'],
      { legalTags: ['br'] }
    );
    const events = buildEvents(results);
    const br = events.find((e: any) => e.type === 'br');
    assert.ok(br, 'Self-closing tag split across chunks should work');
  });

  it('should handle attribute value split at the quote boundary', () => {
    const results = collectSync(
      ['<tag name=', '"val">text</tag>'],
      { legalTags: ['tag'] }
    );
    const events = buildEvents(results);
    const tag = events.find((e: any) => e.type === 'tag');
    assert.ok(tag);
    assert.strictEqual(tag.name, 'val');
    assert.strictEqual(tag.content, 'text');
  });

  it('should handle chunks with only whitespace between tags', () => {
    const results = collectSync(
      ['<a>1</a>', ' ', '<b>2</b>'],
      { legalTags: ['a', 'b'] }
    );
    const events = buildEvents(results);
    const a = events.find((e: any) => e.type === 'a');
    const b = events.find((e: any) => e.type === 'b');
    assert.ok(a);
    assert.ok(b);
    assert.strictEqual(a.content, '1');
    assert.strictEqual(b.content, '2');
  });
});
