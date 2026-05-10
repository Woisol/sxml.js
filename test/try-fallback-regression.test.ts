import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SxmlParser, SxmlResult } from '../src/index';

function collectAll(parser: SxmlParser): SxmlResult[] {
  const results: SxmlResult[] = [];
  let r: SxmlResult | null;
  while ((r = parser.tryPull()) !== null) results.push(r);
  return results;
}

function buildEventsFrom(accumulated: SxmlResult[]): any[] {
  const events: any[] = [];
  for (const r of accumulated) {
    if (r.update === null) events.pop();
    else if (r.update !== undefined) events[events.length - 1] = r.update;
    events.push(...r.append);
  }
  return events;
}

describe('tryFallback — normal XML regression checks', () => {
  // ============================================================
  // Single tag
  // ============================================================
  it('single tag, one chunk', () => {
    const p = new SxmlParser({ legalTags: ['think'], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<think>hello</think>');
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t);
    assert.strictEqual(t.content, 'hello');
  });

  it('single tag, multi-chunk (content split)', () => {
    const p = new SxmlParser({ legalTags: ['think'], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<think>');
    allResults.push(...collectAll(p));
    p.write('hello');
    allResults.push(...collectAll(p));
    p.write(' world');
    allResults.push(...collectAll(p));
    p.write('</think>');
    allResults.push(...collectAll(p));
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t);
    assert.strictEqual(t.content, 'hello world');
  });

  it('single tag with attributes', () => {
    const p = new SxmlParser({ legalTags: ['tool'], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<tool name="grep" count="5">result</tool>');
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'tool');
    assert.ok(t);
    assert.strictEqual(t.content, 'result');
    assert.strictEqual(t.name, 'grep');
    assert.strictEqual(t.count, '5');
  });

  // ============================================================
  // Multiple sibling tags
  // ============================================================
  it('sibling tags', () => {
    const p = new SxmlParser({ legalTags: ['a', 'b'], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<a>first</a><b>second</b>');
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const a = events.find((e: any) => e.type === 'a');
    const b = events.find((e: any) => e.type === 'b');
    assert.ok(a);
    assert.ok(b);
    assert.strictEqual(a.content, 'first');
    assert.strictEqual(b.content, 'second');
  });

  it('sibling tags, chunked', () => {
    const p = new SxmlParser({ legalTags: ['a', 'b'], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<a>first</a>');
    allResults.push(...collectAll(p));
    p.write('<b>second</b>');
    allResults.push(...collectAll(p));
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const a = events.find((e: any) => e.type === 'a');
    const b = events.find((e: any) => e.type === 'b');
    assert.ok(a);
    assert.ok(b);
    assert.strictEqual(a.content, 'first');
    assert.strictEqual(b.content, 'second');
  });

  it('sibling tags split mid-way', () => {
    const p = new SxmlParser({ legalTags: ['a', 'b'], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<a>first</');
    allResults.push(...collectAll(p));
    p.write('a><b>second</b>');
    allResults.push(...collectAll(p));
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const a = events.find((e: any) => e.type === 'a');
    const b = events.find((e: any) => e.type === 'b');
    assert.ok(a);
    assert.ok(b);
    assert.strictEqual(a.content, 'first');
    assert.strictEqual(b.content, 'second');
  });

  // ============================================================
  // Nested tags
  // ============================================================
  it('nested tags with default handler', () => {
    const p = new SxmlParser({ legalTags: ['outer', 'inner'], tryFallback: true, maxNestingDepth: 2 });
    const allResults: SxmlResult[] = [];
    p.write('<outer><inner>deep</inner></outer>');
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const outer = events.find((e: any) => e.type === 'outer');
    assert.ok(outer);
    assert.strictEqual(outer.inner, 'deep');
  });

  it('nested tags, chunked across boundaries', () => {
    const p = new SxmlParser({ legalTags: ['outer', 'inner'], tryFallback: true, maxNestingDepth: 2 });
    const allResults: SxmlResult[] = [];
    p.write('<outer>');
    allResults.push(...collectAll(p));
    p.write('<inner>');
    allResults.push(...collectAll(p));
    p.write('deep');
    allResults.push(...collectAll(p));
    p.write('</inner>');
    allResults.push(...collectAll(p));
    p.write('</outer>');
    allResults.push(...collectAll(p));
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const outer = events.find((e: any) => e.type === 'outer');
    assert.ok(outer);
    assert.strictEqual(outer.inner, 'deep');
  });

  // ============================================================
  // Self-closing tags
  // ============================================================
  it('self-closing tag', () => {
    const p = new SxmlParser({ legalTags: ['br'], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<br/>');
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const br = events.find((e: any) => e.type === 'br');
    assert.ok(br);
  });

  it('self-closing tag with space', () => {
    const p = new SxmlParser({ legalTags: ['img'], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<img src="x.png" />');
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const img = events.find((e: any) => e.type === 'img');
    assert.ok(img);
    assert.strictEqual(img.src, 'x.png');
  });

  // ============================================================
  // confirmAt:open
  // ============================================================
  it('confirmAt:open single tag', () => {
    const p = new SxmlParser({ legalTags: [{ name: 'think', confirmAt: 'open' }], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<think>hello</think>');
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t);
    assert.strictEqual(t.content, 'hello');
  });

  it('confirmAt:open chunked', () => {
    const p = new SxmlParser({ legalTags: [{ name: 'think', confirmAt: 'open' }], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<think>');
    allResults.push(...collectAll(p));
    p.write('streaming');
    allResults.push(...collectAll(p));
    p.write(' text');
    allResults.push(...collectAll(p));
    p.write('</think>');
    allResults.push(...collectAll(p));
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t);
    assert.strictEqual(t.content, 'streaming text');
  });

  // ============================================================
  // Mixed text before/after tags
  // ============================================================
  it('text before and after tag', () => {
    const p = new SxmlParser({ legalTags: ['think'], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('before<think>inside</think>after');
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t);
    assert.strictEqual(t.content, 'inside');
    const texts = events.filter((e: any) => e.type === 'text');
    assert.strictEqual(texts.length, 2);
    assert.strictEqual(texts[0].content, 'before');
    assert.strictEqual(texts[1].content, 'after');
  });

  // ============================================================
  // Single-chunk stress tests with realistic LLM patterns
  // ============================================================
  it('tool_call with JSON args', () => {
    const p = new SxmlParser({ legalTags: ['tool_call'], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<tool_call name="get_weather">{"city":"NYC"}</tool_call>');
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const tc = events.find((e: any) => e.type === 'tool_call');
    assert.ok(tc);
    assert.strictEqual(tc.name, 'get_weather');
    assert.strictEqual(tc.content, '{"city":"NYC"}');
  });

  it('brackets in content (code-like text)', () => {
    const p = new SxmlParser({ legalTags: ['code', 'think'], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<think>if (x < y) { return a > b; }</think>');
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t);
    assert.strictEqual(t.content, 'if (x < y) { return a > b; }');
  });

  it('legacy multi-think pattern', () => {
    const p = new SxmlParser({ legalTags: ['think', 'tool_call'], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<think>planning</think><tool_call name="run">cmd</tool_call><think>done</think>');
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const thinks = events.filter((e: any) => e.type === 'think');
    assert.strictEqual(thinks.length, 2);
    assert.strictEqual(thinks[0].content, 'planning');
    assert.strictEqual(thinks[1].content, 'done');
    const tc = events.find((e: any) => e.type === 'tool_call');
    assert.ok(tc);
    assert.strictEqual(tc.content, 'cmd');
  });

  // ============================================================
  // Empty tag
  // ============================================================
  it('empty tag', () => {
    const p = new SxmlParser({ legalTags: ['think'], tryFallback: true });
    const allResults: SxmlResult[] = [];
    p.write('<think></think>');
    p.end();
    allResults.push(...collectAll(p));
    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t);
    assert.strictEqual(t.content, '');
  });
});
