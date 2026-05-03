import { describe, it } from 'node:test';
import assert from 'node:assert';
import { collectSync, buildEvents } from './helpers';

describe('nested tags', () => {
  it('should absorb child into parent with default handler', () => {
    const results = collectSync(
      ['<outer>before<inner>nested</inner>after</outer>'],
      { legalTags: ['outer', 'inner'] }
    );
    const events = buildEvents(results);

    const outer = events.find((e: any) => e.type === 'outer');
    assert.ok(outer, 'Should have outer event');
    assert.strictEqual(outer.inner, 'nested', 'inner content should be attr of outer');
    assert.ok(outer.content.includes('before'), 'outer content should have before');
    assert.ok(outer.content.includes('after'), 'outer content should have after');

    const inner = events.find((e: any) => e.type === 'inner');
    assert.strictEqual(inner, undefined, 'Inner should be absorbed, not independent');
  });

  it('should absorb multiple children at once', () => {
    const results = collectSync(
      ['<p><b>bold</b><i>italic</i>tail</p>'],
      { legalTags: ['p', 'b', 'i'] }
    );
    const events = buildEvents(results);

    const p = events.find((e: any) => e.type === 'p');
    assert.ok(p, 'Should have p event');
    assert.strictEqual(p.b, 'bold', 'b content should be absorbed into p');
    assert.strictEqual(p.i, 'italic', 'i content should be absorbed into p');
    assert.ok(p.content.includes('tail'), 'p content should include tail text');
  });

  it('should deeply nest only 1 level (maxNestingDepth=1)', () => {
    const results = collectSync(
      ['<1><2><3>deep</3></2></1>'],
      { legalTags: ['1', '2', '3'], maxNestingDepth: 1 }
    );
    const events = buildEvents(results);

    const tag1 = events.find((e: any) => e.type === '1');
    assert.ok(tag1);
    assert.strictEqual(tag1['2'], '<3>deep</3>', '<3> should be raw text inside <2>');
  });

  it('should absorb multiple same-named children (last wins as attr)', () => {
    const results = collectSync(
      ['<div><x>a</x><x>b</x>mid<x>c</x></div>'],
      { legalTags: ['div', 'x'] }
    );
    const events = buildEvents(results);
    const div = events.find((e: any) => e.type === 'div');
    assert.ok(div);
    // Last <x>'s content wins as the attribute value
    assert.strictEqual(div.x, 'c', 'Last same-named child content wins as attr');
    assert.ok(div.content.includes('mid'), 'Text between children should be preserved');
  });
});

describe('maxNestingDepth', () => {
  it('should only parse root tags when maxNestingDepth=0', () => {
    const results = collectSync(
      ['<root><child>text</child></root>'],
      { legalTags: ['root', 'child'], maxNestingDepth: 0 }
    );
    const events = buildEvents(results);

    const root = events.find((e: any) => e.type === 'root');
    assert.ok(root, 'Root tag should be parsed');
    assert.strictEqual(
      root.content,
      '<child>text</child>',
      'Child tag should be raw text'
    );
    const child = events.find((e: any) => e.type === 'child');
    assert.strictEqual(child, undefined, 'Child should not be an independent event');
  });

  it('should handle mixed depths with sibling tags', () => {
    const results = collectSync(
      ['<1><2>inner</2><2>inner2</2></1>'],
      { legalTags: ['1', '2'], maxNestingDepth: 1 }
    );
    const events = buildEvents(results);
    const tag1 = events.find((e: any) => e.type === '1');
    assert.ok(tag1);
    assert.strictEqual(tag1['2'], 'inner2', 'Last child 2 content should be attr');
  });
});
