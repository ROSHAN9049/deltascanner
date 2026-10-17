import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPnlHistoryInsights } from '../src/pnl-history-insights.js';

test('day change uses matching sample from same time yesterday when available', () => {
  const history = [
    { snapshot_id:'old', deployment_id:1, captured_at:'2026-10-16T10:00:00Z', reported_pnl:-20 },
    { snapshot_id:'current', deployment_id:1, captured_at:'2026-10-17T10:05:00Z', reported_pnl:-35 }
  ];
  const rows = buildPnlHistoryInsights(history);
  assert.equal(rows.get('current').dayChange, -15);
  assert.equal(rows.get('current').dayChangeBasis, 'same time yesterday');
  assert.equal(rows.get('current').trend, 'DOWN');
});

test('day change falls back to the previous nonzero P&L sample', () => {
  const history = [
    { snapshot_id:'before', deployment_id:1, captured_at:'2026-10-17T09:00:00Z', reported_pnl:12 },
    { snapshot_id:'zero', deployment_id:1, captured_at:'2026-10-17T09:05:00Z', reported_pnl:0 },
    { snapshot_id:'now', deployment_id:1, captured_at:'2026-10-17T09:10:00Z', reported_pnl:15 }
  ];
  const rows = buildPnlHistoryInsights(history);
  assert.equal(rows.get('now').dayChange, 3);
  assert.equal(rows.get('now').dayChangeBasis, 'previous nonzero sample (fallback)');
  assert.equal(rows.get('now').trend, 'UP');
});

test('trend is flat when current P&L equals the last nonzero sample', () => {
  const rows = buildPnlHistoryInsights([
    { snapshot_id:'one', deployment_id:1, captured_at:'2026-10-17T09:00:00Z', reported_pnl:10 },
    { snapshot_id:'two', deployment_id:1, captured_at:'2026-10-17T09:05:00Z', reported_pnl:10 }
  ]);
  assert.equal(rows.get('two').trend, 'FLAT');
  assert.equal(rows.get('two').trendDelta, 0);
});

test('P&L histories are grouped per deployment and missing values remain unknown', () => {
  const rows = buildPnlHistoryInsights([
    { snapshot_id:'a', deployment_id:1, captured_at:'2026-10-17T09:00:00Z', reported_pnl:null },
    { snapshot_id:'b', deployment_id:2, captured_at:'2026-10-17T09:05:00Z', reported_pnl:50 }
  ]);
  assert.equal(rows.get('a').dayChange, null);
  assert.equal(rows.get('a').trend, 'UNKNOWN');
  assert.equal(rows.get('b').trend, 'UNKNOWN');
});
