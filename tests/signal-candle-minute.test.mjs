import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSignalCandleMinute } from '../shared/signal-candle-minute.js';

test('signalCandleTs epoch-minute values are used directly and stay stable across retries', () => {
  const signal = { signalCandleTs: 29_926_455 };
  assert.equal(resolveSignalCandleMinute(signal), 29_926_455);
  assert.equal(resolveSignalCandleMinute(signal), resolveSignalCandleMinute(signal));
});

test('raw epoch-second and epoch-millisecond candle timestamps normalize to the same minute bucket', () => {
  const seconds = 1_795_587_300;
  const milliseconds = seconds * 1000;
  assert.equal(resolveSignalCandleMinute({ candleTs: seconds }), Math.floor(seconds / 60));
  assert.equal(resolveSignalCandleMinute({ candleTs: milliseconds }), Math.floor(milliseconds / 60_000));
});

test('missing or malformed signal candle timestamps fail closed instead of using wall-clock time', () => {
  assert.equal(resolveSignalCandleMinute({}), null);
  assert.equal(resolveSignalCandleMinute({ signalCandleTs: 0 }), null);
  assert.equal(resolveSignalCandleMinute({ signalCandleTs: 'invalid' }), null);
  assert.equal(resolveSignalCandleMinute({ candleTs: 12345 }), null);
});
