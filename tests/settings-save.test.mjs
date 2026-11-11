import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ENGINE_SECRET = 'settings-test-secret';
process.env.SUPABASE_URL = 'https://supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_settings-test';
process.env.GRID_SYMBOLS = 'PAXGUSD,NVDAXUSD';
process.env.GRID_SYMBOL_POOL = 'PAXGUSD,NVDAXUSD,SPYXUSD,XAUTUSD,SLVONUSD,ADAUSD';
process.env.GRID_MAX_CONCURRENT_SYMBOLS = '2';
process.env.GRID_EXECUTION_ALLOWED = 'false';
process.env.DELTA_ENVIRONMENT = 'SIGNAL_ONLY';
process.env.DELTA_EXECUTION_MODE = 'testnet';

const { default: handler } = await import('../api/engine/toggle.js');

function makeResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; }
  };
}

function fakeFetch({ initialRows, savedRows }) {
  let rows = structuredClone(initialRows);
  return {
    fetch: async (url, options = {}) => {
      const requestUrl = String(url);
      assert.match(requestUrl, /^https:\/\/supabase\.test\/rest\/v1\/(dd_settings|dd_delta_positions|dd_orders|dd_engine_logs)\?/);
      if (requestUrl.includes('/dd_delta_positions?') || requestUrl.includes('/dd_orders?')) {
        return { ok: true, status: 200, text: async () => '[]' };
      }
      if (requestUrl.includes('/dd_engine_logs?')) {
        const row = JSON.parse(options.body || '{}');
        return { ok: true, status: 201, text: async () => JSON.stringify([row]) };
      }
      if (options.method === 'PATCH') {
        const body = JSON.parse(options.body || '{}');
        rows = typeof savedRows === 'function' ? savedRows(rows, body) : structuredClone(savedRows);
        return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
    }
  };
}

test('settings endpoint confirms a persisted server update before returning success', async () => {
  const originalFetch = globalThis.fetch;
  const initial = [{ id: 1, risk_pct: 0.3, momentum_rr: 2, scalping_rr: 2, tp1_pct: 33, max_hold_minutes: 240 }];
  const fake = fakeFetch({
    initialRows: initial,
    savedRows: (rows, patch) => [{ ...rows[0], ...patch }]
  });
  globalThis.fetch = fake.fetch;
  try {
    const res = makeResponse();
    await handler({
      method: 'POST',
      headers: { 'x-engine-secret': 'settings-test-secret' },
      body: {
        riskPct: 1.4, momentumRr: 2.5,
        maxMomentumPositions: 5, maxScalpingPositions: 5,
        maxGridPositions: 2, maxOptionsPositions: 4
      }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.persisted.risk_pct, 1.4);
    assert.equal(res.payload.persisted.momentum_rr, 2.5);
    assert.equal(res.payload.persisted.max_momentum_positions, 5);
    assert.equal(res.payload.persisted.max_scalping_positions, 5);
    assert.equal(res.payload.persisted.max_grid_positions, 2);
    assert.equal(res.payload.persisted.max_options_positions, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('settings endpoint does not report success when the database updates zero rows', async () => {
  const originalFetch = globalThis.fetch;
  const initial = [{ id: 1, risk_pct: 0.3, momentum_rr: 2, scalping_rr: 2, tp1_pct: 33, max_hold_minutes: 240 }];
  const fake = fakeFetch({ initialRows: initial, savedRows: [] });
  globalThis.fetch = fake.fetch;
  try {
    const res = makeResponse();
    await handler({
      method: 'POST',
      headers: { 'x-engine-secret': 'settings-test-secret' },
      body: { riskPct: 1.4 }
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.payload.success, false);
    assert.match(res.payload.error, /was not updated/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('settings endpoint rejects non-integer or out-of-range strategy caps', async () => {
  const originalFetch = globalThis.fetch;
  const initial = [{
    id:1, risk_pct:1, momentum_rr:2.5, scalping_rr:2.5, tp1_pct:33,
    max_hold_minutes:240, max_momentum_positions:5, max_scalping_positions:5,
    max_grid_positions:2, max_options_positions:4
  }];
  const fake = fakeFetch({initialRows:initial,savedRows:rows=>rows});
  globalThis.fetch = fake.fetch;
  try {
    for (const value of [0, 1.5, 21, 'not-a-number']) {
      const res = makeResponse();
      await handler({
        method:'POST',
        headers:{'x-engine-secret':'settings-test-secret'},
        body:{maxMomentumPositions:value}
      },res);
      assert.equal(res.statusCode,400);
      assert.equal(res.payload.success,false);
      assert.match(res.payload.error,/integer from 1 to 20/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('settings endpoint accepts a valid same-origin HttpOnly engine session cookie', async () => {
  const originalFetch = globalThis.fetch;
  const { createEngineSessionCookie } = await import('../server/engine-session.js');
  const initial = [{ id: 1, risk_pct: 0.3, momentum_rr: 2, scalping_rr: 2, tp1_pct: 33, max_hold_minutes: 240 }];
  const fake = fakeFetch({
    initialRows: initial,
    savedRows: (rows, patch) => [{ ...rows[0], ...patch }]
  });
  globalThis.fetch = fake.fetch;
  try {
    const res = makeResponse();
    const cookie = createEngineSessionCookie('settings-test-secret', { production: false }).split(';')[0];
    await handler({
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://scanner.test',
        host: 'scanner.test'
      },
      body: { riskPct: 1.2 }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.persisted.risk_pct, 1.2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test('settings endpoint persists four allowlisted dynamic Grid configs and their independent readiness state', async () => {
  const originalFetch = globalThis.fetch;
  const initial = [{
    id: 1,
    grid_symbol_configs: {
      PAXGUSD: { lowerPrice: 4000, upperPrice: 4200, levelsCount: 10, atr_snapshot_status: 'READY' }
    },
    grid_max_positions: 2,
    max_grid_positions: 2
  }];
  const fake = fakeFetch({
    initialRows: initial,
    savedRows: (rows, patch) => [{ ...rows[0], ...patch }]
  });
  globalThis.fetch = fake.fetch;
  try {
    const res = makeResponse();
    await handler({
      method: 'POST',
      headers: { 'x-engine-secret': 'settings-test-secret' },
      body: {
        gridMaxPositions: 2,
        gridSymbolConfigs: {
          PAXGUSD: {
            lowerPrice: 4000, upperPrice: 4200, levelsCount: 10,
            atr_14d: 20, atr_pct: 0.5, atr_snapshot_status: 'READY',
            multiplier: 2.5, widthPct: 4, paused: false
          },
          NVDAXUSD: {
            lowerPrice: null, upperPrice: null, levelsCount: 10,
            atr_14d: null, atr_pct: null, atr_snapshot_status: 'PENDING', paused: false
          },
          SPYXUSD: {
            lowerPrice: 175, upperPrice: 190, levelsCount: 10,
            atr_14d: 2, atr_pct: 1.1, atr_snapshot_status: 'READY', paused: false
          },
          XAUTUSD: {
            lowerPrice: 3900, upperPrice: 4100, levelsCount: 10,
            atr_14d: 15, atr_pct: 0.4, atr_snapshot_status: 'READY', paused: true
          }
        }
      }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.success, true);
    assert.equal(res.payload.persisted.grid_max_positions, 2);
    assert.deepEqual(
      Object.keys(res.payload.persisted.grid_symbol_configs).sort(),
      ['NVDAXUSD', 'PAXGUSD', 'SPYXUSD', 'XAUTUSD']
    );
    assert.equal(res.payload.persisted.grid_symbol_configs.NVDAXUSD.lowerPrice, null);
    assert.equal(res.payload.persisted.grid_symbol_configs.NVDAXUSD.atr_snapshot_status, 'PENDING');
    assert.equal(res.payload.persisted.grid_symbol_configs.PAXGUSD.atr_snapshot_status, 'READY');
    assert.equal(res.payload.persisted.grid_symbol_configs.XAUTUSD.paused, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
