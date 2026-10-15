# Strategy Indicators and Risk-Gate Diagnostics

This document describes the scanner's existing indicator calculations, additive diagnostic helpers, dashboard evidence, and offline score-distribution analysis.

## Observation Propagation Fix

**Before:** `worker/strategy.mjs` calculated `rangeAtr` and `emaDistanceAtr` inside `analyse()`, but `worker/engine.mjs` did not persist those observations in the `dd_signal_cache.details` object. The dashboard looked for legacy keys such as `rangeAtrRatio`/`range_atr_ratio`, so the gates displayed `UNKNOWN` even though the worker had already calculated the values.

**After:** the cache now includes the additive fields `details.rangeAtr` and `details.emaDistanceAtr`. The dashboard reads these exact names. If either observation or its strategy threshold is unavailable, that dashboard gate returns `BLOCK` with a reason instead of `UNKNOWN`.

This is a **display/evidence fix only**. It does not alter signal generation, `riskGate()`, `openTrade()`, trading settings, or position-ledger behavior. The worker's own `riskGate()` remains authoritative for live signal decisions.

## Threshold Parity

| Strategy | Worker range | Dashboard range | Worker EMA | Dashboard EMA |
| --- | ---: | ---: | ---: | ---: |
| Momentum | 4 ATR | 4 ATR | 3.5 ATR | 3.5 ATR |
| Scalp | 3 ATR | 3 ATR | 2.5 ATR | 2.5 ATR |

The worker persists strategies as `MOMENTUM` and `SCALPING`; the dashboard also accepts `SCALP` as a label alias. The range observation is calculated on the strategy's entry candle timeframe: Momentum uses 5m candles, while Scalping uses 1m entry candles. The dashboard therefore labels this gate **Entry candle range**, rather than implying every strategy uses a 5m entry candle.

## Indicator Utilities

### Existing worker indicators

`worker/strategy.mjs` remains the source for the existing `ema`, `atr`, `rsi`, `vwap`, and `volumeRatio` helpers, as well as `analyse()` and `analyseOption()`. These functions were deliberately not reimplemented in the new utility module.

### Additional pure utilities: `src/indicators/ta.mjs`

- `calculateMACD(prices, fast = 12, slow = 26, signal = 9)` returns the latest MACD line, signal line, and histogram.
- `calculateBollingerBands(prices, period = 20, stdDev = 2)` returns upper, middle, and lower bands, using population standard deviation.
- `calculateZScore(value, mean, stddev)` returns a z-score; when standard deviation is zero, it returns zero because the sample has no measurable spread.
- `computeStats(values)` returns mean, population standard deviation, minimum, maximum, and count. NaN observations are ignored; invalid or empty samples throw.

The module is pure and performs no network, database, order, or trading operations.

### Risk diagnostics: `src/indicators/risk-gates.mjs`

The pure helper module exports `gateRangeATR`, `gateEMADistance`, `gateBTCRegime`, `gateSpread`, `gateFeeSpreadVs1R`, `gateAntiChase`, and `computeAllGates`. It is useful for isolated validation and tests; it is **not wired into the worker's live signal decision path**. Missing inputs are fail-closed by these helpers.

The anti-chase diagnostic thresholds are absolute moves of **15% over 24h**, **8% over 1h**, and **5% over 15m**. The existing live `analyse()` currently evaluates its own 24h anti-chase rule; these additional timeframe checks are diagnostics and must not be assumed to be active in live signal generation.

## BTC Regime: Data Limitation and Dashboard Approximation

The intended full BTC regime calculation uses 1h candles with EMA50, EMA200, and ATR14. However, `worker/delta-adapter.mjs` currently maps only `1m`, `5m`, and `15m` to their proper durations; an unrecognized resolution such as `1h` falls back to **300 seconds**. Calling `candles('BTCUSD', '1h', 250)` consequently requests a time window of approximately `(250 + 3) × 300` seconds, or **21.1 hours**, not approximately 253 hours. That window cannot provide 200 hourly observations for EMA200. This is a request-window limitation in the current adapter; it is not proof that Delta's endpoint itself lacks 1h support.

Until the adapter can request an adequate hourly history, the dashboard's labeled approximation can use BTC's 5m and 15m trend labels **only when both are explicitly present**. Matching BULL/BULL or BEAR/BEAR is a provisional dashboard PASS; mixed or FLAT trends BLOCK. Current signal-cache rows include the BTC 5m label `btc_trend` but do not persist a separate BTC 15m label, so the dashboard currently fails closed with a reason rather than inferring the missing BTC trend from the selected coin's own 15m trend. The approximation is not EMA50/EMA200 + ATR and must be read as a diagnostic only.

High-volatility-aware position sizing (for example, scaling risk down when volatility rises) remains **future work**. No sizing behavior is changed by these indicator or dashboard utilities.

## Score Distribution and Calibration Target

The offline calibration profile to monitor is:

| Score band (0-100) | Target share |
| --- | ---: |
| 0 to under 40 | 60% |
| 40 to under 70 | 30% |
| 70 to under 85 | 8% |
| 85 to 100 | 2% |

These percentages are an analysis target for the score distribution, not a win-rate claim, expected-return forecast, or live trading rule. Compare observed band percentages and the reported percentage-point deltas with this profile before proposing calibration changes.

### Run the report

```sh
node scripts/score-distribution.mjs path/to/scores.json
```

The input can be an array of numeric scores or signal objects with a `score` field. An object may also wrap the rows in `scores`, `signals`, `rows`, or `data`. Scores outside 0-100 and rows without finite scores are skipped and counted. The report prints count, mean, median, population standard deviation, min/max, band counts and percentages, target deltas, and optional strategy/stage counts as JSON. It reads a local file only and does not connect to Delta, Supabase, the worker, or any order endpoint.

## Safety Boundaries

- Do not modify `worker/strategy.mjs` as part of indicator/dashboard diagnostics.
- Do not change `riskGate()`, `openTrade()`, trading settings, or the PositionLedger system as part of this work.
- `src/risk-governor.js` is a dashboard evidence layer; its PASS/BLOCK labels do not gate live signals.
- Keep production execution signal-only and direct Delta execution disabled unless a separate, explicit authorization changes that safety boundary.
