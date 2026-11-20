import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const engine = await readFile(new URL('../worker/engine.mjs', import.meta.url), 'utf8');
const ivRank = await readFile(new URL('../worker/options-iv-rank.mjs', import.meta.url), 'utf8');

test('IV history retention preserves the full 30-day rank window and 20-day percentile warmup', () => {
  assert.match(engine, /const IV_HISTORY_RETENTION_DAYS = 30;/);
  assert.match(engine, /IV_HISTORY_RETENTION_DELETE_SQL/);
  assert.match(engine, /pool\.query\(IV_HISTORY_RETENTION_DELETE_SQL, \[IV_HISTORY_RETENTION_DAYS, RETENTION_BATCH_SIZE\]\)/);
  assert.match(ivRank, /export const MIN_IV_PERCENTILE_DAYS = 20;/);
  assert.match(ivRank, /30 \* DAY_MS/);
});

test('IV history cleanup is batched and does not shorten the Options history window', () => {
  assert.match(engine, /FROM public\.dd_iv_history\s+WHERE observed_at < NOW\(\) - \(\$1::int \* INTERVAL '1 day'\)/);
  assert.match(engine, /ORDER BY observed_at ASC\s+LIMIT \$2::int/);
  assert.match(engine, /totalIvHistoryDeleted/);
});
