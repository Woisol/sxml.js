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

describe('tryFallback: edge cases & intermediate state', () => {
  // ============================================================
  // confirmAt:open with close tag SPLIT — critical case
  // ============================================================
  it('confirmAt:open with close tag split — final content must be clean', () => {
    const parser = new SxmlParser({
      legalTags: [{ name: 'think', confirmAt: 'open' }],
      tryFallback: true,
    });
    const allResults: SxmlResult[] = [];

    parser.write('<think>');
    allResults.push(...collectAll(parser));

    parser.write('streaming</');
    allResults.push(...collectAll(parser));

    parser.write('think>');
    allResults.push(...collectAll(parser));

    parser.end();
    allResults.push(...collectAll(parser));

    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t, 'think should be resolved');
    // Without tryFallback, this would be 'streaming</' (raw </ leaks in).
    // With tryFallback, it should be 'streaming' (clean).
    assert.strictEqual(t.content, 'streaming', 'content must not contain raw </');
  });

  it('confirmAt:open with close tag split — intermediate state must be clean', () => {
    const parser = new SxmlParser({
      legalTags: [{ name: 'think', confirmAt: 'open' }],
      tryFallback: true,
    });
    parser.write('<think>');
    collectAll(parser);

    parser.write('streaming</');

    // The intermediate results (immediately after second write) should NOT contain </
    const results = collectAll(parser);
    // Find the last update for the think biz event
    const thinkUpdates = results.filter(r => r.update && (r.update as any)?.type === 'think');
    for (const u of thinkUpdates) {
      const content = (u.update as any).content;
      assert.ok(!content.includes('</'), `intermediate update must not contain </: got "${content}"`);
    }
  });

  // ============================================================
  // Multiple close tags in flight (new chunk arriving while one close tag is pending)
  // ============================================================
  it('sibling tags where first close tag is split', () => {
    const parser = new SxmlParser({
      legalTags: ['a', 'b'],
      tryFallback: true,
    });
    const allResults: SxmlResult[] = [];

    parser.write('<a>first</');
    allResults.push(...collectAll(parser));

    parser.write('a><b>second</b>');
    allResults.push(...collectAll(parser));

    parser.end();
    allResults.push(...collectAll(parser));

    const events = buildEventsFrom(allResults);
    const a = events.find((e: any) => e.type === 'a');
    const b = events.find((e: any) => e.type === 'b');
    assert.ok(a);
    assert.ok(b);
    assert.strictEqual(a.content, 'first');
    assert.strictEqual(b.content, 'second');
  });

  // ============================================================
  // Open tag split (not close tag) — should be fully unaffected
  // ============================================================
  it('open tag split across chunks', () => {
    const parser = new SxmlParser({
      legalTags: ['think'],
      tryFallback: true,
    });
    const allResults: SxmlResult[] = [];

    parser.write('<thi');
    allResults.push(...collectAll(parser));

    parser.write('nk>content</think>');
    allResults.push(...collectAll(parser));

    parser.end();
    allResults.push(...collectAll(parser));

    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t);
    assert.strictEqual(t.content, 'content');
  });

  // ============================================================
  // Self-closing tag split
  // ============================================================
  it('self-closing tag split', () => {
    const parser = new SxmlParser({
      legalTags: ['br'],
      tryFallback: true,
    });
    const allResults: SxmlResult[] = [];

    parser.write('<br');
    allResults.push(...collectAll(parser));

    parser.write('/>');
    allResults.push(...collectAll(parser));

    parser.end();
    allResults.push(...collectAll(parser));

    const events = buildEventsFrom(allResults);
    const br = events.find((e: any) => e.type === 'br');
    assert.ok(br);
  });

  // ============================================================
  // Single chunk with many tags — no flushPendingText interference
  // ============================================================
  it('many tags in single chunk', () => {
    const parser = new SxmlParser({
      legalTags: ['a', 'b', 'c'],
      tryFallback: true,
    });
    const allResults: SxmlResult[] = [];
    parser.write('<a>1</a><b>2</b><c>3</c>');
    parser.end();
    allResults.push(...collectAll(parser));
    const events = buildEventsFrom(allResults);
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].content, '1');
    assert.strictEqual(events[1].content, '2');
    assert.strictEqual(events[2].content, '3');
  });

  // ============================================================
  // No tags at all — plain text
  // ============================================================
  it('plain text throughout', () => {
    const parser = new SxmlParser({
      legalTags: ['think'],
      tryFallback: true,
    });
    const allResults: SxmlResult[] = [];

    parser.write('just some');
    allResults.push(...collectAll(parser));

    parser.write(' plain text');
    allResults.push(...collectAll(parser));

    parser.end();
    allResults.push(...collectAll(parser));

    const events = buildEventsFrom(allResults);
    const texts = events.filter((e: any) => e.type === 'text');
    assert.strictEqual(texts.length, 1);
    // text is merged as updates happen
    assert.ok(texts[0].content.includes('just some'));
    assert.ok(texts[0].content.includes('plain text'));
  });

  // ============================================================
  // Stress: 100 sequential writes with tiny chunks
  // ============================================================
  it('many tiny chunks with tags', () => {
    const full = '<think>hello world</think>';
    const parser = new SxmlParser({
      legalTags: ['think'],
      tryFallback: true,
    });
    const allResults: SxmlResult[] = [];

    // Write one character at a time
    for (let i = 0; i < full.length; i++) {
      parser.write(full[i]);
      allResults.push(...collectAll(parser));
    }
    parser.end();
    allResults.push(...collectAll(parser));

    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t);
    assert.strictEqual(t.content, 'hello world');
  });
});
