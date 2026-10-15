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

## BTC Regime — Shadow Rollout

### Current data path

- **Live decision source:** unchanged. `worker/strategy.mjs` still receives BTC 5m and 15m candle arrays and applies the existing legacy trend logic. The shadow calculation does not feed `analyse()`, `riskGate()`, or `openTrade()`.
- **Shadow computation:** the engine calls the existing `gateBTCRegime()` helper from `src/indicators/risk-gates.mjs` using BTCUSD 1h candles and the current BTC price. The helper validates history, computes EMA50/EMA200 and ATR14, and classifies BULL_LOW_VOL, BULL_HIGH_VOL, BEAR_LOW_VOL, BEAR_HIGH_VOL, CHOPPY, or NEUTRAL.
- **Cache key:** `1h:BTCUSD`, following the existing `resolution:symbol` convention.
- **Refresh:** 250 BTCUSD 1h candles are fetched immediately after worker startup, then refreshed by a dedicated 60-minute timer. This request is independent of the rotating 1m/5m/15m warmup and does not change its batch.
- **Minimum history:** `gateBTCRegime()` requires at least 201 raw hourly candles so its existing worker indicators can exclude the potentially forming final candle and still calculate EMA200 over 200 closed candles.
- **Persistence:** `dd_signal_cache.details` receives `btcRegime`, `btcRegimeStatus`, `btcRegimeReason`, `btcRegimeSource`, `btcAtrPct`, and `btcRegimeComputedAt`. The existing BTC trend labels are also retained in `details.btcTrend5m` and `details.btcTrend15m` to support offline comparison.
- **Dashboard:** where the existing higher-priority worker blocker does not take precedence, the dashboard can display `BTC regime (live 1h shadow): <REGIME>`. Its reason is prefixed with `(shadow)`. This is read-only diagnostic information and does not make shadow PASS/BLOCK the live entry decision.
- **Comparison tool:** `scripts/btc-regime-compare.mjs` compares legacy 5m/15m directional labels with the equivalent directional class from the live-1h shadow regime. Run it with `npm run btc:regime:compare -- path/to/scores.json`. For a multi-day comparison, combine exports captured on different days; `dd_signal_cache` stores each symbol's latest row, not a historical time series.

### Regime classification

| Condition | Shadow regime |
| --- | --- |
| EMA50 > EMA200 and ATR14 percentage < 2% | `BULL_LOW_VOL` |
| EMA50 > EMA200 and ATR14 percentage >= 2% (and <= 4%) | `BULL_HIGH_VOL` |
| EMA50 < EMA200 and ATR14 percentage < 2% | `BEAR_LOW_VOL` |
| EMA50 < EMA200 and ATR14 percentage >= 2% (and <= 4%) | `BEAR_HIGH_VOL` |
| ATR14 percentage > 4% | `CHOPPY` |
| Otherwise, including effectively equal EMA50/EMA200 | `NEUTRAL` |

The existing `gateBTCRegime()` helper determines whether the diagnostic status is PASS or BLOCK. A BLOCK in the shadow status is an observation, not a change to the current strategy gate.

## Rollout Plan

1. **[CURRENT] Shadow mode:** fetch hourly BTC history, compute the regime, persist it, display it as `(shadow)`, and keep live signals on the existing 5m/15m trends.
2. **[AFTER 7 DAYS] Compare:** run the comparison tool on exports spanning at least seven days and inspect the agreement rate and disagreements. A single current `dd_signal_cache` export is not a seven-day sample.
3. **[MANUAL APPROVAL] Consider switching:** only after the shadow comparison shows **less than 10% disagreement** (more than 90% agreement) over seven days, request a separate manual decision. No automatic source flip is implemented.
4. **[MONITOR] After an approved switch:** monitor signal quality for seven more days and check for regressions.

**Do NOT switch to `live-1h` until shadow comparison shows <10% disagreement over 7 days.** The current implementation does not activate a source-switch flag and leaves the live BTC decision logic unchanged.

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
