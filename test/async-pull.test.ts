import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SxmlParser } from '../src/index';

describe('async pull()', () => {
  it('should resolve after write()', async () => {
    const parser = new SxmlParser({ legalTags: ['think'] });

    const pullPromise = parser.pull();

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

  it('should resolve null after end() when queue is empty', async () => {
    const parser = new SxmlParser({ legalTags: ['think'] });
    parser.write('<think>done</think>');
    parser.end();

    while (parser.tryPull() !== null) {}

    const final = await parser.pull();
    assert.strictEqual(final, null);
  });

  it('should handle multiple sequential pull() calls', async () => {
    const parser = new SxmlParser({ legalTags: ['think'] });

    const p1 = parser.pull();

    setTimeout(() => {
      parser.write('<think>hello</think>');
      parser.end();
    }, 5);

    const r1 = await p1;
    assert.ok(r1 !== null);
    while (parser.tryPull() !== null) {}

    const r2 = await parser.pull();
    assert.strictEqual(r2, null);
  });

  it('should resolve for each write chunk independently', async () => {
    const parser = new SxmlParser({ legalTags: ['think'] });

    // Fire p1 → write → p1 resolves
    const p1 = parser.pull();
    await new Promise(r => setTimeout(r, 5));
    parser.write('hello');
    const r1 = await p1;
    assert.ok(r1 !== null, 'Should get result for hello');

    // p2 waits while parser is still open, then end()
    const p2 = parser.pull();
    await new Promise(r => setTimeout(r, 5));
    parser.write(' world');
    parser.end();
    const r2 = await p2;
    assert.ok(r2 !== null, 'Should get result for world');
  });
});
