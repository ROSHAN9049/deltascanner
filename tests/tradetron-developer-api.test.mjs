import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTradetronPnlHistoryRows, TradetronDeveloperApi } from '../server/tradetron-developer-api.mjs';

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


test('reads account notifications through the documented read-only endpoint', async () => {
  const requests = [];
  const api = new TradetronDeveloperApi({
    apiKey: 'ttk_test_only',
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return response({ success: true, data: { notifications: [{
        id: 918,
        deployment_id: 999273394,
        type: 'STATUS_CHANGE',
        title: 'Deployment status changed',
        message: 'Live-Tranching to Exited',
        created_at: '2026-10-13T04:21:29Z'
      }] } });
    }
  });
  const listed = await api.listNotifications();
  assert.equal(requests[0].url, 'https://tradetron.tech/api/v1/me/notifications');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer ttk_test_only');
  assert.equal(listed.returnedCount, 1);
  assert.equal(listed.notifications.length, 1);
  assert.equal(listed.notifications[0].notification_id, '918');
  assert.equal(listed.notifications[0].deployment_id, '999273394');
  assert.equal(listed.notifications[0].notification_type, 'STATUS_CHANGE');
  assert.match(listed.notifications[0].description, /Live-Tranching to Exited/);
  assert.equal(listed.notifications[0].event_at, '2026-10-13T04:21:29.000Z');

  const numericTimeApi = new TradetronDeveloperApi({
    apiKey: 'ttk_test_only',
    fetchImpl: async () => response({ success: true, data: { notifications: [{
      id: 919,
      created_at: 1791865289,
      title: 'Status notice',
      secret_token: 'must-not-be-persisted',
      details: { Authorization: 'also-must-not-be-persisted', safe: 'ok' }
    }] } })
  });
  const numericTime = await numericTimeApi.listNotifications();
  assert.equal(numericTime.notifications[0].event_at, '2026-10-12T22:21:29.000Z');
  assert.equal('secret_token' in numericTime.notifications[0].raw, false);
  assert.equal('Authorization' in numericTime.notifications[0].raw.details, false);
  assert.equal(numericTime.notifications[0].raw.details.safe, 'ok');
});

test('notification polling fails closed when response has no known list shape', async () => {
  const api = new TradetronDeveloperApi({
    apiKey: 'ttk_test_only',
    fetchImpl: async () => response({ success: true, data: { unexpected: true } })
  });
  await assert.rejects(api.listNotifications(), /verified notifications array/);
});

test('P&L history uses stable five-minute buckets and never changes unknown P&L to zero', () => {
  const first = buildTradetronPnlHistoryRows([
    { deployment_id: 999273394, deployment_name: 'Signal Bridge', pnl: -30.17, open_positions: 19, total_positions: 21, currency_code: 'USD', status: 'Live-Entered' },
    { deployment_id: 999273395, deployment_name: 'Other deployment', pnl: null, open_positions: 0, total_positions: 0 }
  ], '2026-10-13T04:07:31.000Z');
  const second = buildTradetronPnlHistoryRows([
    { deployment_id: 999273394, deployment_name: 'Signal Bridge', pnl: -28.25, open_positions: 19, total_positions: 21, currency_code: 'USD', status: 'Live-Entered' }
  ], '2026-10-13T04:09:59.000Z');
  assert.equal(first.length, 2);
  assert.equal(first[0].reported_pnl, -30.17);
  assert.equal(first[1].reported_pnl, null);
  assert.equal(first[0].captured_at, '2026-10-13T04:05:00.000Z');
  assert.equal(first[0].snapshot_id, second[0].snapshot_id);
  assert.equal(second[0].reported_pnl, -28.25);
  assert.equal(buildTradetronPnlHistoryRows([{ deployment_id: 'invalid', pnl: 2 }], '2026-10-13T04:07:31.000Z').length, 0);
});
