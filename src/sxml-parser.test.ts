import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SxmlParser, SxmlResult, SxmlConfig, ErrorStrategy } from './index';

function collectSync(chunks: string[], config?: SxmlConfig): SxmlResult[] {
  const parser = new SxmlParser(config ?? { legalTags: ['think'] });
  const results: SxmlResult[] = [];

  for (const chunk of chunks) {
    parser.write(chunk);
    let result: SxmlResult | null;
    while ((result = parser.tryPull()) !== null) {
      results.push(result);
    }
  }
  parser.end();
  let result: SxmlResult | null;
  while ((result = parser.tryPull()) !== null) {
    results.push(result);
  }

  return results;
}

function buildEvents(results: SxmlResult[]) {
  const events: any[] = [];
  for (const r of results) {
    if (r.update) {
      events[events.length - 1] = r.update;
    }
    events.push(...r.append);
  }
  return events;
}

// ============================================================
// Tests
// ============================================================

describe('SxmlParser', () => {
  describe('basic text streaming', () => {
    it('should output plain text', () => {
      const results = collectSync(['hello world']);
      // At least one result with text content
      assert.ok(results.length >= 1);
      const events = buildEvents(results);
      assert.ok(events.some((e: any) => e.type === 'text' && e.content === 'hello world'));
    });

    it('should stream text across multiple chunks with update', () => {
      const results = collectSync(['hello', ' world']);
      assert.ok(results.length >= 2);
      // First: append text('hello')
      assert.ok(results[0].append.some((e: any) => e.type === 'text' && e.content === 'hello'));
      // Second: update to text('hello world')
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

      // Should show raw XML as text before close
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
  });

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
  });

  describe('chunk boundary handling', () => {
    it('should handle tag name split across chunks', () => {
      const results = collectSync(
        ['<thi', 'nk>content</think>'],
        { legalTags: ['think'] }
      );
      const events = buildEvents(results);
      const think = events.find((e: any) => e.type === 'think');
      assert.ok(think);
      assert.strictEqual(think.content, 'content');
    });

    it('should handle attribute value split across chunks', () => {
      const results = collectSync(
        ['<tool_call name="re', 'ad">done</tool_call>'],
        { legalTags: ['tool_call'] }
      );
      const events = buildEvents(results);
      const tc = events.find((e: any) => e.type === 'tool_call');
      assert.ok(tc);
      assert.strictEqual(tc.name, 'read');
    });

    it('should handle close tag split across chunks', () => {
      const results = collectSync(
        ['<think>content</thi', 'nk>'],
        { legalTags: ['think'] }
      );
      const events = buildEvents(results);
      const think = events.find((e: any) => e.type === 'think');
      assert.ok(think);
    });
  });

  describe('error handling', () => {
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

  describe('custom TagHandler', () => {
    it('should use custom handler when provided', () => {
      const results = collectSync(
        ['<tool_call name="calc">4</tool_call>'],
        {
          legalTags: ['tool_call'],
          tagHandlers: {
            tool_call: {
              build(tagName: string, attrs: Record<string, string>, children: any[]) {
                const content = children
                  .filter((c: any) => c.type === 'text')
                  .map((c: any) => c.content)
                  .join('');
                return { type: 'tool_call', toolName: attrs.name, result: Number(content) };
              },
            },
          },
        }
      );
      const events = buildEvents(results);
      const tc = events.find((e: any) => e.type === 'tool_call');
      assert.ok(tc);
      assert.strictEqual(tc.toolName, 'calc');
      assert.strictEqual(tc.result, 4);
      assert.strictEqual((tc as any).name, undefined);
    });
  });

  describe('async pull()', () => {
    it('should resolve after write()', async () => {
      const parser = new SxmlParser({ legalTags: ['think'] });

      const pullPromise = parser.pull();

      // Schedule write after a short delay
      await new Promise<void>(resolve => {
        setTimeout(() => {
          parser.write('<think>hello</think>');
          parser.end();
          resolve();
        }, 10);
      });

      const result = await pullPromise;
      assert.ok(result !== null, 'Should get a result');
      assert.ok(result!.append.length > 0 || result!.update !== undefined);
    });
  });

  describe('reset()', () => {
    it('should allow reuse after reset', () => {
      const parser = new SxmlParser({ legalTags: ['think'] });

      parser.write('<think>first</think>');
      parser.end();
      while (parser.tryPull() !== null) {
        void 0;
      }

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

  // ============================================================
  // Attribute handling
  // ============================================================

  describe('attribute handling', () => {
    it('should parse single-quoted attributes', () => {
      const results = collectSync(
        ["<tag name='value' key='val2'>text</tag>"],
        { legalTags: ['tag'] }
      );
      const events = buildEvents(results);
      const tag = events.find((e: any) => e.type === 'tag');
      assert.ok(tag);
      assert.strictEqual(tag.name, 'value');
      assert.strictEqual(tag.key, 'val2');
      assert.strictEqual(tag.content, 'text');
    });

    it('should handle nested quotes in attribute values', () => {
      const results = collectSync(
        ['<tool_call name="read" args=\'{"key":"val"}\'>done</tool_call>'],
        { legalTags: ['tool_call'] }
      );
      const events = buildEvents(results);
      const tc = events.find((e: any) => e.type === 'tool_call');
      assert.ok(tc);
      assert.strictEqual(tc.name, 'read');
      assert.strictEqual(tc.args, '{"key":"val"}');
    });

    it('should handle boolean attributes (name only, no value)', () => {
      const results = collectSync(
        ['<input disabled>text</input>'],
        { legalTags: ['input'] }
      );
      const events = buildEvents(results);
      const tag = events.find((e: any) => e.type === 'input');
      assert.ok(tag);
      assert.strictEqual(tag.disabled, '');
    });
  });

  // ============================================================
  // ErrorStrategy modes
  // ============================================================

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
        // b is unclosed but absorbed into a via DefaultTagHandler
        const a = events.find((e: any) => e.type === 'a');
        assert.ok(a, 'Tag a should be resolved despite inner mismatch');
        // b should be absorbed as an attr of a (default handler behavior)
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
        // Should not throw
        parser.end();
        let r: SxmlResult | null;
        while ((r = parser.tryPull()) !== null) {
          void 0;
        }
        // No exception = pass
      });
    });

    describe('LENIENT mode', () => {
      it('should recover from mismatched close tag without throwing', () => {
        const parser = new SxmlParser({
          legalTags: ['a', 'b'],
          errorStrategy: ErrorStrategy.LENIENT,
        });
        // Should not throw — LENIENT recovers
        parser.write('<a><b></a>');
        parser.end();
        const events: any[] = [];
        let r: SxmlResult | null;
        while ((r = parser.tryPull()) !== null) {
          if (r.update) events[events.length - 1] = r.update;
          events.push(...r.append);
        }
        // Should still produce events for the tags it can resolve
        const a = events.find((e: any) => e.type === 'a');
        assert.ok(a, 'Tag a should resolve despite mismatch');
      });

      it('should recover from unexpected close tag with empty stack', () => {
        const parser = new SxmlParser({
          legalTags: ['a'],
          errorStrategy: ErrorStrategy.LENIENT,
        });
        // Close tag without any open tag
        parser.write('</a>');
        parser.end();
        // Should not throw
        const events: any[] = [];
        let r: SxmlResult | null;
        while ((r = parser.tryPull()) !== null) {
          if (r.update) events[events.length - 1] = r.update;
          events.push(...r.append);
        }
        // The unexpected close tag should be treated as text
        const hasCloseAsText = events.some(
          (e: any) => e.type === 'text' && e.content.includes('</a>')
        );
        assert.ok(hasCloseAsText, 'Unexpected close tag should appear as text');
      });
    });
  });

  // ============================================================
  // Multiple sibling tags
  // ============================================================

  describe('multiple sibling tags', () => {
    it('should parse multiple sibling tags independently', () => {
      const results = collectSync(
        ['<a>first</a><b>second</b>'],
        { legalTags: ['a', 'b'] }
      );
      const events = buildEvents(results);

      const a = events.find((e: any) => e.type === 'a');
      assert.ok(a, 'Should have a event');
      assert.strictEqual(a.content, 'first');

      const b = events.find((e: any) => e.type === 'b');
      assert.ok(b, 'Should have b event');
      assert.strictEqual(b.content, 'second');
    });

    it('should parse multiple self-closing siblings', () => {
      const results = collectSync(
        ['<br/><hr/>'],
        { legalTags: ['br', 'hr'] }
      );
      const events = buildEvents(results);
      const br = events.find((e: any) => e.type === 'br');
      const hr = events.find((e: any) => e.type === 'hr');
      assert.ok(br, 'Should have br');
      assert.ok(hr, 'Should have hr');
    });

    it('should interleave text and tags correctly with siblings', () => {
      const results = collectSync(
        ['before<a>inA</a>between<b>inB</b>after'],
        { legalTags: ['a', 'b'] }
      );
      const events = buildEvents(results);

      const a = events.find((e: any) => e.type === 'a');
      const b = events.find((e: any) => e.type === 'b');
      assert.ok(a);
      assert.ok(b);
      assert.strictEqual(a.content, 'inA');
      assert.strictEqual(b.content, 'inB');

      // Verify text exists
      const text = events.filter((e: any) => e.type === 'text');
      assert.ok(text.length === 3, 'Should have three text events');
      const allText = text.map((t: any) => t.content).join('');
      assert.ok(allText.includes('before'));
      assert.ok(allText.includes('between'));
      assert.ok(allText.includes('after'));
    });
  });

  // ============================================================
  // maxNestingDepth variations
  // ============================================================

  describe('maxNestingDepth', () => {
    it('should only parse root tags when maxNestingDepth=0', () => {
      const results = collectSync(
        ['<root><child>text</child></root>'],
        { legalTags: ['root', 'child'], maxNestingDepth: 0 }
      );
      const events = buildEvents(results);

      const root = events.find((e: any) => e.type === 'root');
      assert.ok(root, 'Root tag should be parsed');
      // child tag is beyond depth 0, should be raw XML inside root
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
      // Both 2 tags should be absorbed
      assert.strictEqual(tag1['2'], 'inner2', 'Last child 2 content should be attr');
    });
  });

  // ============================================================
  // Custom tag handler edge cases
  // ============================================================

  describe('custom TagHandler edge cases', () => {
    it('should discard tag when handler returns null', () => {
      const results = collectSync(
        ['<skip>ignored</skip>'],
        {
          legalTags: ['skip'],
          tagHandlers: {
            skip: {
              build() {
                return null; // explicitly discard
              },
            },
          },
        }
      );
      const events = buildEvents(results);
      const skip = events.find((e: any) => e.type === 'skip');
      assert.strictEqual(skip, undefined, 'Tag should be discarded');
    });

    it('should invoke custom handler for self-closing tag', () => {
      const results = collectSync(
        ['<br/>'],
        {
          legalTags: ['br'],
          tagHandlers: {
            br: {
              build(tagName, attrs, children) {
                return {
                  type: 'linebreak',
                  selfClosing: true,
                  childCount: children.length,
                };
              },
            },
          },
        }
      );
      const events = buildEvents(results);
      const br = events.find((e: any) => e.type === 'linebreak');
      assert.ok(br, 'Custom handler should fire for self-closing tag');
      assert.strictEqual(br.selfClosing, true);
      assert.strictEqual(br.childCount, 0);
    });

    it('should support multiple custom handlers simultaneously', () => {
      const results = collectSync(
        ['<bold>heavy</bold><italic>slant</italic>'],
        {
          legalTags: ['bold', 'italic'],
          tagHandlers: {
            bold: {
              build(tagName, attrs, children) {
                const content = children
                  .filter((c: any) => c.type === 'text')
                  .map((c: any) => c.content)
                  .join('');
                return { type: 'styled', style: 'bold', content };
              },
            },
            italic: {
              build(tagName, attrs, children) {
                const content = children
                  .filter((c: any) => c.type === 'text')
                  .map((c: any) => c.content)
                  .join('');
                return { type: 'styled', style: 'italic', content };
              },
            },
          },
        }
      );
      const events = buildEvents(results);
      const styled = events.filter((e: any) => e.type === 'styled');
      assert.strictEqual(styled.length, 2);
      assert.strictEqual(styled[0].style, 'bold');
      assert.strictEqual(styled[0].content, 'heavy');
      assert.strictEqual(styled[1].style, 'italic');
      assert.strictEqual(styled[1].content, 'slant');
    });
  });

  // ============================================================
  // Async pull edge cases
  // ============================================================

  describe('async pull edge cases', () => {
    it('should resolve null after end() when queue is empty', async () => {
      const parser = new SxmlParser({ legalTags: ['think'] });
      parser.write('<think>done</think>');
      parser.end();

      // Consume all events
      let result: SxmlResult | null;
      while ((result = parser.tryPull()) !== null) {
        void 0;
      }

      // Next pull should resolve null
      const final = await parser.pull();
      assert.strictEqual(final, null);
    });

    it('should handle multiple sequential pull() calls', async () => {
      const parser = new SxmlParser({ legalTags: ['think'] });

      // Start a pull before any write
      const p1 = parser.pull();

      // Write and end after a short delay
      setTimeout(() => {
        parser.write('<think>hello</think>');
        parser.end();
      }, 5);

      const r1 = await p1;
      assert.ok(r1 !== null);
      // Consume remaining
      while (parser.tryPull() !== null) {
        void 0;
      }

      const r2 = await parser.pull();
      assert.strictEqual(r2, null);
    });
  });

  // ============================================================
  // tagCharPattern without legalTags
  // ============================================================

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

  // ============================================================
  // Chunk boundary edge cases
  // ============================================================

  describe('chunk boundary edge cases', () => {
    it('should handle chunk ending at <', () => {
      const results = collectSync(
        ['text<', 'tag>content</tag>'],
        { legalTags: ['tag'] }
      );
      const events = buildEvents(results);
      const tag = events.find((e: any) => e.type === 'tag');
      assert.ok(tag);
      assert.strictEqual(tag.content, 'content');
    });

    it('should handle self-closing tag split across chunks', () => {
      const results = collectSync(
        ['before<br', '/>after'],
        { legalTags: ['br'] }
      );
      const events = buildEvents(results);
      const br = events.find((e: any) => e.type === 'br');
      assert.ok(br, 'Self-closing tag split across chunks should work');
    });

    it('should handle attribute value split at the quote boundary', () => {
      const results = collectSync(
        ['<tag name=', '"val">text</tag>'],
        { legalTags: ['tag'] }
      );
      const events = buildEvents(results);
      const tag = events.find((e: any) => e.type === 'tag');
      assert.ok(tag);
      assert.strictEqual(tag.name, 'val');
      assert.strictEqual(tag.content, 'text');
    });

    it('should handle chunks with only whitespace between tags', () => {
      const results = collectSync(
        ['<a>1</a>', ' ', '<b>2</b>'],
        { legalTags: ['a', 'b'] }
      );
      const events = buildEvents(results);
      const a = events.find((e: any) => e.type === 'a');
      const b = events.find((e: any) => e.type === 'b');
      assert.ok(a);
      assert.ok(b);
      assert.strictEqual(a.content, '1');
      assert.strictEqual(b.content, '2');
    });
  });

  // ============================================================
  // Buffer overflow
  // ============================================================

  describe('buffer overflow', () => {
    it('should throw when buffer exceeds maxBufferSize', () => {
      const parser = new SxmlParser({
        maxBufferSize: 10,
      });
      assert.throws(() => {
        parser.write('12345678901'); // 11 chars > 10
      }, /Buffer size exceeded/);
    });
  });
});
