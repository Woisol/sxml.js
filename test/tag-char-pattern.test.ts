import { describe, it } from 'node:test';
import assert from 'node:assert';
import { collectSync, buildEvents } from './helpers';

describe('tagCharPattern', () => {
  it('should recognize tags matching custom pattern without legalTags', () => {
    const results = collectSync(
      ['<my-tag>content</my-tag>'],
      { tagCharPattern: /^[a-zA-Z0-9-]$/ }
    );
    const events = buildEvents(results);
    const tag = events.find((e: any) => e.type === 'my-tag');
    assert.ok(tag, 'Tag matching pattern should be recognized');
    assert.strictEqual(tag.content, 'content');
  });

  it('should treat tags not matching pattern as text', () => {
    const results = collectSync(
      ['<123num>text</123num>'],
      { tagCharPattern: /^[a-zA-Z]$/ }
    );
    const events = buildEvents(results);
    const tag = events.find((e: any) => e.type === '123num');
    assert.strictEqual(tag, undefined, 'Tag not matching pattern should not produce event');
    const rawText = events.some(
      (e: any) => e.type === 'text' && e.content.includes('<123num>')
    );
    assert.ok(rawText, 'Non-matching tag should appear as text');
  });
});
