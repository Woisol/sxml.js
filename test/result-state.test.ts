import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SxmlParser, SxmlResult } from '../src/index';

function drain(parser: SxmlParser): SxmlResult[] {
  const results: SxmlResult[] = [];
  let result: SxmlResult | null;
  while ((result = parser.tryPull()) !== null) {
    results.push(result);
  }
  return results;
}

describe('result state API', () => {
  it('should expose isEnd as parser end state', () => {
    const parser = new SxmlParser({ legalTags: ['think'] });

    assert.strictEqual(parser.isEnd, false);


    parser.end();

    assert.strictEqual(parser.isEnd, true);


    parser.reset();
    assert.strictEqual(parser.isEnd, false);
  });

  it('should return update null when resolving a tag clears the previous raw text event', () => {
    const parser = new SxmlParser({ legalTags: ['think'] });

    parser.write('<think>');
    drain(parser);


    parser.write('hello</think>');
    const results = drain(parser);

    assert.ok(
      results.some(result => result.update === null),
      'Expected update:null to clear the previously streamed raw XML text event'
    );
  });

  it('should return update null when an open-confirmed tag clears previous raw text', () => {
    const parser = new SxmlParser({ legalTags: [{ name: 'think', confirmAt: 'open' }] });

    parser.write('<think');
    drain(parser);


    parser.write('>hello');
    const results = drain(parser);

    assert.ok(
      results.some(result => result.update === null),
      'Expected update:null to clear the previously streamed raw XML text event at open confirmation'
    );
  });

  it('should expose lastConfirm as true when the last event is stable', () => {
    const parser = new SxmlParser({ legalTags: ['think'] });

    assert.strictEqual(parser.lastConfirm, false);


    parser.write('<think>hello</think>');
    drain(parser);


    assert.strictEqual(parser.lastConfirm, true);
  });

  it('should expose lastConfirm as false while the last event can still update', () => {
    const parser = new SxmlParser({ legalTags: [{ name: 'think', confirmAt: 'open' }] });

    parser.write('<think>');
    drain(parser);
    assert.strictEqual(parser.lastConfirm, false);


    parser.write('hello');
    drain(parser);
    assert.strictEqual(parser.lastConfirm, false);


    parser.write('</think>');
    drain(parser);
    assert.strictEqual(parser.lastConfirm, true);
  });

  it('should expose lastConfirm as false for a streaming text event', () => {
    const parser = new SxmlParser({ legalTags: ['think'] });

    parser.write('hello');
    drain(parser);

    assert.strictEqual(parser.lastConfirm, false);
  });
});
