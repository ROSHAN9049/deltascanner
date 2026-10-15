'use strict';

const express = require('express');
const crypto = require('crypto');

function registerTradetronWebhook(app, deps) {
  if (!app || typeof app.post !== 'function') {
    throw new TypeError('registerTradetronWebhook requires an Express-like app with post()');
  }

  const { db, positionLedger, logger } = deps || {};

  if (!db || typeof db.query !== 'function') {
    throw new TypeError('registerTradetronWebhook requires a database client with query()');
  }
  if (!positionLedger || typeof positionLedger.onWebhook !== 'function') {
    throw new TypeError('registerTradetronWebhook requires positionLedger.onWebhook()');
  }
  if (!logger || typeof logger.info !== 'function') {
    throw new TypeError('registerTradetronWebhook requires a logger with info()');
  }

  /**
   * Raw body is required for HMAC-SHA256 signature verification. Parsing with
   * express.json() would re-serialize and change bytes, invalidating the
   * signature. Keep this parser scoped to this route.
   */
  app.post(
    '/webhook/tradetron',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async function tradetronWebhookHandler(req, res) {
      // Express normalizes incoming header names to lowercase.
      const signatureHeader = req.headers['x-tradetron-signature'];

      let rawBody = '';
      if (req.body !== undefined && req.body !== null) {
        rawBody = Buffer.isBuffer(req.body)
          ? req.body.toString('utf8')
          : typeof req.body === 'string'
            ? req.body
            : '';
      }

      let event;
      try {
        event = JSON.parse(rawBody);
      } catch (parseError) {
        // JSONB rejects malformed JSON. Store an object containing a bounded
        // body preview so the audit row always contains valid JSON.
        await logWebhookEvent(db, {
          event_id: 'unparseable:' + crypto.randomUUID(),
          event_type: 'UNPARSEABLE',
          symbol: null,
          raw_payload: { _rawBodyPreview: rawBody.slice(0, 512) },
          signature_valid: false,
          status: 'FAILED',
          error_message: 'Invalid JSON: ' + parseError.message,
        });

        logger.warn('Webhook body was not valid JSON', {
          error: parseError.message,
          bodyLength: rawBody.length,
        });

        return res.status(400).json({ error: 'Invalid JSON' });
      }

      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        await logWebhookEvent(db, {
          event_id: 'malformed:' + crypto.randomUUID(),
          event_type: 'MALFORMED',
          symbol: null,
          raw_payload: { _received: true, _type: typeof event },
          signature_valid: false,
          status: 'FAILED',
          error_message: 'Parsed body is not a JSON object',
        });

        logger.warn('Webhook body parsed but is not an object', {
          bodyType: typeof event,
        });

        return res.status(400).json({ error: 'Body must be a JSON object' });
      }

      /*
       * JSON syntax parsing above is only for safe request classification and
       * audit logging. No event reaches business logic or the ledger until
       * HMAC verification below succeeds.
       *
       * Keep audit IDs within the database's VARCHAR(64) constraint even when
       * an incoming JSON object has a missing, malformed, or oversized id.
       */
      const auditEventId =
        typeof event.id === 'string' &&
        event.id.length > 0 &&
        event.id.length <= 64
          ? event.id
          : 'malformed:' + crypto.randomUUID();

      let signatureValid;
      try {
        signatureValid = positionLedger.verifySignature(rawBody, signatureHeader);
      } catch (verifyError) {
        // The usual cause is a missing server-side webhook secret. Do not
        // log the signature or secret; only log the verification error.
        logger.error('Signature verification could not run', {
          error: verifyError.message,
          eventId: auditEventId,
          type: event.type,
          symbol: event.symbol,
        });

        await logWebhookEvent(db, {
          event_id: auditEventId,
          event_type: typeof event.type === 'string' ? event.type : 'UNKNOWN',
          symbol: typeof event.symbol === 'string' ? event.symbol : null,
          raw_payload: { _verificationError: verifyError.message },
          signature_valid: false,
          status: 'FAILED',
          error_message: 'Signature verification unavailable: ' + verifyError.message,
        });

        return res.status(500).json({
          error: 'Signature verification unavailable',
        });
      }

      if (!signatureValid) {
        await logWebhookEvent(db, {
          event_id: auditEventId,
          event_type: typeof event.type === 'string' ? event.type : 'UNKNOWN',
          symbol: typeof event.symbol === 'string' ? event.symbol : null,
          raw_payload: event,
          signature_valid: false,
          status: 'SIGNATURE_FAILED',
          error_message: null,
        });

        logger.warn('Webhook signature failed', {
          eventId: auditEventId,
          type: event.type,
          symbol: event.symbol,
        });

        return res.status(401).json({ error: 'Unauthorized' });
      }

      // raw_payload must always be valid JSON because the column is JSONB
      // NOT NULL. This parsed object is valid JSON by construction.
      // ON CONFLICT (event_id) DO NOTHING means retries do not duplicate rows.
      await logWebhookEvent(db, {
        event_id: auditEventId,
        event_type: typeof event.type === 'string' ? event.type : 'UNKNOWN',
        symbol: typeof event.symbol === 'string' ? event.symbol : null,
        raw_payload: event,
        signature_valid: true,
        status: 'RECEIVED',
        error_message: null,
      });

      try {
        const result = await positionLedger.onWebhook(event);

        // Duplicate events are idempotent successes, not failures. Marking
        // them PROCESSED ensures later retries also short-circuit cleanly.
        await db.query(
          `
            UPDATE webhook_events
            SET status = 'PROCESSED',
                processed_at = NOW()
            WHERE event_id = $1
          `,
          [auditEventId]
        );

        logger.info('Webhook processed', {
          eventId: auditEventId,
          type: event.type,
          symbol: event.symbol,
          duplicate: result.duplicate === true,
        });

        return res.status(200).json({
          ok: true,
          duplicate: result.duplicate === true,
        });
      } catch (processError) {
        try {
          await db.query(
            `
              UPDATE webhook_events
              SET status = 'FAILED',
                  error_message = $1,
                  processed_at = NOW()
              WHERE event_id = $2
            `,
            [processError.message, auditEventId]
          );
        } catch (auditUpdateError) {
          logger.error('Failed to update webhook audit status', {
            eventId: auditEventId,
            type: event.type,
            symbol: event.symbol,
            error: auditUpdateError.message,
          });
        }

        logger.error('Webhook processing failed', {
          eventId: auditEventId,
          type: event.type,
          symbol: event.symbol,
          error: processError.message,
        });

        // Return 500 so senders that support retrying 5xx responses can retry.
        // FAILED events remain eligible because onWebhook only short-circuits
        // events recorded in webhook_events with status PROCESSED.
        return res.status(500).json({ error: 'Processing failed' });
      }
    }
  );
}

/**
 * Insert an audit row without duplicating an existing event ID. Invalid JSON
 * request bodies must be wrapped in a JSON object before reaching this helper:
 * PostgreSQL will reject malformed JSON supplied to the JSONB column.
 */
async function logWebhookEvent(db, data) {
  const payloadJson = JSON.stringify(data.raw_payload ?? {});

  await db.query(
    `
      INSERT INTO webhook_events
        (event_id, event_type, symbol, raw_payload, signature_valid, status, error_message)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
      ON CONFLICT (event_id) DO NOTHING
    `,
    [
      data.event_id,
      data.event_type,
      data.symbol ?? null,
      payloadJson,
      data.signature_valid,
      data.status,
      data.error_message ?? null,
    ]
  );
}

registerTradetronWebhook._internal = { logWebhookEvent };

module.exports = registerTradetronWebhook;
