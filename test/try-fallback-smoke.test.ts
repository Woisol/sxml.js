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

describe('tryFallback smoke', () => {
  it('normal XML with tryFallback=true', () => {
    const parser = new SxmlParser({
      legalTags: ['think'],
      tryFallback: true,
    });
    const allResults: SxmlResult[] = [];
    parser.write('<think>hello world</think>');
    parser.end();
    allResults.push(...collectAll(parser));
    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t, 'think should be resolved');
    assert.strictEqual(t.content, 'hello world');
  });

  it('normal XML with tryFallback=true, chunked', () => {
    const parser = new SxmlParser({
      legalTags: ['think'],
      tryFallback: true,
    });
    const allResults: SxmlResult[] = [];
    parser.write('<think>');
    allResults.push(...collectAll(parser));
    parser.write('hello world');
    allResults.push(...collectAll(parser));
    parser.write('</think>');
    allResults.push(...collectAll(parser));
    parser.end();
    allResults.push(...collectAll(parser));
    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t, 'think should be resolved');
    assert.strictEqual(t.content, 'hello world');
  });

  it('normal XML with tryFallback=true, close tag split', () => {
    const parser = new SxmlParser({
      legalTags: ['think'],
      tryFallback: true,
    });
    const allResults: SxmlResult[] = [];
    parser.write('<think>hello world</');
    allResults.push(...collectAll(parser));
    parser.write('think>');
    allResults.push(...collectAll(parser));
    parser.end();
    allResults.push(...collectAll(parser));
    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t, 'think should be resolved');
    assert.strictEqual(t.content, 'hello world');
  });

  it('normal XML with tryFallback=true, close tag split precisely at <', () => {
    const parser = new SxmlParser({
      legalTags: ['think'],
      tryFallback: true,
    });
    const allResults: SxmlResult[] = [];
    parser.write('<think>hello world<');
    allResults.push(...collectAll(parser));
    parser.write('/think>');
    allResults.push(...collectAll(parser));
    parser.end();
    allResults.push(...collectAll(parser));
    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t, 'think should be resolved');
    assert.strictEqual(t.content, 'hello world');
  });

  it('normal XML without tryFallback', () => {
    const parser = new SxmlParser({
      legalTags: ['think'],
    });
    const allResults: SxmlResult[] = [];
    parser.write('<think>hello world</think>');
    parser.end();
    allResults.push(...collectAll(parser));
    const events = buildEventsFrom(allResults);
    const t = events.find((e: any) => e.type === 'think');
    assert.ok(t, 'think should be resolved');
    assert.strictEqual(t.content, 'hello world');
  });
});
