import { describe, it, expect } from 'vitest';
import { Mutex } from '../src/interfaces/soroban/mutex';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Mutex', () => {
  it('serializes async tasks in submission order', async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    const first = createDeferred<void>();
    const second = createDeferred<void>();
    const third = createDeferred<void>();

    const p1 = mutex.run(async () => {
      order.push(1);
      await first.promise;
      order.push(1);
    });

    const p2 = mutex.run(async () => {
      order.push(2);
      await second.promise;
      order.push(2);
    });

    const p3 = mutex.run(async () => {
      order.push(3);
      await third.promise;
      order.push(3);
    });

    // Only the first task should have started.
    await Promise.resolve();
    expect(order).toEqual([1]);

    first.resolve();
    await p1;
    // After the first completes, the second should start.
    await Promise.resolve();
    expect(order).toEqual([1, 1, 2]);

    second.resolve();
    await p2;
    await Promise.resolve();
    expect(order).toEqual([1, 1, 2, 2, 3]);

    third.resolve();
    await p3;
    expect(order).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('propagates the resolved value to the caller', async () => {
    const mutex = new Mutex();
    const result = await mutex.run(async () => 42);
    expect(result).toBe(42);
  });

  it('propagates the resolved value for queued tasks', async () => {
    const mutex = new Mutex();
    const gate = createDeferred<void>();

    const p1 = mutex.run(async () => {
      await gate.promise;
      return 'first';
    });
    const p2 = mutex.run(async () => 'second');

    gate.resolve();

    await expect(p1).resolves.toBe('first');
    await expect(p2).resolves.toBe('second');
  });

  it('propagates a rejection to the caller', async () => {
    const mutex = new Mutex();
    const error = new Error('boom');

    await expect(
      mutex.run(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  it('continues processing subsequent tasks after a rejection (tail recovery)', async () => {
    const mutex = new Mutex();
    const error = new Error('boom');
    const order: string[] = [];

    const p1 = mutex.run(async () => {
      order.push('first');
      throw error;
    });
    const p2 = mutex.run(async () => {
      order.push('second');
      return 'second-result';
    });
    const p3 = mutex.run(async () => {
      order.push('third');
      return 'third-result';
    });

    await expect(p1).rejects.toBe(error);
    await expect(p2).resolves.toBe('second-result');
    await expect(p3).resolves.toBe('third-result');

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('serializes tasks even when a queued task rejects', async () => {
    const mutex = new Mutex();
    const order: number[] = [];
    const gate = createDeferred<void>();
    const error = new Error('queued failure');

    const p1 = mutex.run(async () => {
      order.push(1);
      await gate.promise;
      order.push(1);
    });
    const p2 = mutex.run(async () => {
      order.push(2);
      throw error;
    });
    const p3 = mutex.run(async () => {
      order.push(3);
      return 'done';
    });

    await Promise.resolve();
    expect(order).toEqual([1]);

    gate.resolve();
    await p1;
    await expect(p2).rejects.toBe(error);
    await expect(p3).resolves.toBe('done');

    expect(order).toEqual([1, 1, 2, 3]);
  });

  it('runs tasks sequentially when many are queued', async () => {
    const mutex = new Mutex();
    let active = 0;
    let maxActive = 0;
    const results: number[] = [];

    const tasks = Array.from({ length: 10 }, (_, i) =>
      mutex.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        results.push(i);
        return i;
      }),
    );

    const resolved = await Promise.all(tasks);

    expect(maxActive).toBe(1);
    expect(resolved).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});