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

/**
 * Run the SAME input through two parsers — one with tryFallback, one without —
 * and assert they produce identical results for normal/complete XML.
 */
function assertIdentical(chunks: string[], config: any) {
  const p1 = new SxmlParser({ ...config, tryFallback: false });
  const p2 = new SxmlParser({ ...config, tryFallback: true });

  const r1: SxmlResult[] = [];
  const r2: SxmlResult[] = [];

  for (const c of chunks) {
    p1.write(c); r1.push(...collectAll(p1));
    p2.write(c); r2.push(...collectAll(p2));
  }
  p1.end(); r1.push(...collectAll(p1));
  p2.end(); r2.push(...collectAll(p2));

  const e1 = buildEventsFrom(r1);
  const e2 = buildEventsFrom(r2);
  assert.deepStrictEqual(e2, e1, `tryFallback changed output for chunks: ${JSON.stringify(chunks)}`);
}

describe('tryFallback — identical output for normal XML', () => {
  it('simple tag, one chunk', () => {
    assertIdentical(['<think>hello</think>'], { legalTags: ['think'] });
  });

  it('tag with attributes', () => {
    assertIdentical(['<tool_call name="test">payload</tool_call>'], { legalTags: ['tool_call'] });
  });

  it('chunked content', () => {
    assertIdentical(['<think>', 'hello', ' world', '</think>'], { legalTags: ['think'] });
  });

  it('sibling tags', () => {
    assertIdentical(['<a>first</a><b>second</b>'], { legalTags: ['a', 'b'] });
  });

  it('nested tags', () => {
    assertIdentical(['<outer><inner>deep</inner></outer>'], { legalTags: ['outer', 'inner'], maxNestingDepth: 2 });
  });

  it('self-closing tag', () => {
    assertIdentical(['<br/>'], { legalTags: ['br'] });
  });

  it('text before and after', () => {
    assertIdentical(['before<think>inside</think>after'], { legalTags: ['think'] });
  });

  it('close tag split across chunks', () => {
    assertIdentical(['<think>hello</', 'think>'], { legalTags: ['think'] });
  });

  it('close tag split at <', () => {
    assertIdentical(['<think>hello<', '/think>'], { legalTags: ['think'] });
  });

  it('open tag split', () => {
    assertIdentical(['<thi', 'nk>hello</think>'], { legalTags: ['think'] });
  });

  it('confirmAt:open', () => {
    assertIdentical(
      ['<think>streaming</think>'],
      { legalTags: [{ name: 'think', confirmAt: 'open' }] }
    );
  });

  it('confirmAt:open chunked', () => {
    assertIdentical(
      ['<think>', 'streaming', '</think>'],
      { legalTags: [{ name: 'think', confirmAt: 'open' }] }
    );
  });

  it('brackets in content (avoids false positive tags)', () => {
    assertIdentical(
      ['<code>if (a < b && c > d) {}</code>'],
      { legalTags: ['code'] }
    );
  });
});
