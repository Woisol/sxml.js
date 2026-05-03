import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SxmlParser, SxmlConfig, SxmlResult } from '../src/index';

/**
 * Helper: collect all events from a parser that processes chunks
 * with intermediate pull() calls between chunks (streaming simulation).
 *
 * Returns the final event list; empty text events (content === '') are
 * filtered out since they represent consumed/cleared text.
 */
function simulateStreaming(
  chunks: string[],
  config: SxmlConfig,
  options?: { pullBetweenChunks?: boolean }
): any[] {
  const parser = new SxmlParser(config);
  const events: any[] = [];

  function drain() {
    let r: SxmlResult | null;
    while ((r = parser.tryPull()) !== null) {
      if (r.update) events[events.length - 1] = r.update;
      events.push(...r.append);
    }
  }

  for (const chunk of chunks) {
    parser.write(chunk);
    if (options?.pullBetweenChunks !== false) drain();
  }
  parser.end();
  drain();

  // Filter out empty text events — they represent consumed text, not content
  return events.filter((e: any) => e.type !== 'text' || e.content !== '');
}

/**
 * Strip internal fields (name) that are not relevant for content comparison.
 * The `name` field is always set to the tag name by DefaultTagHandler.
 */
function cleanEvent(e: any) {
  const { name, ...rest } = e;
  void name; // not used in comparison
  return rest;
}

/**
 * Compute the "content total": all text event contents joined together.
 */
function contentSum(events: any[]): string {
  return events
    .filter((e: any) => e.type === 'text')
    .map((e: any) => e.content)
    .join('');
}

// ============================================================
// Simulation scenarios
// ============================================================

describe('simulation', () => {

  it('should stream text before, during, and after a think tag', () => {
    const chunks = [
      '让我想一想',
      ' 嗯,这个问',
      '题需要我仔细',
      '思考一下<think>首',
      '先用户说的是一',
      '个编程问题,然后',
      '我考虑了几种实现方案',
      '</think>',
      '好的,根据以上分析,我的回答是...',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['think'] });

    // Exact event sequence
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(cleanEvent(events[0]), { type: 'text', content: '让我想一想 嗯,这个问题需要我仔细思考一下' });
    assert.deepStrictEqual(cleanEvent(events[1]), { type: 'think', content: '首先用户说的是一个编程问题,然后我考虑了几种实现方案' });
    assert.deepStrictEqual(cleanEvent(events[2]), { type: 'text', content: '好的,根据以上分析,我的回答是...' });

    // Verify full text reconstruction matches original text outside tags
    const textSum = contentSum(events);
    assert.strictEqual(textSum, '让我想一想 嗯,这个问题需要我仔细思考一下好的,根据以上分析,我的回答是...');
  });

  it('should handle think + tool_call flow', () => {
    const chunks = [
      '我来查一下天气',
      '<think>用户需',
      '要知道今天的天气',
      '</think><tool_call',
      ' name="get_weather"',
      ' city="Beijing">',
      '</tool_call>',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['think', 'tool_call'] });

    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(cleanEvent(events[0]), { type: 'text', content: '我来查一下天气' });
    assert.deepStrictEqual(cleanEvent(events[1]), { type: 'think', content: '用户需要知道今天的天气' });
    // tool_call with attributes
    assert.strictEqual(events[2].type, 'tool_call');
    assert.strictEqual(events[2].content, '');
    assert.strictEqual(events[2].name, 'get_weather');
    assert.strictEqual(events[2].city, 'Beijing');
  });

  it('should handle tool_call with JSON args attribute', () => {
    const chunks = [
      '<tool_call name="search"',
      ` args='{"query": "weather", "units": "metric"}'>`,
      '</tool_call>',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['tool_call'] });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'tool_call');
    assert.strictEqual(events[0].content, '');
    assert.strictEqual(events[0].name, 'search');
    assert.strictEqual(events[0].args, '{"query": "weather", "units": "metric"}');
  });

  it('should handle multiple tool calls with interleaved text', () => {
    const chunks = [
      '首先<tool_call name="calc" expression="1+1">',
      '</tool_call>',
      '结果是2',
      '接下来<tool_call name="search" q="hello">',
      '</tool_call>',
      '搜索完成',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['tool_call'] });

    assert.strictEqual(events.length, 5);
    assert.deepStrictEqual(cleanEvent(events[0]), { type: 'text', content: '首先' });
    assert.strictEqual(events[1].type, 'tool_call');
    assert.strictEqual(events[1].name, 'calc');
    assert.strictEqual(events[1].expression, '1+1');
    assert.deepStrictEqual(cleanEvent(events[2]), { type: 'text', content: '结果是2接下来' });
    assert.strictEqual(events[3].type, 'tool_call');
    assert.strictEqual(events[3].name, 'search');
    assert.strictEqual(events[3].q, 'hello');
    assert.deepStrictEqual(cleanEvent(events[4]), { type: 'text', content: '搜索完成' });

    // Verify no content loss
    const textSum = contentSum(events);
    assert.strictEqual(textSum, '首先结果是2接下来搜索完成');
  });

  it('should handle text containing angle brackets', () => {
    const chunks = [
      'In C++ we write vector<int>',
      ' and compare a < b.',
      ' In TypeScript, Array<string> is common.',
      '<think>The user is asking about C++ templates</think>',
      'So the type parameter goes inside < and >.',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['think'] });

    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(cleanEvent(events[0]), {
      type: 'text',
      content: 'In C++ we write vector<int> and compare a < b. In TypeScript, Array<string> is common.',
    });
    assert.deepStrictEqual(cleanEvent(events[1]), {
      type: 'think',
      content: 'The user is asking about C++ templates',
    });
    assert.deepStrictEqual(cleanEvent(events[2]), {
      type: 'text',
      content: 'So the type parameter goes inside < and >.',
    });

    // Verify < > in text are preserved, not consumed as tags
    const textSum = contentSum(events);
    assert.ok(textSum.includes('vector<int>'));
    assert.ok(textSum.includes('a < b'));
    assert.ok(textSum.includes('Array<string>'));
    assert.ok(textSum.includes('inside < and >'));
  });

  it('should handle many self-closing tags in a line', () => {
    const chunks = [
      '<br/><br/>',
      'line break<hr/>',
      'separator<br/>',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['br', 'hr'] });

    const brs = events.filter((e: any) => e.type === 'br');
    const hrs = events.filter((e: any) => e.type === 'hr');
    assert.strictEqual(brs.length, 3, 'Should have 3 br events');
    assert.strictEqual(hrs.length, 1, 'Should have 1 hr event');

    const textEvents = events.filter((e: any) => e.type === 'text');
    assert.strictEqual(textEvents.length, 2);
    assert.deepStrictEqual(cleanEvent(textEvents[0]), { type: 'text', content: 'line break' });
    assert.deepStrictEqual(cleanEvent(textEvents[1]), { type: 'text', content: 'separator' });
  });

  it('should handle long text with embedded tag', () => {
    const longText = 'A'.repeat(5000);
    const chunks = [
      longText + '<think>思考</think>' + longText,
    ];

    const events = simulateStreaming(chunks, { legalTags: ['think'] });

    const thinkEvent = events.find((e: any) => e.type === 'think');
    assert.ok(thinkEvent);
    assert.strictEqual(thinkEvent.content, '思考');

    const textSum = contentSum(events);
    assert.strictEqual(textSum, longText + longText);
  });

  it('should handle one-character-at-a-time streaming', () => {
    const input = 'text<think>深</think>more';
    const chunks = input.split('');

    const events = simulateStreaming(chunks, { legalTags: ['think'] });

    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(cleanEvent(events[0]), { type: 'text', content: 'text' });
    assert.deepStrictEqual(cleanEvent(events[1]), { type: 'think', content: '深' });
    assert.deepStrictEqual(cleanEvent(events[2]), { type: 'text', content: 'more' });
  });

  it('should handle close tag split across chunks', () => {
    const chunks = [
      '<tool_call name="test"',
      '>analyze</tool_call',
      '>',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['tool_call'] });

    const tool = events.find((e: any) => e.type === 'tool_call');
    assert.ok(tool);
    assert.strictEqual(tool.name, 'test');
    assert.strictEqual(tool.content, 'analyze');
  });

  it('should handle deep nesting with maxNestingDepth=1', () => {
    const chunks = [
      '<1><2>',
      '<3>deep</3>',
      '</2></1>',
    ];

    const events = simulateStreaming(chunks, {
      legalTags: ['1', '2', '3'],
      maxNestingDepth: 1,
    });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, '1');
    assert.strictEqual(events[0].content, '');
    // Tag 3 is beyond depth 1 → raw XML inside tag 2 → absorbed as attr of tag 1
    assert.strictEqual(events[0]['2'], '<3>deep</3>');
  });

  it('should handle pure text with no XML tags', () => {
    const chunks = [
      'This is a long text with no tags at all. ',
      'It just keeps going and going. ',
      'No < or > should cause any issues. ',
      'The end.',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['think'] });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'text');
    const expected = 'This is a long text with no tags at all. It just keeps going and going. No < or > should cause any issues. The end.';
    assert.strictEqual(events[0].content, expected);
  });

  it('should handle a tag with no surrounding text', () => {
    const events = simulateStreaming(
      ['<book>content</book>'],
      { legalTags: ['book'] }
    );

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'book');
    assert.strictEqual(events[0].content, 'content');
  });

  it('should handle multiple think tags in sequence', () => {
    const chunks = [
      '<think>first thought</think>',
      'intervening text',
      '<think>second thought</think>',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['think'] });

    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(cleanEvent(events[0]), { type: 'think', content: 'first thought' });
    assert.deepStrictEqual(cleanEvent(events[1]), { type: 'text', content: 'intervening text' });
    assert.deepStrictEqual(cleanEvent(events[2]), { type: 'think', content: 'second thought' });
  });
});
