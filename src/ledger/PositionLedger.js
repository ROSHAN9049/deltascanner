'use strict';

const crypto = require('crypto');

/**
 * PositionLedger maintains a parallel ledger populated by authenticated
 * Tradetron webhook events. It never modifies existing routes, live entry
 * gates, position-cap guards, trading settings, or execution behavior.
 *
 * The supplied database client must expose query(sql, params), as provided
 * by a node-postgres client or pool.
 */
class PositionLedger {
  constructor(db, options = {}) {
    if (!db || typeof db.query !== 'function') {
      throw new TypeError('PositionLedger requires a database client with a query() method');
    }

    this.db = db;
    this.logger = options.logger || console;
    // Missing secrets are allowed in read-only environments. Verification
    // fails explicitly if a signature check is attempted without a secret.
    this.webhookSecret = process.env.TRADETRON_WEBHOOK_SECRET;
  }

  /**
   * Verify an HMAC-SHA256 hex digest against the exact raw request body.
   * Expected signature format: 64 hexadecimal characters, without a prefix.
   */
  verifySignature(rawBody, signatureHeader) {
    if (
      signatureHeader === undefined ||
      signatureHeader === null ||
      signatureHeader === ''
    ) {
      return false;
    }

    if (!this.webhookSecret) {
      throw new Error('TRADETRON_WEBHOOK_SECRET not configured');
    }

    if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) {
      return false;
    }

    const expectedHex = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');

    // Buffer.from(hex) may ignore malformed trailing characters, so validate
    // the complete public signature representation before decoding it.
    if (
      typeof signatureHeader !== 'string' ||
      !/^[0-9a-fA-F]{64}$/.test(signatureHeader)
    ) {
      return false;
    }

    try {
      const expectedBuffer = Buffer.from(expectedHex, 'hex');
      const receivedBuffer = Buffer.from(signatureHeader, 'hex');

      // Use timingSafeEqual rather than === to avoid a content-dependent
      // comparison. Different-length buffers throw and fail closed here.
      return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
    } catch (_error) {
      return false;
    }
  }

  async onWebhook(event) {
    this._validateWebhookStructure(event);

    // Idempotency layer 1: entry/partial-fill event IDs are stored on ledger
    // rows, making duplicate creation events a successful no-op.
    const ledgerEvent = await this.db.query(
      `
        SELECT id
        FROM position_ledger
        WHERE webhook_event_id = $1
        LIMIT 1
      `,
      [event.id]
    );

    if (ledgerEvent.rows.length > 0) {
      this.logger.info('Duplicate webhook ignored', {
        eventId: event.id,
        type: event.type,
        symbol: event.symbol,
      });
      return { success: true, processed: false, duplicate: true };
    }

    // Idempotency layer 2: exit events do not replace the originating entry
    // event ID on position_ledger, so check the audit trail for any event
    // already marked PROCESSED. FAILED/RECEIVED rows remain retryable.
    const processedEvent = await this.db.query(
      `
        SELECT id
        FROM webhook_events
        WHERE event_id = $1
          AND status = 'PROCESSED'
        LIMIT 1
      `,
      [event.id]
    );

    if (processedEvent.rows.length > 0) {
      this.logger.info('Duplicate webhook ignored', {
        eventId: event.id,
        type: event.type,
        symbol: event.symbol,
      });
      return { success: true, processed: false, duplicate: true };
    }

    switch (event.type) {
      case 'ENTRY_FILLED':
        await this.handleEntry(event);
        break;
      case 'EXIT_FILLED':
        await this.handleExit(event);
        break;
      case 'PARTIAL_FILL':
        await this.handlePartial(event);
        break;
      default:
        this.logger.warn('Unknown webhook event type', {
          eventId: event.id,
          type: event.type,
          symbol: event.symbol,
        });
        break;
    }

    await this.recomputeGlobalCount();
    return { success: true, processed: true };
  }

  async handleEntry(event) {
    this._validateRequiredFields(
      event,
      ['orderId', 'id', 'symbol', 'side', 'qty', 'price', 'timestamp'],
      'ENTRY_FILLED'
    );

    if (event.side !== 'LONG' && event.side !== 'SHORT') {
      throw new Error(
        'Invalid side for entry order ' + event.orderId + ': expected LONG or SHORT'
      );
    }

    const result = await this.db.query(
      `
        INSERT INTO position_ledger (
          tradetron_order_id, webhook_event_id, symbol, side, qty,
          entry_price, entry_time, status, fees_usd
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `,
      [
        event.orderId,
        event.id,
        event.symbol,
        event.side,
        event.qty,
        event.price,
        event.timestamp,
        'OPEN',
        event.fees ?? 0,
      ]
    );

    const position = result.rows[0];
    if (!position) {
      throw new Error('Entry insert returned no position for order ' + event.orderId);
    }

    this.logger.info('Position opened', {
      eventId: event.id,
      orderId: event.orderId,
      symbol: event.symbol,
      side: event.side,
      qty: event.qty,
    });

    return position;
  }

  async handleExit(event) {
    this._validateRequiredFields(
      event,
      ['parentOrderId', 'price', 'timestamp'],
      'EXIT_FILLED'
    );

    const result = await this.db.query(
      `
        UPDATE position_ledger
        SET
          status = 'CLOSED',
          exit_price = $2,
          exit_time = $3,
          gross_pnl_usd = $4,
          net_pnl_usd = $5,
          fees_usd = COALESCE(fees_usd, 0) + COALESCE($6::numeric, 0),
          funding_usd = COALESCE($7::numeric, 0),
          updated_at = NOW()
        WHERE tradetron_order_id = $1
          AND status = 'OPEN'
        RETURNING *
      `,
      [
        event.parentOrderId,
        event.price,
        event.timestamp,
        // Nullish coalescing preserves a legitimate P&L value of zero;
        // using "value || null" would incorrectly turn zero into NULL.
        event.grossPnl ?? null,
        event.netPnl ?? null,
        event.fees ?? 0,
        event.funding ?? 0,
      ]
    );

    const position = result.rows[0];
    if (result.rowCount === 0 || !position) {
      this.logger.error('Exit received for unknown or already-closed order', {
        eventId: event.id,
        parentOrderId: event.parentOrderId,
        symbol: event.symbol,
      });
      throw new Error('Exit for unknown/closed order: ' + event.parentOrderId);
    }

    this.logger.info('Position closed', {
      eventId: event.id,
      orderId: position.tradetron_order_id,
      symbol: position.symbol,
      netPnl: position.net_pnl_usd,
    });

    return position;
  }

  async handlePartial(event) {
    this._validateRequiredFields(
      event,
      ['orderId', 'id', 'symbol', 'side', 'qty', 'price', 'timestamp'],
      'PARTIAL_FILL'
    );

    if (event.side !== 'LONG' && event.side !== 'SHORT') {
      throw new Error(
        'Invalid side for partial-fill order ' + event.orderId + ': expected LONG or SHORT'
      );
    }

    const result = await this.db.query(
      `
        INSERT INTO position_ledger (
          tradetron_order_id, webhook_event_id, symbol, side, qty,
          entry_price, entry_time, status, fees_usd
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
      `,
      [
        event.orderId,
        event.id,
        event.symbol,
        event.side,
        event.qty,
        event.price,
        event.timestamp,
        'PARTIAL',
        event.fees ?? 0,
      ]
    );

    const position = result.rows[0];
    if (!position) {
      throw new Error('Partial-fill insert returned no position for order ' + event.orderId);
    }

    this.logger.info('Partial fill recorded', {
      eventId: event.id,
      orderId: event.orderId,
      symbol: event.symbol,
      side: event.side,
      qty: event.qty,
    });

    return position;
  }

  async recomputeGlobalCount() {
    const countResult = await this.db.query(
      `
        SELECT COUNT(*)::int AS cnt
        FROM position_ledger
        WHERE status = 'OPEN'
      `
    );

    const rawCount = countResult.rows[0]?.cnt;
    const count = Number(rawCount);
    if (!Number.isInteger(count) || rawCount === undefined || rawCount === null) {
      throw new Error('Failed to compute global open-position count');
    }

    const value = JSON.stringify({
      count,
      computedAt: new Date().toISOString(),
    });

    await this.db.query(
      `
        INSERT INTO system_meta (key, value, updated_at)
        VALUES ('global_open_positions', $1::jsonb, NOW())
        ON CONFLICT (key)
        DO UPDATE
          SET value = $1::jsonb,
              updated_at = NOW()
      `,
      [value]
    );

    return count;
  }

  async getGlobalCount() {
    // Cache is observability only, not authoritative. Always read a fresh
    // aggregate from PostgreSQL and never use the system_meta cache here.
    const result = await this.db.query(
      `
        SELECT COUNT(*)::int AS cnt
        FROM position_ledger
        WHERE status = 'OPEN'
      `
    );

    const rawCount = result.rows[0]?.cnt;
    const count = Number(rawCount);
    if (!Number.isInteger(count) || rawCount === undefined || rawCount === null) {
      throw new Error('Failed to read global open-position count');
    }

    return count;
  }

  async getOpenPositions() {
    const result = await this.db.query(
      `
        SELECT *
        FROM position_ledger
        WHERE status = 'OPEN'
        ORDER BY entry_time DESC
      `
    );
    return result.rows;
  }

  async getPosition(tradetronOrderId) {
    const result = await this.db.query(
      `
        SELECT *
        FROM position_ledger
        WHERE tradetron_order_id = $1
        LIMIT 1
      `,
      [tradetronOrderId]
    );
    return result.rows[0] || null;
  }

  /**
   * READ-ONLY reconciliation for dashboard observability. It never mutates
   * the ledger, trading settings, or entry gates.
   */
  async reconcileWithSnapshot(apiSnapshot) {
    if (!Array.isArray(apiSnapshot)) {
      throw new TypeError('apiSnapshot must be an array');
    }

    const ledgerPositions = await this.getOpenPositions();
    const ledgerSymbols = new Set(
      ledgerPositions.map((position) => position.symbol + ':' + position.side)
    );
    const snapshotSymbols = new Set(
      apiSnapshot.map((position) => position.symbol + ':' + position.side)
    );

    const onlyInLedger = [...ledgerSymbols].filter(
      (symbolAndSide) => !snapshotSymbols.has(symbolAndSide)
    );
    const onlyInSnapshot = [...snapshotSymbols].filter(
      (symbolAndSide) => !ledgerSymbols.has(symbolAndSide)
    );

    return {
      ledgerCount: ledgerPositions.length,
      snapshotCount: apiSnapshot.length,
      matched: ledgerPositions.length - onlyInLedger.length,
      onlyInLedger,
      onlyInSnapshot,
      isSynced: onlyInLedger.length === 0 && onlyInSnapshot.length === 0,
      checkedAt: new Date().toISOString(),
    };
  }

  _validateWebhookStructure(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error('Invalid webhook event structure');
    }

    const hasCommonFields =
      this._hasValue(event.id) &&
      this._hasValue(event.type) &&
      this._hasValue(event.symbol);
    const hasOrderReference =
      event.type === 'EXIT_FILLED'
        ? this._hasValue(event.parentOrderId)
        : this._hasValue(event.orderId);

    if (!hasCommonFields || !hasOrderReference) {
      throw new Error('Invalid webhook event structure');
    }
  }

  _validateRequiredFields(event, fields, eventType) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error('Invalid ' + eventType + ' event structure');
    }

    const missingFields = fields.filter(
      (field) => !this._hasValue(event[field])
    );
    if (missingFields.length > 0) {
      throw new Error(
        'Invalid ' + eventType + ' event structure: missing ' + missingFields.join(', ')
      );
    }
  }

  _hasValue(value) {
    return value !== undefined && value !== null && value !== '';
  }
}

module.exports = { PositionLedger };
