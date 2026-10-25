import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMORY_LOG_INTERVAL_MS,
  formatMemoryLog,
  summarizeMemoryUsage
} from '../worker/memory-monitor.mjs';

test('memory logging samples every five minutes', () => {
  assert.equal(MEMORY_LOG_INTERVAL_MS, 300_000);
});

test('memory metrics summarize RSS, heap, and external allocations in MiB', () => {
  const metrics = summarizeMemoryUsage({
    rss: 64 * 1024 * 1024,
    heapTotal: 32 * 1024 * 1024,
    heapUsed: 12 * 1024 * 1024,
    external: 4 * 1024 * 1024,
    arrayBuffers: 2 * 1024 * 1024
  });
  assert.deepEqual(metrics, {
    rssMb: 64,
    heapTotalMb: 32,
    heapUsedMb: 12,
    externalMb: 4,
    arrayBuffersMb: 2
  });
  assert.match(formatMemoryLog(metrics), /\[Memory\] Heap Used: 12\.00 MB/);
  assert.match(formatMemoryLog(metrics), /RSS: 64\.00 MB/);
});
