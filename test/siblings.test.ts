import { describe, it } from 'node:test';
import assert from 'node:assert';
import { collectSync, buildEvents } from './helpers';

describe('multiple sibling tags', () => {
  it('should parse multiple sibling tags independently', () => {
    const results = collectSync(
      ['<a>first</a><b>second</b>'],
      { legalTags: ['a', 'b'] }
    );
    const events = buildEvents(results);

    const a = events.find((e: any) => e.type === 'a');
    assert.ok(a, 'Should have a event');
    assert.strictEqual(a.content, 'first');

    const b = events.find((e: any) => e.type === 'b');
    assert.ok(b, 'Should have b event');
    assert.strictEqual(b.content, 'second');
  });

  it('should interleave text and tags correctly with siblings', () => {
    const results = collectSync(
      ['before<a>inA</a>between<b>inB</b>after'],
      { legalTags: ['a', 'b'] }
    );
    const events = buildEvents(results);

    const a = events.find((e: any) => e.type === 'a');
    const b = events.find((e: any) => e.type === 'b');
    assert.ok(a);
    assert.ok(b);
    assert.strictEqual(a.content, 'inA');
    assert.strictEqual(b.content, 'inB');

    const text = events.filter((e: any) => e.type === 'text');
    assert.ok(text.length === 3, 'Should have three text events');
    const allText = text.map((t: any) => t.content).join('');
    assert.ok(allText.includes('before'));
    assert.ok(allText.includes('between'));
    assert.ok(allText.includes('after'));
  });

  it('should parse many sibling tags in sequence', () => {
    const results = collectSync(
      ['<a>1</a><b>2</b><a>3</a><b>4</b>'],
      { legalTags: ['a', 'b'] }
    );
    const events = buildEvents(results);
    const aTags = events.filter((e: any) => e.type === 'a');
    const bTags = events.filter((e: any) => e.type === 'b');
    assert.strictEqual(aTags.length, 2, 'Should have two a tags');
    assert.strictEqual(bTags.length, 2, 'Should have two b tags');
    assert.strictEqual(aTags[0].content, '1');
    assert.strictEqual(aTags[1].content, '3');
  });
});
