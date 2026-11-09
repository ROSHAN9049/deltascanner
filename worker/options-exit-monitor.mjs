export const OPTIONS_EXIT_MONITOR_INTERVAL_MS = 60_000;
const enabled = value => String(value ?? '').trim().toLowerCase() === 'true';
export function createOptionsExitMonitor({
  env = process.env, monitor, logger = async () => {},
  setIntervalFn = setInterval, clearIntervalFn = clearInterval
} = {}) {
  if (typeof monitor !== 'function') throw new TypeError('Options exit monitor requires a monitor callback');
  let timer = null, running = false, inFlight = null;
  async function runOnce() {
    if (!enabled(env.OPTIONS_REGIME_STRATEGY_ENABLED) || !enabled(env.OPTIONS_EXIT_MONITOR_ENABLED)) {
      return { status: 'DISABLED', monitored: 0, exits: 0 };
    }
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const result = await monitor();
        await logger('INFO', '[OptionsExitMonitor] 60-second exit scan completed', result);
        return result;
      } catch (error) {
        await logger('ERROR', '[OptionsExitMonitor] Exit scan failed; tracked positions remain open', {
          error: String(error?.message || error).slice(0, 240)
        }).catch(() => {});
        return { status: 'ERROR', error: String(error?.message || error).slice(0, 240) };
      }
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }
  async function start() {
    if (running) return;
    running = true;
    if (enabled(env.OPTIONS_REGIME_STRATEGY_ENABLED) && enabled(env.OPTIONS_EXIT_MONITOR_ENABLED)) {
      timer = setIntervalFn(() => { void runOnce(); }, OPTIONS_EXIT_MONITOR_INTERVAL_MS);
      timer?.unref?.();
      await runOnce();
    }
  }
  async function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null; running = false;
    if (inFlight) await inFlight;
  }
  return Object.freeze({ runOnce, start, stop });
}
