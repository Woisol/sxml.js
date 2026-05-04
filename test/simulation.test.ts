import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SxmlParser, SxmlResult } from '../src/index';
import { collectSync, buildEvents } from './helpers';

/**
 * Strip internal fields (name) that are not relevant for content comparison.
 * The `name` field is always set to the tag name by DefaultTagHandler.
 */
function cleanEvent(e: any) {
  const { name, ...rest } = e;
  void name;
  return rest;
}

/** Filter out empty text events (parser artifacts) */
function nonEmpty(events: any[]): any[] {
  return events.filter((e: any) => e.type !== 'text' || e.content !== '');
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
// confirmAt:'close' — realistic long-data streaming scenarios
// ============================================================

describe('simulation', () => {

  it('should stream long text with embedded think (9 chunks)', () => {
    const results = collectSync([
      '让我想一想',
      ' 嗯,这个问',
      '题需要我仔细',
      '思考一下<think>首',
      '先用户说的是一',
      '个编程问题,然后',
      '我考虑了几种实现方案',
      '</think>',
      '好的,根据以上分析,我的回答是...',
    ], { legalTags: ['think'] });

    const events = nonEmpty(buildEvents(results));
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(cleanEvent(events[0]), { type: 'text', content: '让我想一想 嗯,这个问题需要我仔细思考一下' });
    assert.deepStrictEqual(cleanEvent(events[1]), { type: 'think', content: '首先用户说的是一个编程问题,然后我考虑了几种实现方案' });
    assert.deepStrictEqual(cleanEvent(events[2]), { type: 'text', content: '好的,根据以上分析,我的回答是...' });
    assert.strictEqual(contentSum(events), '让我想一想 嗯,这个问题需要我仔细思考一下好的,根据以上分析,我的回答是...');
  });

  it('should handle think + tool_call with attributes across chunks', () => {
    const results = collectSync([
      '我来查一下天气',
      '<think>用户需',
      '要知道今天的天气',
      '</think><tool_call',
      ' name="get_weather"',
      ' city="Beijing">',
      '</tool_call>',
    ], { legalTags: ['think', 'tool_call'] });

    const events = nonEmpty(buildEvents(results));
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(cleanEvent(events[0]), { type: 'text', content: '我来查一下天气' });
    assert.deepStrictEqual(cleanEvent(events[1]), { type: 'think', content: '用户需要知道今天的天气' });
    assert.strictEqual(events[2].type, 'tool_call');
    assert.strictEqual(events[2].content, '');
    assert.strictEqual(events[2].name, 'get_weather');
    assert.strictEqual(events[2].city, 'Beijing');
  });

  it('should handle tool_call with JSON args split across chunks', () => {
    const results = collectSync([
      '<tool_call name="search"',
      ` args='{"query": "weather", "units": "metric"}'>`,
      '</tool_call>',
    ], { legalTags: ['tool_call'] });

    const events = nonEmpty(buildEvents(results));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'tool_call');
    assert.strictEqual(events[0].content, '');
    assert.strictEqual(events[0].name, 'search');
    assert.strictEqual(events[0].args, '{"query": "weather", "units": "metric"}');
  });

  it('should handle multiple tool calls interleaved with text', () => {
    const results = collectSync([
      '首先<tool_call name="calc" expression="1+1">',
      '</tool_call>',
      '结果是2',
      '接下来<tool_call name="search" q="hello">',
      '</tool_call>',
      '搜索完成',
    ], { legalTags: ['tool_call'] });

    const events = nonEmpty(buildEvents(results));
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
    assert.strictEqual(contentSum(events), '首先结果是2接下来搜索完成');
  });

  it('should preserve angle brackets in code-like text', () => {
    const results = collectSync([
      'In C++ we write vector<int>',
      ' and compare a < b.',
      ' In TypeScript, Array<string> is common.',
      '<think>The user is asking about C++ templates</think>',
      'So the type parameter goes inside < and >.',
    ], { legalTags: ['think'] });

    const events = nonEmpty(buildEvents(results));
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(cleanEvent(events[0]), {
      type: 'text',
      content: 'In C++ we write vector<int> and compare a < b. In TypeScript, Array<string> is common.',
    });
    assert.deepStrictEqual(cleanEvent(events[1]), { type: 'think', content: 'The user is asking about C++ templates' });
    assert.deepStrictEqual(cleanEvent(events[2]), { type: 'text', content: 'So the type parameter goes inside < and >.' });
    const ts = contentSum(events);
    assert.ok(ts.includes('vector<int>'));
    assert.ok(ts.includes('a < b'));
    assert.ok(ts.includes('Array<string>'));
  });

  it('should handle many consecutive self-closing tags', () => {
    const results = collectSync([
      '<br/><br/>',
      'line break<hr/>',
      'separator<br/>',
    ], { legalTags: ['br', 'hr'] });

    const events = nonEmpty(buildEvents(results));
    assert.strictEqual(events.filter((e: any) => e.type === 'br').length, 3);
    assert.strictEqual(events.filter((e: any) => e.type === 'hr').length, 1);
    const texts = events.filter((e: any) => e.type === 'text');
    assert.strictEqual(texts.length, 2);
    assert.deepStrictEqual(cleanEvent(texts[0]), { type: 'text', content: 'line break' });
    assert.deepStrictEqual(cleanEvent(texts[1]), { type: 'text', content: 'separator' });
  });

  it('should handle 10000 chars of text with a single embedded tag', () => {
    const longText = 'A'.repeat(5000);
    const results = collectSync(
      [longText + '<think>思考</think>' + longText],
      { legalTags: ['think'] }
    );

    const events = nonEmpty(buildEvents(results));
    const thinkEvent = events.find((e: any) => e.type === 'think');
    assert.ok(thinkEvent);
    assert.strictEqual(thinkEvent.content, '思考');
    assert.strictEqual(contentSum(events), longText + longText);
  });

  it('should handle one-character-at-a-time streaming', () => {
    const input = 'text<think>深</think>more';
    const results = collectSync(input.split(''), { legalTags: ['think'] });

    const events = nonEmpty(buildEvents(results));
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(cleanEvent(events[0]), { type: 'text', content: 'text' });
    assert.deepStrictEqual(cleanEvent(events[1]), { type: 'think', content: '深' });
    assert.deepStrictEqual(cleanEvent(events[2]), { type: 'text', content: 'more' });
  });

  it('should handle close tag split across chunks', () => {
    const results = collectSync([
      '<tool_call name="test"',
      '>analyze</tool_call',
      '>',
    ], { legalTags: ['tool_call'] });

    const events = nonEmpty(buildEvents(results));
    const tool = events.find((e: any) => e.type === 'tool_call');
    assert.ok(tool);
    assert.strictEqual(tool.name, 'test');
    assert.strictEqual(tool.content, 'analyze');
  });

  it('should handle deep nesting with maxNestingDepth=1', () => {
    const results = collectSync([
      '<1><2>',
      '<3>deep</3>',
      '</2></1>',
    ], { legalTags: ['1', '2', '3'], maxNestingDepth: 1 });

    const events = nonEmpty(buildEvents(results));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, '1');
    assert.strictEqual(events[0].content, '');
    assert.strictEqual(events[0]['2'], '<3>deep</3>');
  });

  it('should handle pure text with no tags at all', () => {
    const results = collectSync([
      'This is a long text with no tags at all. ',
      'It just keeps going and going. ',
      'No < or > should cause any issues. ',
      'The end.',
    ], { legalTags: ['think'] });

    const events = nonEmpty(buildEvents(results));
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'text');
    assert.strictEqual(
      events[0].content,
      'This is a long text with no tags at all. It just keeps going and going. No < or > should cause any issues. The end.'
    );
  });

  it('should handle multiple think tags in sequence (confirmAt:close)', () => {
    const results = collectSync([
      '<think>first thought</think>',
      'intervening text',
      '<think>second thought</think>',
    ], { legalTags: ['think'] });

    const events = nonEmpty(buildEvents(results));
    assert.strictEqual(events.length, 3);
    assert.deepStrictEqual(cleanEvent(events[0]), { type: 'think', content: 'first thought' });
    assert.deepStrictEqual(cleanEvent(events[1]), { type: 'text', content: 'intervening text' });
    assert.deepStrictEqual(cleanEvent(events[2]), { type: 'think', content: 'second thought' });
  });

  // ============================================================
  // confirmAt:'open' — realistic long-data streaming scenarios
  // (basic behavior covered in confirm-at-open.test.ts)
  // ============================================================

  describe('confirmAt-open', () => {
    const OPEN = { name: 'think', confirmAt: 'open' as const };

    it('should stream think content live across many chunks, verifying intermediate state', () => {
      const parser = new SxmlParser({ legalTags: [OPEN] });
      const allResults: SxmlResult[] = [];
      let rr: SxmlResult | null;

      // Chunk 1: text + open tag
      parser.write('前文<think>第一步');
      while ((rr = parser.tryPull()) !== null) allResults.push(rr);

      // After chunk 1: should have text("前文") + partial think("第一步")
      let events = nonEmpty(buildEvents([...allResults]));
      assert.strictEqual(events.length, 2);
      assert.deepStrictEqual(cleanEvent(events[0]), { type: 'text', content: '前文' });
      assert.strictEqual(events[1].type, 'think');
      assert.strictEqual(events[1].content, '第一步');

      // Chunk 2: more text inside think
      parser.write('，第二步');
      while ((rr = parser.tryPull()) !== null) allResults.push(rr);

      // Only the think event should have been updated; no new text events
      events = nonEmpty(buildEvents([...allResults]));
      const think2 = events.find((e: any) => e.type === 'think');
      assert.strictEqual(think2.content, '第一步，第二步');
      const text2 = events.filter((e: any) => e.type === 'text').map((t: any) => t.content).join('');
      assert.strictEqual(text2, '前文', 'No new text events should appear inside think');

      // Chunk 3: more text + close tag + after
      parser.write('，第三步</think>后文');
      parser.end();
      while ((rr = parser.tryPull()) !== null) allResults.push(rr);

      events = nonEmpty(buildEvents([...allResults]));
      assert.strictEqual(events.length, 3);
      assert.strictEqual(events[0].type, 'text');
      assert.strictEqual(events[0].content, '前文');
      assert.strictEqual(events[1].type, 'think');
      assert.strictEqual(events[1].content, '第一步，第二步，第三步');
      assert.strictEqual(events[2].type, 'text');
      assert.strictEqual(events[2].content, '后文');
    });

    it('should handle confirmAt:open think alongside confirmAt:close tool_call with realistic chunks', () => {
      const parser = new SxmlParser({ legalTags: [OPEN, 'tool_call'] });
      const allResults: any[] = [];

      // Chunk 1: text → open think → text insdie think
      parser.write('分析<think>需查询天气</think>调用<tool_call');
      let rr: SxmlResult | null;
      while ((rr = parser.tryPull()) !== null) allResults.push(rr);

      // Chunk 2: tool_call attrs + close
      parser.write(' name="weather" city="Beijing"></tool_call>完成');
      parser.end();
      while ((rr = parser.tryPull()) !== null) allResults.push(rr);

      const final1 = nonEmpty(buildEvents(allResults));
      assert.strictEqual(final1.length, 5);
      assert.deepStrictEqual(cleanEvent(final1[0]), { type: 'text', content: '分析' });
      assert.deepStrictEqual(cleanEvent(final1[1]), { type: 'think', content: '需查询天气' });
      assert.deepStrictEqual(cleanEvent(final1[2]), { type: 'text', content: '调用' });
      assert.strictEqual(final1[3].type, 'tool_call');
      assert.strictEqual(final1[3].name, 'weather');
      assert.strictEqual(final1[3].city, 'Beijing');
      assert.deepStrictEqual(cleanEvent(final1[4]), { type: 'text', content: '完成' });
    });

    it('should handle long confirmAt:open think with many small chunks and verify no text leakage', () => {
      const parser = new SxmlParser({ legalTags: [OPEN] });
      const allResults: any[] = [];

      // Simulate 10 small chat chunks flowing through a think block
      parser.write('开头');
      while ((rr = parser.tryPull()) !== null) allResults.push(rr);

      parser.write('<think>');
      while ((rr = parser.tryPull()) !== null) allResults.push(rr);

      // Write 8 small content chunks inside think
      const parts = ['正在', '逐步', '分析', '用户', '提出的', '编程', '问题', '…'];
      for (const p of parts) {
        parser.write(p);
        while ((rr = parser.tryPull()) !== null) allResults.push(rr);
      }

      parser.write('</think>结束');
      parser.end();
      while ((rr = parser.tryPull()) !== null) allResults.push(rr);

      const final3 = nonEmpty(buildEvents(allResults));
      assert.strictEqual(final3.length, 3);
      assert.deepStrictEqual(cleanEvent(final3[0]), { type: 'text', content: '开头' });
      assert.deepStrictEqual(cleanEvent(final3[1]), { type: 'think', content: '正在逐步分析用户提出的编程问题…' });
      assert.deepStrictEqual(cleanEvent(final3[2]), { type: 'text', content: '结束' });
    });
  });
});
