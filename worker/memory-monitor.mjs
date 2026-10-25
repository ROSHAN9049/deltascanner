export const MEMORY_LOG_INTERVAL_MS = 5 * 60 * 1000;
const BYTES_PER_MB = 1024 * 1024;

const toMb = value => Number((Math.max(0, Number(value) || 0) / BYTES_PER_MB).toFixed(2));

export function summarizeMemoryUsage(memoryUsage = process.memoryUsage()) {
  return {
    rssMb: toMb(memoryUsage?.rss),
    heapTotalMb: toMb(memoryUsage?.heapTotal),
    heapUsedMb: toMb(memoryUsage?.heapUsed),
    externalMb: toMb(memoryUsage?.external),
    arrayBuffersMb: toMb(memoryUsage?.arrayBuffers)
  };
}

export function formatMemoryLog(metrics = {}) {
  const heapUsedMb = Number(metrics.heapUsedMb) || 0;
  const rssMb = Number(metrics.rssMb) || 0;
  const heapTotalMb = Number(metrics.heapTotalMb) || 0;
  const externalMb = Number(metrics.externalMb) || 0;
  return `[Memory] Heap Used: ${heapUsedMb.toFixed(2)} MB | RSS: ${rssMb.toFixed(2)} MB | Heap Total: ${heapTotalMb.toFixed(2)} MB | External: ${externalMb.toFixed(2)} MB`;
}
