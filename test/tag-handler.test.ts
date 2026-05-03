import { describe, it } from 'node:test';
import assert from 'node:assert';
import { collectSync, buildEvents } from './helpers';

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

  it('should discard tag when handler returns null', () => {
    const results = collectSync(
      ['<skip>ignored</skip>'],
      {
        legalTags: ['skip'],
        tagHandlers: {
          skip: {
            build() {
              return null;
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

  it('should pass attributes and children to custom handler', () => {
    const results = collectSync(
      ['<transform scale="2"><input>raw</input></transform>'],
      {
        legalTags: ['transform', 'input'],
        tagHandlers: {
          transform: {
            build(tagName, attrs, children) {
              const textContent = children
                .filter((c: any) => c.type === 'text')
                .map((c: any) => c.content)
                .join('');
              const sub = children.find((c: any) => c.type !== 'text');
              return {
                type: 'transformed',
                scale: Number(attrs.scale),
                text: textContent,
                child: sub || null,
              };
            },
          },
        },
      }
    );
    const events = buildEvents(results);
    const t = events.find((e: any) => e.type === 'transformed');
    assert.ok(t);
    assert.strictEqual(t.scale, 2);
    // input uses DefaultHandler and is passed as a child to transform (not absorbed
    // because parent uses custom handler — absorption only with two default handlers)
    assert.ok(t.child, 'Input should be passed as a child event');
    assert.strictEqual(t.child.type, 'input');
    assert.strictEqual(t.child.content, 'raw');
  });
});
