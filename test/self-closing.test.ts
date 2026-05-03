import { describe, it } from 'node:test';
import assert from 'node:assert';
import { collectSync, buildEvents } from './helpers';

describe('self-closing tags', () => {
  it('should handle <br/>', () => {
    const results = collectSync(
      ['text<br/>more'],
      { legalTags: ['br'] }
    );
    const events = buildEvents(results);
    const br = events.find((e: any) => e.type === 'br');
    assert.ok(br, 'Should have br event');
    assert.strictEqual(br.content, '');
  });

  it('should handle <br /> with space', () => {
    const results = collectSync(
      ['text<br />more'],
      { legalTags: ['br'] }
    );
    const events = buildEvents(results);
    const br = events.find((e: any) => e.type === 'br');
    assert.ok(br, 'Should have br event with space variant');
  });

  it('should parse multiple consecutive self-closing tags', () => {
    const results = collectSync(
      ['<br/><hr/><img/>'],
      { legalTags: ['br', 'hr', 'img'] }
    );
    const events = buildEvents(results);
    assert.ok(events.find((e: any) => e.type === 'br'), 'Should have br');
    assert.ok(events.find((e: any) => e.type === 'hr'), 'Should have hr');
    assert.ok(events.find((e: any) => e.type === 'img'), 'Should have img');
  });

  it('should handle text around multiple self-closing tags', () => {
    const results = collectSync(
      ['start<br/>middle<hr/>end'],
      { legalTags: ['br', 'hr'] }
    );
    const events = buildEvents(results);
    assert.ok(events.find((e: any) => e.type === 'br'), 'Should have br');
    assert.ok(events.find((e: any) => e.type === 'hr'), 'Should have hr');

    const textEvents = events.filter((e: any) => e.type === 'text');
    const allText = textEvents.map((t: any) => t.content).join('');
    assert.ok(allText.includes('start'), 'Text before first tag should exist');
    assert.ok(allText.includes('middle'), 'Text between tags should exist');
    assert.ok(allText.includes('end'), 'Text after last tag should exist');
  });
});
