import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SxmlParser, SxmlConfig, SxmlResult } from '../src/index';

/**
 * Helper: collect all results from a parser that processes chunks
 * with intermediate pull() calls between chunks (streaming simulation)
 */
function simulateStreaming(
  chunks: string[],
  config: SxmlConfig,
  options?: { pullBetweenChunks?: boolean }
): any[] {
  const parser = new SxmlParser(config);
  const allResults: SxmlResult[] = [];
  const events: any[] = [];

  function drain() {
    let r: SxmlResult | null;
    while ((r = parser.tryPull()) !== null) {
      allResults.push(r);
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

  return events;
}

// ============================================================
// Realistic simulation scenarios
// ============================================================

describe('simulation', () => {
  // Claude-style: text → think → text
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

    // Should have text events for all the streaming text
    const textEvents = events.filter((e: any) => e.type === 'text');
    const allText = textEvents.map((t: any) => t.content).join('');

    assert.ok(allText.includes('让我想一想'), 'Opening text should be present');
    assert.ok(allText.includes('嗯,这个问题需要我仔细思考一下'), 'Chinese text should be present');
    assert.ok(allText.includes('好的,根据以上分析,我的回答是...'), 'Closing text should be present');

    // Should have a think business event
    const thinkEvent = events.find((e: any) => e.type === 'think');
    assert.ok(thinkEvent, 'Should have think business event');
    assert.ok(
      (thinkEvent.content as string).includes('首先用户说的是一个编程问题'),
      'Think content should contain the thinking text'
    );
    assert.ok(
      (thinkEvent.content as string).includes('我考虑了几种实现方案'),
      'Think content should contain all thinking text'
    );
  });

  // Claude: tool call with thinking
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

    const thinkEvent = events.find((e: any) => e.type === 'think');
    assert.ok(thinkEvent, 'Should have think event');
    assert.ok(
      (thinkEvent.content as string).includes('用户需要知道今天的天气'),
      'Think content should be present'
    );

    const toolEvent = events.find((e: any) => e.type === 'tool_call');
    assert.ok(toolEvent, 'Should have tool_call event');
    assert.strictEqual(toolEvent.name, 'get_weather');
    assert.ok(toolEvent.content === '' || toolEvent.content === undefined,
      'Self-closing tool_call should have no content'
    );
  });

  // Complex tool call with nested attribute quoting
  it('should handle tool_call with JSON args attribute', () => {
    const chunks = [
      '<tool_call name="search"',
      ' args=\'{"query": "weather", "units": "metric"}\'>',
      '</tool_call>',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['tool_call'] });
    const tool = events.find((e: any) => e.type === 'tool_call');
    assert.ok(tool, 'Should have tool_call event');
    assert.strictEqual(tool.name, 'search');
    // JSON string in single-quoted attribute
    const args = tool.args as string;
    assert.ok(args.includes('query'), 'Args should contain query');
    assert.ok(args.includes('weather'), 'Args should contain weather');
    assert.ok(args.includes('metric'), 'Args should contain units');
  });

  // Multiple tool calls with text between
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

    const toolCalls = events.filter((e: any) => e.type === 'tool_call');
    assert.strictEqual(toolCalls.length, 2, 'Should have two tool_call events');

    const calc = toolCalls[0];
    assert.strictEqual(calc.name, 'calc');
    assert.strictEqual(calc.expression, '1+1');

    const search = toolCalls[1];
    assert.strictEqual(search.name, 'search');
    assert.strictEqual(search.q, 'hello');

    const textEvents = events.filter((e: any) => e.type === 'text');
    const allText = textEvents.map((t: any) => t.content).join('');
    assert.ok(allText.includes('首先'), 'Text before first tool should be present');
    assert.ok(allText.includes('结果是2'), 'Text between tools should be present');
    assert.ok(allText.includes('搜索完成'), 'Text after last tool should be present');
  });

  // Text containing angle brackets (like generics, comparisons)
  it('should handle text containing angle brackets', () => {
    const chunks = [
      'In C++ we write vector<int>',
      ' and compare a < b.',
      ' In TypeScript, Array<string> is common.',
      '<think>The user is asking about C++ templates</think>',
      'So the type parameter goes inside < and >.',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['think'] });

    const thinkEvent = events.find((e: any) => e.type === 'think');
    assert.ok(thinkEvent, 'Should extract think tag despite angle brackets in text');

    const textEvents = events.filter((e: any) => e.type === 'text');
    const allText = textEvents.map((t: any) => t.content).join('');
    assert.ok(allText.includes('vector<int>'), 'Angle bracket text before tag should be preserved');
    assert.ok(allText.includes('a < b'), 'Less-than in text should be preserved');
    assert.ok(allText.includes('Array<string>'), 'Generic syntax should be preserved');
    assert.ok(allText.includes('inside < and >'), 'Angle bracket text after tag should be preserved');
  });

  // Self-closing tags with text
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
    const allText = textEvents.map((t: any) => t.content).join('');
    assert.ok(allText.includes('line break'), 'Text between tags should be preserved');
    assert.ok(allText.includes('separator'), 'Text after tags should be preserved');
  });

  // Large text with a tag - single chunk
  it('should handle long text with embedded tag', () => {
    const longText = 'A'.repeat(5000);
    const chunks = [
      longText + '<think>思考</think>' + longText,
    ];

    const events = simulateStreaming(chunks, { legalTags: ['think'] });

    const thinkEvent = events.find((e: any) => e.type === 'think');
    assert.ok(thinkEvent, 'Should extract think from long text');
    assert.strictEqual(thinkEvent.content, '思考');

    const textEvents = events.filter((e: any) => e.type === 'text');
    const allText = textEvents.map((t: any) => t.content).join('');
    assert.strictEqual(
      (allText.match(/A/g) || []).length,
      10000,
      'All As should be preserved (5000 before + 5000 after)'
    );
  });

  // Chunks at every character boundary for a tag
  it('should handle one-character-at-a-time streaming', () => {
    const input = 'text<think>深</think>more';
    const chunks = input.split(''); // One char per chunk

    const events = simulateStreaming(chunks, { legalTags: ['think'] });

    const thinkEvent = events.find((e: any) => e.type === 'think');
    assert.ok(thinkEvent, 'Should extract think from character-level streaming');
    assert.strictEqual(thinkEvent.content, '深');

    const textEvents = events.filter((e: any) => e.type === 'text');
    const allText = textEvents.map((t: any) => t.content).join('');
    assert.ok(allText.startsWith('text'), 'Text before tag should be preserved');
    assert.ok(allText.endsWith('more'), 'Text after tag should be preserved');
  });

  // Close tag split across chunks at realistic token boundaries
  it('should handle close tag split across chunks', () => {
    const chunks = [
      '<tool_call name="test"',
      '>analyze</tool_call',
      '>',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['tool_call'] });

    const tool = events.find((e: any) => e.type === 'tool_call');
    assert.ok(tool, 'Should parse tool_call despite close tag split');
    assert.strictEqual(tool.content, 'analyze');
    assert.strictEqual(tool.name, 'test');
  });

  // Complex nesting where depth is exceeded at various points
  it('should handle partial deep nesting across chunks', () => {
    const chunks = [
      '<1><2>',
      '<3>deep</3>',
      '</2></1>',
    ];

    const events = simulateStreaming(chunks, {
      legalTags: ['1', '2', '3'],
      maxNestingDepth: 1,
    });

    const tag1 = events.find((e: any) => e.type === '1');
    assert.ok(tag1, 'Tag 1 should be parsed');
    assert.strictEqual(
      tag1['2'],
      '<3>deep</3>',
      'Tag 2 should contain raw <3> text since depth exceeds limit'
    );
  });

  // Text only with NO tags
  it('should handle pure text with no XML tags', () => {
    const chunks = [
      'This is a long text with no tags at all. ',
      'It just keeps going and going. ',
      'No < or > should cause any issues. ',
      'The end.',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['think'] });

    const textEvents = events.filter((e: any) => e.type === 'text');
    assert.ok(textEvents.length >= 1, 'Should have text events');
    const allText = textEvents.map((t: any) => t.content).join('');
    assert.ok(allText.includes('This is a long text'));
    assert.ok(allText.includes('The end.'));
    assert.strictEqual(
      events.find((e: any) => e.type !== 'text'),
      undefined,
      'Only text events should be emitted'
    );
  });

  // Tag with no text around it
  it('should handle a tag surrounded by no text content', () => {
    const chunks = [
      '<book>content</book>',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['book'] });

    const book = events.find((e: any) => e.type === 'book');
    assert.ok(book, 'Should have book event');
    assert.strictEqual(book.content, 'content');

    const textEvents = events.filter((e: any) => e.type === 'text');
    // The text events are internal and may be empty strings
    // The book event is the only meaningful event
    assert.strictEqual(book.content, 'content');
  });

  // Multiple think tags (thinking and re-thinking pattern)
  it('should handle multiple think tags in sequence', () => {
    const chunks = [
      '<think>first thought</think>',
      'intervening text',
      '<think>second thought</think>',
    ];

    const events = simulateStreaming(chunks, { legalTags: ['think'] });

    const thinks = events.filter((e: any) => e.type === 'think');
    assert.strictEqual(thinks.length, 2, 'Should have two think events');
    assert.strictEqual(thinks[0].content, 'first thought');
    assert.strictEqual(thinks[1].content, 'second thought');

    const textEvents = events.filter((e: any) => e.type === 'text');
    const allText = textEvents.map((t: any) => t.content).join('');
    assert.ok(allText.includes('intervening text'), 'Text between thinks should be preserved');
  });
});
