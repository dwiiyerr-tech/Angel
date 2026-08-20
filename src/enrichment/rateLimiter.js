import { sleep } from '../utils.js';

// Per-provider priority queue. Jupiter is budgeted at roughly 1 request/sec;
// entry/exit quotes must jump ahead of background enrichment and monitoring.
class RequestQueue {
  constructor(delayMs = 1000) {
    this.delayMs = delayMs;
    this.queues = new Map();
    this.sequence = 0;
  }

  schedule(fn, domain = 'default', priority = 0) {
    if (!this.queues.has(domain)) this.queues.set(domain, { pending: [], running: false, lastCallAt: 0 });
    const queue = this.queues.get(domain);
    return new Promise((resolve, reject) => {
      queue.pending.push({ fn, priority: Number(priority) || 0, sequence: this.sequence++, resolve, reject });
      queue.pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
      this.#pump(domain, queue);
    });
  }

  #pump(domain, queue) {
    if (queue.running || queue.pending.length === 0) return;
    queue.running = true;
    const item = queue.pending.shift();
    void (async () => {
      try {
        const elapsed = Date.now() - queue.lastCallAt;
        if (elapsed < this.delayMs) await sleep(this.delayMs - elapsed);
        queue.lastCallAt = Date.now();
        item.resolve(await item.fn());
      } catch (error) {
        item.reject(error);
      } finally {
        queue.running = false;
        this.#pump(domain, queue);
      }
    })();
  }
}

export const rateLimiter = new RequestQueue(1000);
export const REQUEST_PRIORITY = Object.freeze({ MONITOR: 10, ENRICHMENT: 20, ENTRY_EXIT: 100 });
