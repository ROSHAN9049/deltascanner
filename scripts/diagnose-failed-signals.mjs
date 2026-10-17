#!/usr/bin/env node
/**
 * Read-only summary of FAILED/EXPIRED Tradetron signal reservations from the
 * last 24 hours. Uses stored diagnostic fields and legacy engine-log hints.
 * Never changes database state.
 */
import pg from 'pg';

const { Pool } = pg;
const safeError = error => String(error?.message || 'Database query failed')
  .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@')
  .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
  .replace(/((?:api[_ -]?key|access[_ -]?token|secret|password|authorization|credential)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
  .slice(0, 500);

let pool;
let exitCode = 0;
try {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL is required; its value will not be printed.');
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    ssl: { rejectUnauthorized: false }
  });

  const byReason = await pool.query(`
    WITH recent AS (
      SELECT
        o.id,
        o.symbol,
        o.strategy,
        o.state,
        o.created_at,
        o.failure_reason,
        o.failure_detail,
        COALESCE(NULLIF(o.failure_reason, ''), CASE
          WHEN o.state = 'EXPIRED' THEN 'signal_expired'
          WHEN COALESCE(o.raw->>'position_safety_blocked', 'false') = 'true'
            OR COALESCE(l.reason, '') ILIKE '%Global open-position limit reached%'
            OR COALESCE(l.reason, '') ILIKE '%POSITION_CAP_LOOKUP_FAILED%'
            THEN 'position_cap_block'
          WHEN COALESCE(l.reason, '') ILIKE '%route%'
            OR COALESCE(l.reason, '') ILIKE '%symbol%invalid%'
            THEN 'routing_error'
          WHEN COALESCE(l.reason, '') ILIKE '%API%'
            OR COALESCE(l.reason, '') ILIKE '%HTTP%'
            OR COALESCE(l.reason, '') ILIKE '%502%'
            THEN 'api_error'
          ELSE 'unknown'
        END) AS classified_reason
      FROM public.dd_orders o
      LEFT JOIN LATERAL (
        SELECT log.data->>'reason' AS reason
        FROM public.dd_engine_logs log
        WHERE log.data->>'executionId' = COALESCE(o.execution_id, o.client_order_id)
          AND log.created_at >= o.created_at
          AND log.created_at <= o.created_at + INTERVAL '48 hours'
          AND (
            log.message ILIKE '%position-cap safety guard%'
            OR log.message ILIKE '%bridge signal failed%'
            OR log.message ILIKE '%position snapshot is not trusted%'
          )
        ORDER BY
          CASE WHEN log.message ILIKE '%position-cap safety guard%' THEN 0 ELSE 1 END,
          log.created_at ASC
        LIMIT 1
      ) l ON true
      WHERE o.order_type = 'tradetron_signal'
        AND o.state IN ('FAILED', 'EXPIRED')
        AND o.created_at >= NOW() - INTERVAL '24 hours'
    )
    SELECT classified_reason AS reason, state, COUNT(*)::bigint AS rows
    FROM recent GROUP BY classified_reason, state ORDER BY rows DESC, reason
  `);

  const topSymbols = await pool.query(`
    SELECT symbol, COUNT(*)::bigint AS records,
      COUNT(*) FILTER (WHERE state='FAILED')::bigint AS failed,
      COUNT(*) FILTER (WHERE state='EXPIRED')::bigint AS expired,
      COUNT(DISTINCT strategy) AS strategies
    FROM public.dd_orders
    WHERE order_type='tradetron_signal'
      AND state IN ('FAILED','EXPIRED')
      AND created_at >= NOW() - INTERVAL '24 hours'
    GROUP BY symbol ORDER BY records DESC, symbol LIMIT 10
  `);

  const patternRows = await pool.query(`
    SELECT COALESCE(NULLIF(failure_reason,''),'unknown') AS reason,
      COALESCE(NULLIF(failure_detail,''),'(no stored failure detail)') AS detail,
      COUNT(*)::bigint AS rows
    FROM public.dd_orders
    WHERE order_type='tradetron_signal' AND state='FAILED'
      AND created_at >= NOW() - INTERVAL '24 hours'
    GROUP BY 1,2 ORDER BY rows DESC LIMIT 10
  `);

  console.log('TRADETRON FAILED SIGNAL DIAGNOSTIC (read-only, last 24 hours)');
  console.log('Generated: ' + new Date().toISOString());
  console.log('\nBY REASON / STATE\n' + JSON.stringify(byReason.rows, null, 2));
  console.log('\nTOP 10 SYMBOLS\n' + JSON.stringify(topSymbols.rows, null, 2));
  console.log('\nTOP FAILURE PATTERNS\n' + JSON.stringify(patternRows.rows.map(row => ({
    ...row, detail: safeError({ message: row.detail })
  })), null, 2));
} catch (error) {
  console.error('Failed-signal diagnostic failed: ' + safeError(error));
  exitCode = 1;
} finally {
  if (pool) {
    try { await pool.end(); } catch (error) {
      console.error('Failed to close diagnostic database pool: ' + safeError(error));
      exitCode = 1;
    }
  }
}
process.exitCode = exitCode;
