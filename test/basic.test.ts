import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SxmlParser, SxmlResult, SxmlConfig } from '../src/index';
import { collectSync, buildEvents } from './helpers';

describe('basic text streaming', () => {
  it('should output plain text', () => {
    const results = collectSync(['hello world']);
    assert.ok(results.length >= 1);
    const events = buildEvents(results);
    assert.ok(events.some((e: any) => e.type === 'text' && e.content === 'hello world'));
  });

  it('should stream text across multiple chunks with update', () => {
    const results = collectSync(['hello', ' world']);
    assert.ok(results.length >= 2);
    assert.ok(results[0].append.some((e: any) => e.type === 'text' && e.content === 'hello'));
    const hasUpdate = results.some(r =>
      r.update && r.update.type === 'text' && (r.update as any).content === 'hello world'
    );
    assert.ok(hasUpdate);
  });

  it('should handle empty input', () => {
    const results = collectSync(['']);
    const events = buildEvents(results);
    assert.strictEqual(events.length, 0);
  });
});

describe('single tag', () => {
  it('should parse a simple tag with default handler', () => {
    const results = collectSync(
      ['<think>hello</think>'],
      { legalTags: ['think'] }
    );
    const events = buildEvents(results);
    const thinkEvent = events.find((e: any) => e.type === 'think');
    assert.ok(thinkEvent, 'Should have think event');
    assert.strictEqual(thinkEvent.name, 'think');
    assert.strictEqual(thinkEvent.content, 'hello');
  });

  it('should show raw XML before tag closes (backtracking)', () => {
    const parser = new SxmlParser({ legalTags: ['think'] });
    const results: SxmlResult[] = [];

    parser.write('<think>');
    let r: SxmlResult | null;
    while ((r = parser.tryPull()) !== null) results.push(r);

    const events1 = buildEvents(results);
    const hasRawXml = events1.some((e: any) =>
      e.type === 'text' && e.content.includes('<think')
    );
    assert.ok(hasRawXml, 'Should show raw <think> as text before close');

    parser.write('hello</think>');
    while ((r = parser.tryPull()) !== null) results.push(r);
    parser.end();
    while ((r = parser.tryPull()) !== null) results.push(r);

    const events = buildEvents(results);
    const thinkEvent = events.find((e: any) => e.type === 'think');
    assert.ok(thinkEvent, 'Should eventually have think business event');
    assert.strictEqual(thinkEvent.content, 'hello');
  });

  it('should handle tag with attributes', () => {
    const results = collectSync(
      ['<tool_call name="calc" op="add">2+2</tool_call>'],
      { legalTags: ['tool_call'] }
    );
    const events = buildEvents(results);
    const tc = events.find((e: any) => e.type === 'tool_call');
    assert.ok(tc);
    assert.strictEqual(tc.name, 'calc');
    assert.strictEqual(tc.op, 'add');
    assert.strictEqual(tc.content, '2+2');
  });
});

describe('end() behavior', () => {
  it('should handle unclosed tag at end()', () => {
    const results = collectSync(
      ['<think'],
      { legalTags: ['think'] }
    );
    const events = buildEvents(results);
    const textEvent = events.find((e: any) => e.type === 'text');
    assert.ok(textEvent, 'Unclosed tag should be text');
  });
});

describe('reset()', () => {
  it('should allow reuse after reset', () => {
    const parser = new SxmlParser({ legalTags: ['think'] });

    parser.write('<think>first</think>');
    parser.end();
    while (parser.tryPull() !== null) {}

    parser.reset();
    parser.write('<think>second</think>');
    parser.end();

    const events: any[] = [];
    let r: SxmlResult | null;
    while ((r = parser.tryPull()) !== null) {
      if (r.update) events[events.length - 1] = r.update;
      events.push(...r.append);
    }

    const think = events.find((e: any) => e.type === 'think');
    assert.ok(think);
    assert.strictEqual(think.content, 'second');
  });
});
