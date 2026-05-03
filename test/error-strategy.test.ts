import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SxmlParser, ErrorStrategy } from '../src/index';
import { collectSync, buildEvents } from './helpers';

describe('ErrorStrategy', () => {
  describe('STRICT mode', () => {
    it('should throw on mismatched close tag', () => {
      const parser = new SxmlParser({
        legalTags: ['a', 'b'],
        errorStrategy: ErrorStrategy.STRICT,
      });
      assert.throws(() => {
        parser.write('<a><b></a>');
      }, /Mismatched closing tag/);
    });

    it('should throw on unclosed tag at end()', () => {
      const parser = new SxmlParser({
        legalTags: ['think'],
        errorStrategy: ErrorStrategy.STRICT,
      });
      parser.write('<think>content');
      assert.throws(() => {
        parser.end();
      }, /Unclosed tag/);
    });

    it('should throw on unexpected close tag with empty stack', () => {
      const parser = new SxmlParser({
        legalTags: ['a'],
        errorStrategy: ErrorStrategy.STRICT,
      });
      assert.throws(() => {
        parser.write('</a>');
      }, /Unexpected closing tag/);
    });
  });

  describe('SILENT mode', () => {
    it('should silently recover from mismatched close tag', () => {
      const results = collectSync(
        ['<a><b></a>'],
        {
          legalTags: ['a', 'b'],
          errorStrategy: ErrorStrategy.SILENT,
        }
      );
      const events = buildEvents(results);
      const a = events.find((e: any) => e.type === 'a');
      assert.ok(a, 'Tag a should be resolved despite inner mismatch');
      assert.strictEqual(a!['b'], '', 'b content should be absorbed into a');
      const b = events.find((e: any) => e.type === 'b');
      assert.strictEqual(b, undefined, 'b should be absorbed, not independent');
    });

    it('should silently suppress unclosed tags at end()', () => {
      const parser = new SxmlParser({
        legalTags: ['think'],
        errorStrategy: ErrorStrategy.SILENT,
      });
      parser.write('<think>content');
      parser.end();
      let r: SxmlResult | null;
      while ((r = parser.tryPull()) !== null) {}
    });

    it('should not throw on unexpected close tag', () => {
      const parser = new SxmlParser({
        legalTags: ['a'],
        errorStrategy: ErrorStrategy.SILENT,
      });
      parser.write('</a>');
      parser.end();
      let r: SxmlResult | null;
      while ((r = parser.tryPull()) !== null) {}
    });
  });

  describe('LENIENT mode', () => {
    it('should recover from mismatched close tag without throwing', () => {
      const parser = new SxmlParser({
        legalTags: ['a', 'b'],
        errorStrategy: ErrorStrategy.LENIENT,
      });
      parser.write('<a><b></a>');
      parser.end();
      const events: any[] = [];
      let r: SxmlResult | null;
      while ((r = parser.tryPull()) !== null) {
        if (r.update) events[events.length - 1] = r.update;
        events.push(...r.append);
      }
      const a = events.find((e: any) => e.type === 'a');
      assert.ok(a, 'Tag a should resolve despite mismatch');
    });

    it('should recover from unexpected close tag with empty stack', () => {
      const parser = new SxmlParser({
        legalTags: ['a'],
        errorStrategy: ErrorStrategy.LENIENT,
      });
      parser.write('</a>');
      parser.end();
      const events: any[] = [];
      let r: SxmlResult | null;
      while ((r = parser.tryPull()) !== null) {
        if (r.update) events[events.length - 1] = r.update;
        events.push(...r.append);
      }
      const hasCloseAsText = events.some(
        (e: any) => e.type === 'text' && e.content.includes('</a>')
      );
      assert.ok(hasCloseAsText, 'Unexpected close tag should appear as text');
    });
  });
});

describe('buffer overflow', () => {
  it('should throw when buffer exceeds maxBufferSize', () => {
    const parser = new SxmlParser({
      maxBufferSize: 10,
    });
    assert.throws(() => {
      parser.write('12345678901');
    }, /Buffer size exceeded/);
  });
});

describe('unknown tags', () => {
  it('should treat unknown tags as text with legalTags', () => {
    const results = collectSync(
      ['<unknown>text</unknown>'],
      { legalTags: ['known'] }
    );
    const events = buildEvents(results);

    const hasUnknownTag = events.some((e: any) => e.type === 'unknown');
    assert.ok(!hasUnknownTag, 'Unknown tag should not produce business event');
    const hasText = events.some((e: any) => e.type === 'text' && e.content.includes('<unknown>'));
    assert.ok(hasText, 'Unknown tag should appear as text');
  });
});
