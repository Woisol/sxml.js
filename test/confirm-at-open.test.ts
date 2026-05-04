import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SxmlParser, SxmlResult } from '../src/index';
import { collectSync, buildEvents } from './helpers';

const OPEN_THINK = { name: 'think', confirmAt: 'open' as const };

describe('confirmAt-open', () => {
  it('should emit partial think at open, final at close', () => {
    const results = collectSync(
      ['before<think>hello</think>after'],
      { legalTags: [OPEN_THINK] }
    );

    const events = buildEvents(results);
    // text before → think → text after (no raw XML in output)
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(events[0], { type: 'text', content: 'before' });
    assert.strictEqual(events[1].type, 'think');
    assert.strictEqual(events[1].content, 'hello');
    assert.deepStrictEqual(events[2], { type: 'text', content: 'after' });
  });

  it('should stream text inside think as biz event updates', () => {
    const parser = new SxmlParser({ legalTags: [OPEN_THINK] });
    const results: SxmlResult[] = [];

    parser.write('before<think>');
    let r: SxmlResult | null;
    while ((r = parser.tryPull()) !== null) results.push(r);

    // After open tag: should have text("before") and a partial think
    const events1 = buildEvents(results);
    const partialThink = events1.find((e: any) => e.type === 'think');
    assert.ok(partialThink, 'Partial think should be emitted on open');
    assert.strictEqual(partialThink.content, '');

    // Stream text — should update think content, not create text events
    parser.write('hel');
    while ((r = parser.tryPull()) !== null) results.push(r);
    parser.write('lo');
    while ((r = parser.tryPull()) !== null) results.push(r);

    const events2 = buildEvents(results);
    const thinkMid = events2.find((e: any) => e.type === 'think');
    assert.strictEqual(thinkMid.content, 'hello',
      'Think content should accumulate from streamed text');

    // No new text events should have been created between open and close
    const textEvents = events2.filter((e: any) => e.type === 'text');
    assert.strictEqual(textEvents.length, 1, 'Only the "before" text event should exist');

    // Close tag
    parser.write('</think>after');
    parser.end();
    while ((r = parser.tryPull()) !== null) results.push(r);

    const finalEvents = buildEvents(results);
    const finalThink = finalEvents.find((e: any) => e.type === 'think');
    assert.strictEqual(finalThink.content, 'hello');
    const finalTexts = finalEvents.filter((e: any) => e.type === 'text');
    const allText = finalTexts.map((t: any) => t.content).join('');
    assert.strictEqual(allText, 'beforeafter',
      'Text before and after think should be preserved');
  });

  it('should default to confirmAt:close for string entries', () => {
    // Using plain string — behavior should be identical to before
    const results = collectSync(
      ['before<think>hello</think>after'],
      { legalTags: ['think'] }
    );

    const events = buildEvents(results);
    const thinkEvent = events.find((e: any) => e.type === 'think');
    assert.ok(thinkEvent);
    assert.strictEqual(thinkEvent.content, 'hello');

    // With confirmAt:'close' explicitly
    const results2 = collectSync(
      ['before<think>hello</think>after'],
      { legalTags: [{ name: 'think', confirmAt: 'close' }] }
    );
    const events2 = buildEvents(results2);
    const think2 = events2.find((e: any) => e.type === 'think');
    assert.ok(think2);
    assert.strictEqual(think2.content, 'hello');
  });

  it('should mix confirmAt:open and confirmAt:close tags', () => {
    const results = collectSync(
      ['<think>reasoning</think><tool_call name="calc">2+2</tool_call>'],
      {
        legalTags: [OPEN_THINK, 'tool_call'],
      }
    );

    const events = buildEvents(results);
    const think = events.find((e: any) => e.type === 'think');
    assert.ok(think, 'Think should exist');
    assert.strictEqual(think.content, 'reasoning');

    const tool = events.find((e: any) => e.type === 'tool_call');
    assert.ok(tool, 'Tool_call should exist');
    assert.strictEqual(tool.content, '2+2');
    assert.strictEqual(tool.name, 'calc');
  });

  it('should handle self-closing tag with confirmAt:open (no-op)', () => {
    const results = collectSync(
      ['before<br/>after'],
      { legalTags: [{ name: 'br', confirmAt: 'open' }] }
    );

    const events = buildEvents(results);
    const br = events.find((e: any) => e.type === 'br');
    assert.ok(br, 'Self-closing br should still work');
    const textEvents = events.filter((e: any) => e.type === 'text');
    const allText = textEvents.map((t: any) => t.content).join('');
    assert.strictEqual(allText, 'beforeafter');
  });

  it('should not leak raw tag text across chunk boundaries', () => {
    const chunks = ['<thi', 'nk>hello</think>'];
    const results = collectSync(chunks, { legalTags: [OPEN_THINK] });

    const events = buildEvents(results);
    const think = events.find((e: any) => e.type === 'think');
    assert.ok(think, 'Think event should exist');
    assert.strictEqual(think.content, 'hello');

    // No raw "<think" or "<thi" or "nk>" text
    const textEvents = events.filter((e: any) => e.type === 'text');
    const hasRawTag = textEvents.some((t: any) =>
      t.content.includes('<thi') || t.content.includes('nk>')
    );
    assert.strictEqual(hasRawTag, false, 'No raw open tag text should leak');
  });

  it('should fall back to confirm-at-close if handler returns null on open', () => {
    const results = collectSync(
      ['<think>content</think>'],
      {
        legalTags: [OPEN_THINK],
        tagHandlers: {
          think: {
            build(tagName, attrs, children) {
              // Return null when children is empty (on open)
              if (children.length === 0) return null;
              const text = children
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.content)
                .join('');
              return { type: 'think', content: text };
            },
          },
        },
      }
    );

    const events = buildEvents(results);
    const think = events.find((e: any) => e.type === 'think');
    assert.ok(think, 'Think should exist after fallback');
    assert.strictEqual(think.content, 'content');
  });

  it('should emit confirm-at-open child under custom-handler parent', () => {
    const results = collectSync(
      ['<custom><think>inner</think></custom>'],
      {
        legalTags: [OPEN_THINK, 'custom'],
        tagHandlers: {
          custom: {
            build(tagName, attrs, children) {
              const text = children
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.content)
                .join('');
              const sub = children.find((c: any) => c.type !== 'text');
              return { type: 'custom', content: text, child: sub || null };
            },
          },
        },
      }
    );

    const events = buildEvents(results);
    const custom = events.find((e: any) => e.type === 'custom');
    assert.ok(custom, 'Custom parent should exist');
    assert.ok(custom.child, 'Child should be passed to custom handler');
    assert.strictEqual(custom.child.type, 'think');
    assert.strictEqual(custom.child.content, 'inner');
  });

  it('should NOT emit confirm-at-open child under default-handler parent (will be absorbed)', () => {
    const parser = new SxmlParser({
      legalTags: [OPEN_THINK, 'outer'],
    });
    const results: SxmlResult[] = [];

    parser.write('<outer>');
    let r: SxmlResult | null;
    while ((r = parser.tryPull()) !== null) results.push(r);

    parser.write('<think>hidden</think>');
    while ((r = parser.tryPull()) !== null) results.push(r);

    // At this point, think should NOT have emitted a partial
    // (because outer uses default handler and would absorb it)
    const midEvents = buildEvents(results);
    const midThink = midEvents.find((e: any) => e.type === 'think');
    assert.strictEqual(midThink, undefined,
      'Think partial should not be emitted under absorbing parent');

    parser.write('</outer>');
    parser.end();
    while ((r = parser.tryPull()) !== null) results.push(r);

    const events = buildEvents(results);
    const outer = events.find((e: any) => e.type === 'outer');
    assert.ok(outer, 'Outer event should exist');
    // think content should be absorbed as outer's attribute
    assert.strictEqual(outer.think, 'hidden',
      'Think should be absorbed into outer as attribute');
  });

  it('should resolve unclosed confirm-at-open tag at end()', () => {
    const parser = new SxmlParser({ legalTags: [OPEN_THINK] });
    const results: SxmlResult[] = [];

    parser.write('text<think>unfinished');
    let r: SxmlResult | null;
    while ((r = parser.tryPull()) !== null) results.push(r);

    parser.end();
    while ((r = parser.tryPull()) !== null) results.push(r);

    const events = buildEvents(results);
    const think = events.find((e: any) => e.type === 'think');
    assert.ok(think, 'Unclosed think should be resolved at end()');
    assert.strictEqual(think.content, 'unfinished');
  });

  it('should handle multiple confirm-at-open siblings', () => {
    const results = collectSync(
      ['<think>first</think><think>second</think>'],
      { legalTags: [OPEN_THINK] }
    );

    const events = buildEvents(results);
    const thinks = events.filter((e: any) => e.type === 'think');
    assert.strictEqual(thinks.length, 2);
    assert.strictEqual(thinks[0].content, 'first');
    assert.strictEqual(thinks[1].content, 'second');
  });

  it('should handle empty confirm-at-open tag', () => {
    const results = collectSync(
      ['<think></think>'],
      { legalTags: [OPEN_THINK] }
    );

    const events = buildEvents(results);
    const think = events.find((e: any) => e.type === 'think');
    assert.ok(think, 'Empty think should exist');
    assert.strictEqual(think.content, '');
  });
});
