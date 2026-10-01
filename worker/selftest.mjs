import assert from 'node:assert/strict';
import { analyse, normalizeCandles, volumeRatio } from './strategy.mjs';

function makeCandles(count, start, drift, baseVolume = 100, bumpLast = false) {
  const rows = [];
  let price = start;
  for (let i = 0; i < count; i++) {
    const open = price;
    const direction = i % 5 === 0 ? -drift * 0.2 : drift;
    price = Math.max(1, price + direction);
    rows.push({
      time: 1700000000 + i * 60,
      open,
      high: Math.max(open, price) + 0.2,
      low: Math.min(open, price) - 0.2,
      close: price,
      volume: baseVolume * (bumpLast && i === count - 2 ? 2 : 1)
    });
  }
  return rows;
}

const unsorted = [
  {time: 3, open: 3, high: 4, low: 2, close: 3.5, volume: 3},
  {time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1},
  {time: 2, open: 2, high: 3, low: 1, close: 2.5, volume: 2}
];
assert.deepEqual(normalizeCandles(unsorted).map(x => x.time), [1,2,3]);
assert.equal(normalizeCandles([...unsorted, {...unsorted[0]}]).length, 3);

const c1 = makeCandles(100, 100, 0.4, 100, true);
const c5 = makeCandles(100, 100, 0.15, 100, false);
const c15 = makeCandles(100, 100, 0.08, 100, false);
const btc5 = makeCandles(100, 100, 0.12, 100, false);
const btc15 = makeCandles(100, 100, 0.06, 100, false);
const ticker = {symbol:'BTCUSD', mark_price: 140, close: 140, ltp_change_24h: 1.2, turnover_usd: 1000000, quotes:{best_bid:139.9,best_ask:140.1}};
const product = {id:27, tick_size:0.5, contract_value:1, taker_commission_rate:0.0005, maker_commission_rate:0.0002, notional_type:'vanilla', max_leverage_notional:100000};

const scalp = analyse(ticker, product, c1, c5, c15, btc5, btc15, 'SCALPING', {minStopPct:0.75, rr:1.8, scoreMin:80});
const mom = analyse(ticker, product, c1, c5, c15, btc5, btc15, 'MOMENTUM', {minStopPct:0.95, rr:2.5, scoreMin:80});
assert.ok(Number.isFinite(scalp.score) && scalp.score >= 0 && scalp.score <= 100);
assert.ok(Number.isFinite(mom.score) && mom.score >= 0 && mom.score <= 100);
assert.notEqual(scalp.volumeSpike, mom.volumeSpike);
assert.notEqual(scalp.tp, mom.tp);
assert.ok(Array.isArray(scalp.blocked));
assert.equal(analyse(ticker, product, c1.slice(0,20), c5.slice(0,20), c15.slice(0,20), btc5.slice(0,20), btc15.slice(0,20), 'SCALPING', {minStopPct:0.75, rr:2, scoreMin:80}).candlesFresh, false);

const zeroVolume = makeCandles(40, 100, 0.1, 0, false);
assert.equal(volumeRatio(zeroVolume), 0);

console.log('DeltaScanner self-test PASS • normalized candles • strategy-specific 1m/5m engines • score bounds • TP/RR separation • freshness gate');
