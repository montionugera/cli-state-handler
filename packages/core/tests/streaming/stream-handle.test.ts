import { describe, it, expect, vi } from 'vitest';
import { StreamHandle, type StreamSlice } from '../../src/index.js';

describe('StreamHandle', () => {
  it('creates instance with default values and abort controller', () => {
    const handle = new StreamHandle();
    expect(handle.queryHash).toBe('');
    expect(handle.isDone).toBe(false);
    expect(handle.isCancelled).toBe(false);
    expect(handle.abortController).toBeInstanceOf(AbortController);
    expect(handle.abortSignal).toBe(handle.abortController.signal);
    expect(handle.abortSignal.aborted).toBe(false);
    expect(handle.done).toBeInstanceOf(Promise);
  });

  it('accepts queryHash and custom abortController in options', () => {
    const controller = new AbortController();
    const handle = new StreamHandle({ queryHash: 'custom-hash-123', abortController: controller });
    expect(handle.queryHash).toBe('custom-hash-123');
    expect(handle.abortController).toBe(controller);
    expect(handle.abortSignal).toBe(controller.signal);
  });

  it('accepts string as queryHash in constructor', () => {
    const handle = new StreamHandle('hash-xyz');
    expect(handle.queryHash).toBe('hash-xyz');
  });

  it('consumes pushed slices via for await and resolves done promise on end()', async () => {
    const handle = new StreamHandle<string>('query-1');

    const slices: StreamSlice<string>[] = [];
    const consumePromise = (async () => {
      for await (const slice of handle) {
        slices.push(slice);
      }
    })();

    handle.push({
      delta: 'Hello',
      cumulative: 'Hello',
      seq: 0,
      byteOffset: 0,
      done: false,
    });

    handle.push({
      delta: ' world',
      cumulative: 'Hello world',
      seq: 1,
      byteOffset: 5,
      done: false,
    });

    handle.push({
      delta: '!',
      cumulative: 'Hello world!',
      seq: 2,
      byteOffset: 11,
      done: true,
    });

    handle.end('Hello world!');

    await consumePromise;

    expect(slices).toHaveLength(3);
    expect(slices[0].delta).toBe('Hello');
    expect(slices[1].delta).toBe(' world');
    expect(slices[2].delta).toBe('!');
    expect(slices[2].done).toBe(true);

    const finalPayload = await handle.done;
    expect(finalPayload).toBe('Hello world!');
    expect(handle.isDone).toBe(true);
  });

  it('automatically ends and resolves done when slice with done: true is pushed', async () => {
    const handle = new StreamHandle<string>();

    const slices: StreamSlice<string>[] = [];
    const consumePromise = (async () => {
      for await (const slice of handle) {
        slices.push(slice);
      }
    })();

    handle.push({
      delta: 'Part 1',
      cumulative: 'Part 1',
      seq: 0,
      byteOffset: 0,
      done: false,
    });

    handle.push({
      delta: ' Part 2',
      cumulative: 'Part 1 Part 2',
      seq: 1,
      byteOffset: 6,
      done: true,
    });

    await consumePromise;

    expect(slices).toHaveLength(2);
    expect(await handle.done).toBe('Part 1 Part 2');
    expect(handle.isDone).toBe(true);
  });

  it('buffers slices before consumer starts iterating (backpressure & pre-buffering)', async () => {
    const handle = new StreamHandle<string>({ highWaterMark: 10 });

    handle.push({ delta: 'A', cumulative: 'A', seq: 0, byteOffset: 0, done: false });
    handle.push({ delta: 'B', cumulative: 'AB', seq: 1, byteOffset: 1, done: false });
    handle.push({ delta: 'C', cumulative: 'ABC', seq: 2, byteOffset: 2, done: true });

    expect(handle.bufferedAmount).toBe(3);

    const received: string[] = [];
    for await (const slice of handle) {
      received.push(slice.delta);
    }

    expect(received).toEqual(['A', 'B', 'C']);
    expect(handle.bufferedAmount).toBe(0);
    expect(await handle.done).toBe('ABC');
  });

  it('reports backpressure when highWaterMark is exceeded', () => {
    const handle = new StreamHandle<string>({ highWaterMark: 2 });
    const ok1 = handle.push({ delta: 'A', cumulative: 'A', seq: 0, byteOffset: 0, done: false });
    const ok2 = handle.push({ delta: 'B', cumulative: 'AB', seq: 1, byteOffset: 1, done: false });
    expect(ok1).toBe(true);
    expect(ok2).toBe(false); // queue length is 2 >= highWaterMark
    expect(handle.bufferedAmount).toBe(2);
  });

  it('halts iteration and aborts signal when cancel() is called', async () => {
    const handle = new StreamHandle<string>();
    const abortListener = vi.fn();
    handle.abortSignal.addEventListener('abort', abortListener);

    const slices: StreamSlice<string>[] = [];
    const consumePromise = (async () => {
      for await (const slice of handle) {
        slices.push(slice);
        if (slice.seq === 0) {
          handle.cancel('User requested cancel');
        }
      }
    })();

    handle.push({
      delta: 'Chunk 1',
      cumulative: 'Chunk 1',
      seq: 0,
      byteOffset: 0,
      done: false,
    });

    handle.push({
      delta: 'Chunk 2',
      cumulative: 'Chunk 1Chunk 2',
      seq: 1,
      byteOffset: 7,
      done: false,
    });

    await consumePromise;

    expect(slices).toHaveLength(1);
    expect(slices[0].delta).toBe('Chunk 1');
    expect(handle.isCancelled).toBe(true);
    expect(handle.isDone).toBe(true);
    expect(handle.abortSignal.aborted).toBe(true);
    expect(abortListener).toHaveBeenCalledTimes(1);

    await expect(handle.done).rejects.toThrow('User requested cancel');
  });

  it('halts iteration if abortController.abort() is called externally', async () => {
    const controller = new AbortController();
    const handle = new StreamHandle<string>({ abortController: controller });

    const slices: StreamSlice<string>[] = [];
    const consumePromise = (async () => {
      for await (const slice of handle) {
        slices.push(slice);
      }
    })();

    handle.push({
      delta: 'data',
      cumulative: 'data',
      seq: 0,
      byteOffset: 0,
      done: false,
    });

    controller.abort('timeout');
    await consumePromise;

    expect(slices).toHaveLength(1);
    expect(handle.isCancelled).toBe(true);
    expect(handle.abortSignal.aborted).toBe(true);
    await expect(handle.done).rejects.toThrow();
  });

  it('propagates error() to pending iterator and rejects done promise', async () => {
    const handle = new StreamHandle<string>();

    const iterator = handle[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    const testError = new Error('Upstream network failure');
    handle.error(testError);

    await expect(nextPromise).rejects.toThrow('Upstream network failure');
    await expect(handle.done).rejects.toThrow('Upstream network failure');
    expect(handle.isDone).toBe(true);

    // Subsequent next() calls should also reject with the same error
    await expect(iterator.next()).rejects.toThrow('Upstream network failure');
  });

  it('rejects subsequent push calls after cancel or end', () => {
    const handle = new StreamHandle<string>();
    handle.end('done');
    const pushed = handle.push({
      delta: 'late',
      cumulative: 'donelate',
      seq: 1,
      byteOffset: 4,
      done: false,
    });
    expect(pushed).toBe(false);

    const cancelledHandle = new StreamHandle<string>();
    cancelledHandle.cancel();
    const pushedCancelled = cancelledHandle.push({
      delta: 'late',
      cumulative: 'late',
      seq: 0,
      byteOffset: 0,
      done: false,
    });
    expect(pushedCancelled).toBe(false);
  });

  it('is idempotent on multiple cancel(), end(), and error() calls', () => {
    const handle = new StreamHandle<string>();
    handle.cancel('first cancel');
    handle.cancel('second cancel');
    expect(handle.isCancelled).toBe(true);

    const handle2 = new StreamHandle<string>();
    handle2.end('first');
    handle2.end('second');
    expect(handle2.isDone).toBe(true);

    const handle3 = new StreamHandle<string>();
    handle3.error(new Error('first err'));
    handle3.error(new Error('second err'));
    expect(handle3.isDone).toBe(true);
  });

  it('supports iterator return and throw methods', async () => {
    const handle = new StreamHandle<string>();
    const iterator = handle[Symbol.asyncIterator]();

    const returnResult = await iterator.return?.('retVal');
    expect(returnResult).toEqual({ done: true, value: 'retVal' });

    const testErr = new Error('iterator throw');
    await expect(iterator.throw?.(testErr)).rejects.toThrow('iterator throw');
  });

  it('supports breaking out of for-await loop early without issues', async () => {
    const handle = new StreamHandle<number>();
    handle.push({ delta: 1, cumulative: 1, seq: 0, byteOffset: 0, done: false });
    handle.push({ delta: 2, cumulative: 3, seq: 1, byteOffset: 4, done: false });
    handle.push({ delta: 3, cumulative: 6, seq: 2, byteOffset: 8, done: true });

    const collected: number[] = [];
    for await (const slice of handle) {
      collected.push(slice.delta);
      if (slice.delta === 1) {
        break;
      }
    }

    expect(collected).toEqual([1]);
  });
});

