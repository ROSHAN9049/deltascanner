import test from 'node:test';
import assert from 'node:assert/strict';
import { TradetronDeveloperApi } from '../server/tradetron-developer-api.mjs';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('uses bearer auth and the documented deployments response envelope', async () => {
  const requests = [];
  const api = new TradetronDeveloperApi({
    apiKey: 'ttk_test_only',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return response({ success: true, data: {
        page: 1, last_page: 1, total: 1,
        deployments: [{
          deployment_id: 12345, name: 'Signal Bridge',
          deployment_type: 'LIVE OFFLINE', status: 'Active', broker: 'Delta Exchange India',
          multiplier: 1, capital: 5000, pnl: 0, open_positions: 0, total_positions: 0,
          currency_code: 'USD', deployed_on: '2026-10-11'
        }]
      }});
    }
  });
  const listed = await api.listDeployments();
  assert.equal(listed.deployments.length, 1);
  assert.equal(listed.deployments[0].deployment_id, 12345);
  assert.equal(requests[0].url, 'https://tradetron.tech/api/v1/me/deployments');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer ttk_test_only');
});

test('preserves returned position keys without guessing their meaning', async () => {
  const api = new TradetronDeveloperApi({
    apiKey: 'ttk_test_only',
    fetchImpl: async url => {
      if (String(url).endsWith('/me/deployments/12345/positions')) {
        return response({ success: true, data: {
          deployment_id: 12345, as_of: '2026-10-12T02:24:31+00:00',
          positions_hidden: false, positions: [{ instrument_symbol: 'BTCUSD', net_quantity: 2, pnl: 1.5 }]
        }});
      }
      return response({ success: true, data: { page: 1, last_page: 1, total: 1, deployments: [{
        deployment_id: 12345, name: 'Signal Bridge', deployment_type: 'LIVE OFFLINE',
        status: 'Active', broker: 'Delta Exchange India', pnl: 0, open_positions: 1,
        total_positions: 1, currency_code: 'USD'
      }]}});
    }
  });
  const snapshot = await api.fetchSnapshot();
  assert.equal(snapshot.status, 'OK');
  assert.equal(snapshot.positionCount, 1);
  assert.equal(snapshot.snapshots[0].positions[0].instrument_symbol, 'BTCUSD');
  assert.equal(snapshot.snapshots[0].positions[0].net_quantity, 2);
});

test('empty positions remain empty and do not become a fake position', async () => {
  const api = new TradetronDeveloperApi({
    apiKey: 'ttk_test_only',
    fetchImpl: async url => String(url).endsWith('/positions')
      ? response({ success: true, data: { deployment_id: 12345, as_of: '2026-10-12T02:24:31+00:00', positions_hidden: false, positions: [] } })
      : response({ success: true, data: { page: 1, last_page: 1, total: 1, deployments: [{ deployment_id: 12345, name: 'Signal Bridge' }] } })
  });
  const snapshot = await api.fetchSnapshot();
  assert.equal(snapshot.status, 'OK');
  assert.equal(snapshot.positionCount, 0);
  assert.deepEqual(snapshot.snapshots[0].positions, []);
  assert.equal(snapshot.snapshots[0].positions_hidden, false);
});

test('invalid credentials return a redacted auth error', async () => {
  const api = new TradetronDeveloperApi({
    apiKey: 'ttk_do_not_expose',
    fetchImpl: async () => response({ success: false }, 401)
  });
  await assert.rejects(api.listDeployments(), error => {
    assert.equal(error.status, 401);
    assert.match(error.message, /authentication or read permission denied/);
    assert.equal(error.message.includes('ttk_do_not_expose'), false);
    return true;
  });
});

test('unsupported position payloads fail closed', async () => {
  const api = new TradetronDeveloperApi({
    apiKey: 'ttk_test_only',
    fetchImpl: async () => response({ success: true, data: { deployment_id: 12345, positions: {} } })
  });
  await assert.rejects(api.deploymentPositions(12345), /verified deployment_id \/ positions_hidden boolean \/ positions\[\] shape/);
});

test('missing positions_hidden flag fails closed instead of implying positions are visible', async () => {
  const api = new TradetronDeveloperApi({
    apiKey: 'ttk_test_only',
    fetchImpl: async () => response({ success: true, data: {
      deployment_id: 12345,
      positions: []
    } })
  });
  await assert.rejects(api.deploymentPositions(12345), /positions_hidden boolean/);
});
