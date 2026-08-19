import { sleep } from '../utils.js';

class RequestQueue {
  constructor(delayMs = 300) {
    this.delayMs = delayMs;
    this.queues = new Map(); // domain -> Promise chain
    this.lastCallTimes = new Map(); // domain -> timestamp
  }

  async schedule(fn, domain = 'default') {
    let lastPromise = this.queues.get(domain) || Promise.resolve();

    const nextPromise = (async () => {
      await lastPromise.catch(() => {});

      const lastTime = this.lastCallTimes.get(domain) || 0;
      const elapsed = Date.now() - lastTime;
      if (elapsed < this.delayMs) {
        await sleep(this.delayMs - elapsed);
      }

      this.lastCallTimes.set(domain, Date.now());
      return await fn();
    })();

    this.queues.set(domain, nextPromise);
    return nextPromise;
  }
}

export const rateLimiter = new RequestQueue(300);
